import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { ReportingRateConfig } from '../config/configuration';
import { PrismaService } from '../database/prisma.service';
import { errorName, JobRunner, type JobCounts } from '../jobs/job-runner';
import type { OutboxEntry } from '../notifications/notification-outbox';
import { NotificationsService } from '../notifications/notifications.service';
import { digestEntries, reminderEntries, type NoticeRow } from './reporting-rate-notices';
import { REPORTING_RATE_HOUR_LOCAL, REPORTING_RATE_INTERVAL_MS, REPORTING_RATE_JOB, SCHOOLS_PER_TICK } from './reporting-rate';

/** The database's rows. */
interface Computed {
  written: number;
  removed: number;
  teachers: number;
  held: number;
  reported: number;
}
interface DueWeek {
  period_start: Date;
  period_end: Date;
}
type SchoolCounts = Required<Pick<JobCounts, 'written' | 'removed' | 'held' | 'reported' | 'reminders' | 'digests' | 'notices'>>;
const COUNTED = ['written', 'removed', 'held', 'reported', 'reminders', 'digests', 'notices'] as const;
const isoDay = (value: Date) => value.toISOString().slice(0, 10);

/**
 * Rapporteringsgrad's nightly job (20270108090100), a job of the JobRunner.
 * Off when REPORTING_RATE_BACKGROUND=off (the test setup). Unlike
 * Frånvarobevakning's it has work for every school with a lesson in the last
 * 90 days: the count is the figures the view reads. Only the reminders and the
 * weekly notice are switches, and the database answers nothing for a school
 * that has not turned them on.
 *
 * Each tick:
 *   1. app.reporting_schools(): the schools with a lesson in the last 90 days;
 *   2. JobRunner.claimNightly: those of them past 06:00 local time with no run
 *      tonight, at most ten, each claimed by exactly one API instance;
 *   3. per school, one after another:
 *      - app.reporting_compute(school, yesterday) stores each teacher's held
 *        and reported lessons for the last 90 days up to the last day that is
 *        over, in the school's own dates;
 *      - app.reporting_remind(school, today) tells each teacher of the lessons
 *        that have stood open longer than the school's limit, once per lesson:
 *        the ledger and the notices are written in one statement, and the
 *        e-mail and the push go after the commit through the delivery that is
 *        already there. Nothing on a Saturday or a Sunday, and nothing with
 *        the switch off;
 *      - app.reporting_digest_due(school, today): the week that is due, if the
 *        school has the weekly notice on and it has none yet (Monday's, or the
 *        next night's for a week the job missed). app.reporting_digest writes
 *        it once, to each rektor and full administrator, and its notices go
 *        after the commit the same way;
 *      - the claim is marked done.
 *
 * A notice is handed to the delivery after the commit that wrote it, never
 * before: a rolled-back write tells nobody. Nothing is handed over when the
 * database answered nothing.
 *
 * A school that fails is logged by id and error class and left for the claim
 * to retry (two hours later, the same day); the next school still runs. The
 * night is safe to run again: the count rewrites only what changed, a lesson is
 * reminded of once, a week's notice is written once. Logs carry school ids and
 * counts, never a name.
 */
@Injectable()
export class ReportingRateJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReportingRateJob.name);
  private running: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly jobs?: JobRunner,
  ) {}

  onModuleInit(): void {
    if (this.config?.get<ReportingRateConfig>('reportingRate')?.background !== true || !this.jobs) return;
    this.jobs.register({ name: REPORTING_RATE_JOB, intervalMs: REPORTING_RATE_INTERVAL_MS, tick: () => this.tick() });
  }

  onModuleDestroy(): void {
    this.jobs?.unregister(REPORTING_RATE_JOB);
  }

  get scheduled(): boolean {
    return this.jobs?.isScheduled(REPORTING_RATE_JOB) ?? false;
  }

  /** One pass; a tick while the last one runs waits for it instead. Never throws. */
  async tick(now?: Date): Promise<void> {
    if (this.running) return this.running;
    const started = new Date();
    this.running = this.pass(now)
      .then((counts) => this.jobs?.settled(REPORTING_RATE_JOB, started, { ok: true, counts }))
      .catch((error: unknown) => {
        this.logger.warn(`Reporting rate tick failed [${errorName(error)}]`);
        this.jobs?.settled(REPORTING_RATE_JOB, started, { ok: false, error: errorName(error) });
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
    const claimed = await this.jobs.claimNightly(REPORTING_RATE_JOB, REPORTING_RATE_HOUR_LOCAL, ids, SCHOOLS_PER_TICK, at);
    const total: JobCounts = { schools: claimed.length, failed: 0, written: 0, removed: 0, held: 0, reported: 0, reminders: 0, digests: 0, notices: 0 };
    for (const claim of claimed) {
      try {
        const counts = await this.runSchool(claim.schoolId, claim.localDay);
        for (const key of COUNTED) total[key] = (total[key] ?? 0) + counts[key];
        await this.jobs.finishNightly(REPORTING_RATE_JOB, claim.schoolId, claim.localDay, new Date());
      } catch (error) {
        total['failed'] = (total['failed'] ?? 0) + 1;
        this.logger.warn(`Reporting rate failed [school=${claim.schoolId}, ${errorName(error)}]`);
      }
    }
    return total;
  }

  /**
   * One school's night, for `localDay` (a DATE read as UTC midnight): the day
   * the claim was made on, in the school's own dates. Throws on a database
   * failure; the claim is then retried.
   */
  async runSchool(schoolId: string, localDay: Date): Promise<SchoolCounts> {
    const today = isoDay(localDay);
    const yesterday = isoDay(new Date(localDay.getTime() - 86_400_000));
    const computed = await this.prisma.withDeliveryService(async (tx) => {
      // The delivery's door gives a statement 5 s; the count reads a school's last
      // 90 days of lessons and marks, so it asks for the most the door's 10 s
      // transaction leaves.
      await tx.$executeRaw`SET LOCAL statement_timeout = '9s'`;
      return tx.$queryRaw<Computed[]>(
        Prisma.sql`SELECT written, removed, teachers, held, reported FROM app.reporting_compute(${schoolId}::uuid, ${yesterday}::date)`,
      );
    });
    const counted = computed?.[0];
    const counts: SchoolCounts = {
      written: counted?.written ?? 0,
      removed: counted?.removed ?? 0,
      held: counted?.held ?? 0,
      reported: counted?.reported ?? 0,
      reminders: 0,
      digests: 0,
      notices: 0,
    };

    const reminded = await this.prisma.withDeliveryService((tx) =>
      tx.$queryRaw<NoticeRow[]>(
        Prisma.sql`SELECT notification_id, user_id, email, meta FROM app.reporting_remind(${schoolId}::uuid, ${today}::date)`,
      ),
    );
    this.deliver(reminderEntries(schoolId, reminded ?? []));
    counts.reminders = (reminded ?? []).length;

    const due = await this.prisma.withDeliveryService((tx) =>
      tx.$queryRaw<DueWeek[]>(
        Prisma.sql`SELECT period_start, period_end FROM app.reporting_digest_due(${schoolId}::uuid, ${today}::date)`,
      ),
    );
    for (const week of due ?? []) {
      counts.notices += await this.sendDigest(schoolId, isoDay(week.period_start), isoDay(week.period_end));
      counts.digests += 1;
    }
    if (counts.written + counts.removed + counts.reminders + counts.digests > 0) {
      this.logger.log(
        `Reporting rate [school=${schoolId}, written=${counts.written}, removed=${counts.removed}, held=${counts.held}, reported=${counts.reported}, reminders=${counts.reminders}, digests=${counts.digests}, notices=${counts.notices}]`,
      );
    }
    return counts;
  }

  /** Writes the week's notice once and hands it to the delivery. Answers how many notices were written. */
  private async sendDigest(schoolId: string, start: string, end: string): Promise<number> {
    const written = await this.prisma.withDeliveryService((tx) =>
      tx.$queryRaw<NoticeRow[]>(
        Prisma.sql`SELECT notification_id, user_id, email, meta FROM app.reporting_digest(${schoolId}::uuid, ${start}::date, ${end}::date)`,
      ),
    );
    this.deliver(digestEntries(schoolId, written ?? []));
    return (written ?? []).length;
  }

  /** After the commit that wrote them: a rolled-back notice tells nobody. Nothing to hand over is not handed over. */
  private deliver(entries: OutboxEntry[]): void {
    if (entries.length > 0) this.notifications.deliverCommitted(entries);
  }
}
