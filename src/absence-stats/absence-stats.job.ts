import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { AbsenceStatsConfig } from '../config/configuration';
import { PrismaService } from '../database/prisma.service';
import { errorName, JobRunner, type JobCounts } from '../jobs/job-runner';
import {
  ABSENCE_STATS_HOUR_LOCAL,
  ABSENCE_STATS_INTERVAL_MS,
  ABSENCE_STATS_JOB,
  BACKFILL_MONTHS,
  SCHOOLS_PER_TICK,
} from './absence-stats';

interface Counted {
  written: number;
  removed: number;
  classes: number;
}
type SchoolCounts = Required<Pick<JobCounts, 'months' | 'written' | 'removed' | 'trimmed' | 'failedMonths'>>;
const COUNTED = ['months', 'written', 'removed', 'trimmed', 'failedMonths'] as const;
const isoDay = (value: Date) => value.toISOString().slice(0, 10);
const isoMonth = (value: Date | string) => (typeof value === 'string' ? value : value.toISOString()).slice(0, 10);

/**
 * Frånvarostatistik's nightly job (20270121090000), a job of the JobRunner.
 * Off when ABSENCE_STATS_BACKGROUND=off (the test setup). It has work for
 * every school with a lesson in the last 90 days (the schools Rapporteringsgrad
 * counts too): the months' sums are what the school's and the classes' trends
 * read, and no school can turn them off, since they hold no pupil.
 *
 * Each tick:
 *   1. app.reporting_schools(): the schools with a lesson in the last 90 days;
 *   2. JobRunner.claimNightly: those of them past 07:00 local time with no run
 *      tonight, at most five, each claimed by exactly one API instance;
 *   3. per school, one after another:
 *      - app.absence_stats_plan(school, yesterday): the months to count, in
 *        the school's own dates: those of the last 62 days (a register can be
 *        saved days after its lesson), and up to three older ones that have no
 *        row yet, newest first, so that a school's three läsår fill in over a
 *        week; only months whose marks can still be there (the plan leaves out
 *        a month before the shortest period the school has ever chosen to
 *        purge attendance after);
 *      - app.absence_stats_month(school, month, yesterday) for each of them,
 *        each in a transaction of its own that asks for the most the delivery's
 *        door allows. A month that fails is logged and the others run; the
 *        night is then left to the claim to retry, two hours later;
 *      - app.absence_stats_trim: the months before the three läsår are
 *        removed;
 *      - the claim is marked done.
 *
 * The night is safe to run again: a month is rewritten only where a figure
 * changed. Logs carry school ids, months and counts, never a name.
 */
@Injectable()
export class AbsenceStatsJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AbsenceStatsJob.name);
  private running: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly jobs?: JobRunner,
  ) {}

  onModuleInit(): void {
    if (this.config?.get<AbsenceStatsConfig>('absenceStats')?.background !== true || !this.jobs) return;
    this.jobs.register({ name: ABSENCE_STATS_JOB, intervalMs: ABSENCE_STATS_INTERVAL_MS, tick: () => this.tick() });
  }

  onModuleDestroy(): void {
    this.jobs?.unregister(ABSENCE_STATS_JOB);
  }

  get scheduled(): boolean {
    return this.jobs?.isScheduled(ABSENCE_STATS_JOB) ?? false;
  }

  /** One pass; a tick while the last one runs waits for it instead. Never throws. */
  async tick(now?: Date): Promise<void> {
    if (this.running) return this.running;
    const started = new Date();
    this.running = this.pass(now)
      .then((counts) => this.jobs?.settled(ABSENCE_STATS_JOB, started, { ok: true, counts }))
      .catch((error: unknown) => {
        this.logger.warn(`Absence stats tick failed [${errorName(error)}]`);
        this.jobs?.settled(ABSENCE_STATS_JOB, started, { ok: false, error: errorName(error) });
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async pass(now?: Date): Promise<JobCounts> {
    const at = now ?? new Date();
    const candidates = await this.prisma.withDeliveryService((tx) =>
      tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT id FROM app.reporting_schools() AS id`),
    );
    const ids = (candidates ?? []).map((row) => row.id);
    if (ids.length === 0 || !this.jobs) return { schools: 0 };
    const claimed = await this.jobs.claimNightly(ABSENCE_STATS_JOB, ABSENCE_STATS_HOUR_LOCAL, ids, SCHOOLS_PER_TICK, at);
    const total: JobCounts = { schools: claimed.length, failed: 0, months: 0, written: 0, removed: 0, trimmed: 0, failedMonths: 0 };
    for (const claim of claimed) {
      try {
        const counts = await this.runSchool(claim.schoolId, claim.localDay);
        for (const key of COUNTED) total[key] = (total[key] ?? 0) + counts[key];
        if (counts.failedMonths > 0) {
          // Left for the claim to retry: the months that did run are done, and the ones that failed are asked again.
          total['failed'] = (total['failed'] ?? 0) + 1;
          continue;
        }
        await this.jobs.finishNightly(ABSENCE_STATS_JOB, claim.schoolId, claim.localDay, new Date());
      } catch (error) {
        total['failed'] = (total['failed'] ?? 0) + 1;
        this.logger.warn(`Absence stats failed [school=${claim.schoolId}, ${errorName(error)}]`);
      }
    }
    return total;
  }

  /**
   * One school's night, for `localDay` (a DATE read as UTC midnight): the day
   * the claim was made on, in the school's own dates. A failing database call
   * for the plan or the trim throws, and the claim is then retried; a month
   * that fails is counted in failedMonths and the rest of the school runs.
   */
  async runSchool(schoolId: string, localDay: Date): Promise<SchoolCounts> {
    const yesterday = isoDay(new Date(localDay.getTime() - 86_400_000));
    const planned = await this.prisma.withDeliveryService((tx) =>
      tx.$queryRaw<Array<{ month: Date | string }>>(
        Prisma.sql`SELECT month::text AS month FROM app.absence_stats_plan(${schoolId}::uuid, ${yesterday}::date, ${BACKFILL_MONTHS}::integer)`,
      ),
    );
    const counts: SchoolCounts = { months: 0, written: 0, removed: 0, trimmed: 0, failedMonths: 0 };
    for (const row of planned ?? []) {
      const month = isoMonth(row.month);
      try {
        const done = await this.prisma.withDeliveryService(async (tx) => {
          // The delivery's door gives a statement 5 s; a month of a large school's marks
          // asks for the most the door's 10 s transaction leaves.
          await tx.$executeRaw`SET LOCAL statement_timeout = '9s'`;
          return tx.$queryRaw<Counted[]>(
            Prisma.sql`SELECT written, removed, classes FROM app.absence_stats_month(${schoolId}::uuid, ${month}::date, ${yesterday}::date)`,
          );
        });
        counts.months += 1;
        counts.written += done?.[0]?.written ?? 0;
        counts.removed += done?.[0]?.removed ?? 0;
      } catch (error) {
        counts.failedMonths += 1;
        this.logger.warn(`Absence stats month failed [school=${schoolId}, month=${month}, ${errorName(error)}]`);
      }
    }
    const trimmed = await this.prisma.withDeliveryService((tx) =>
      tx.$queryRaw<Array<{ trimmed: number }>>(Prisma.sql`SELECT app.absence_stats_trim(${schoolId}::uuid, ${yesterday}::date) AS trimmed`),
    );
    counts.trimmed = trimmed?.[0]?.trimmed ?? 0;
    if (counts.written + counts.removed + counts.trimmed + counts.failedMonths > 0) {
      this.logger.log(
        `Absence stats [school=${schoolId}, months=${counts.months}, written=${counts.written}, removed=${counts.removed}, trimmed=${counts.trimmed}, failedMonths=${counts.failedMonths}]`,
      );
    }
    return counts;
  }
}
