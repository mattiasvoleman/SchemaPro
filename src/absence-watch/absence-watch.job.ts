import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type AbsenceWatchGroup } from '@prisma/client';
import type { AbsenceWatchConfig } from '../config/configuration';
import { PrismaService } from '../database/prisma.service';
import { errorName, JobRunner, type JobCounts } from '../jobs/job-runner';
import { NotificationsService } from '../notifications/notifications.service';
import { digestEntries, type DigestRow } from './absence-watch-notices';
import { ABSENCE_WATCH_HOUR_LOCAL, ABSENCE_WATCH_INTERVAL_MS, ABSENCE_WATCH_JOB, SCHOOLS_PER_TICK } from './absence-watch';

/** The database's rows. */
interface Evaluated {
  opened: number;
  kept: number;
  closed: number;
  pupils: number;
}
interface DueDigest {
  recipient_group: AbsenceWatchGroup;
  period_start: Date;
  period_end: Date;
}
const isoDay = (value: Date) => value.toISOString().slice(0, 10);

/**
 * Frånvarobevakning's nightly job (20261231090100), a job of the JobRunner.
 * Off when ABSENCE_WATCH_BACKGROUND=off (the test setup). With no school
 * having turned the bevakning on it is one query every five minutes and
 * changes nothing.
 *
 * Each tick:
 *   1. app.absence_watch_schools(): the schools with the switch on;
 *   2. JobRunner.claimNightly: those of them past 05:00 local time with no
 *      run tonight, at most five, each claimed by exactly one API instance;
 *   3. per school, one after another:
 *      - app.absence_watch_evaluate(school, yesterday) opens, keeps and
 *        closes the findings of the school's limits, as of the last day that
 *        is over, in the school's own dates;
 *      - app.absence_watch_digest_due(school, today): the groups whose last
 *        whole week or month has no digest yet. For each, app.absence_watch_digest
 *        writes the digest once per period: a row in the read log for each
 *        recipient with something to hear and their notice, in one transaction,
 *        and the e-mail and the push go after the commit through the delivery
 *        that is already there;
 *      - the claim is marked done.
 *
 * THE READ LOG, IN THE JOB. A digest hands each recipient a count of the
 * pupils they would see in the view, so it is recorded as a read of those
 * pupils' attendance for the recipient (ATTENDANCE, channel OTHER). The job
 * cannot do it with recordRead: app.personal_data_read takes its reader from
 * the transaction's claims and refuses a transaction with none, and no function
 * may hand the job a recipient's login to take them (section 10). So the one
 * function that writes the notices writes the log, from the same plan, before
 * them and in the same transaction: a log that cannot be written takes the
 * notices with it, and the claim is retried.
 *
 * A school that fails is logged by id and error class and left for the claim
 * to retry (two hours later, the same day); the next school still runs. Logs
 * carry school ids and counts, never a name.
 */
@Injectable()
export class AbsenceWatchJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AbsenceWatchJob.name);
  private running: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly jobs?: JobRunner,
  ) {}

  onModuleInit(): void {
    if (this.config?.get<AbsenceWatchConfig>('absenceWatch')?.background !== true || !this.jobs) return;
    this.jobs.register({ name: ABSENCE_WATCH_JOB, intervalMs: ABSENCE_WATCH_INTERVAL_MS, tick: () => this.tick() });
  }

  onModuleDestroy(): void {
    this.jobs?.unregister(ABSENCE_WATCH_JOB);
  }

  get scheduled(): boolean {
    return this.jobs?.isScheduled(ABSENCE_WATCH_JOB) ?? false;
  }

  /** One pass; a tick while the last one runs waits for it instead. Never throws. */
  async tick(now?: Date): Promise<void> {
    if (this.running) return this.running;
    const started = new Date();
    this.running = this.pass(now)
      .then((counts) => this.jobs?.settled(ABSENCE_WATCH_JOB, started, { ok: true, counts }))
      .catch((error: unknown) => {
        this.logger.warn(`Absence watch tick failed [${errorName(error)}]`);
        this.jobs?.settled(ABSENCE_WATCH_JOB, started, { ok: false, error: errorName(error) });
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async pass(now?: Date): Promise<JobCounts> {
    const at = now ?? new Date();
    const candidates = await this.prisma.withDeliveryService((tx) =>
      tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT id FROM app.absence_watch_schools() AS id`),
    );
    const ids = (candidates ?? []).map((row) => row.id);
    if (ids.length === 0 || !this.jobs) return { schools: 0 };
    const claimed = await this.jobs.claimNightly(ABSENCE_WATCH_JOB, ABSENCE_WATCH_HOUR_LOCAL, ids, SCHOOLS_PER_TICK, at);
    const total: JobCounts = { schools: claimed.length, failed: 0, pupils: 0, opened: 0, closed: 0, digests: 0, notices: 0 };
    for (const claim of claimed) {
      try {
        const counts = await this.runSchool(claim.schoolId, claim.localDay);
        for (const key of ['pupils', 'opened', 'closed', 'digests', 'notices'] as const) total[key] = (total[key] ?? 0) + counts[key]!;
        await this.jobs.finishNightly(ABSENCE_WATCH_JOB, claim.schoolId, claim.localDay, new Date());
      } catch (error) {
        total['failed'] = (total['failed'] ?? 0) + 1;
        this.logger.warn(`Absence watch failed [school=${claim.schoolId}, ${errorName(error)}]`);
      }
    }
    return total;
  }

  /**
   * One school's night, for `localDay` (a DATE read as UTC midnight): the day
   * the claim was made on, in the school's own dates. Throws on a database
   * failure or a read that could not be recorded; the claim is then retried.
   */
  async runSchool(schoolId: string, localDay: Date): Promise<Required<Pick<JobCounts, 'pupils' | 'opened' | 'closed' | 'digests' | 'notices'>>> {
    const today = isoDay(localDay);
    const yesterday = isoDay(new Date(localDay.getTime() - 86_400_000));
    const [evaluated] = await this.prisma.withDeliveryService(async (tx) => {
      // The delivery's door gives a statement 5 s; the count reads a school's last
      // three months of marks (1.5 s for 500 pupils, measured), so it asks for the
      // most the door's 10 s transaction leaves.
      await tx.$executeRaw`SET LOCAL statement_timeout = '9s'`;
      return tx.$queryRaw<Evaluated[]>(
        Prisma.sql`SELECT opened, kept, closed, pupils FROM app.absence_watch_evaluate(${schoolId}::uuid, ${yesterday}::date)`,
      );
    });
    const counts = { pupils: evaluated?.pupils ?? 0, opened: evaluated?.opened ?? 0, closed: evaluated?.closed ?? 0, digests: 0, notices: 0 };

    const due = await this.prisma.withDeliveryService((tx) =>
      tx.$queryRaw<DueDigest[]>(
        Prisma.sql`SELECT recipient_group, period_start, period_end FROM app.absence_watch_digest_due(${schoolId}::uuid, ${today}::date)`,
      ),
    );
    for (const digest of due ?? []) {
      counts.notices += await this.sendDigest(schoolId, digest.recipient_group, isoDay(digest.period_start), isoDay(digest.period_end), today);
      counts.digests += 1;
    }
    if (counts.opened + counts.closed + counts.digests > 0) {
      this.logger.log(
        `Absence watch [school=${schoolId}, opened=${counts.opened}, closed=${counts.closed}, digests=${counts.digests}, notices=${counts.notices}]`,
      );
    }
    return counts;
  }

  /** Writes the group's digest, with its read-log rows, and hands the notices to the delivery. Answers how many were written. */
  private async sendDigest(schoolId: string, group: AbsenceWatchGroup, start: string, end: string, today: string): Promise<number> {
    const written = await this.prisma.withDeliveryService((tx) =>
      tx.$queryRaw<DigestRow[]>(
        Prisma.sql`SELECT notification_id, user_id, email, meta
                     FROM app.absence_watch_digest(${schoolId}::uuid, ${group}::"AbsenceWatchGroup", ${start}::date, ${end}::date, ${today}::date)`,
      ),
    );
    // After the commit that wrote them: a rolled-back digest tells nobody.
    this.notifications.deliverCommitted(digestEntries(schoolId, written ?? []));
    return (written ?? []).length;
  }
}
