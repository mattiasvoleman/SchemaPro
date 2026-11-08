import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { MealLetterConfig } from '../config/configuration';
import { PrismaService } from '../database/prisma.service';
import { errorName, JobRunner, type JobCounts } from '../jobs/job-runner';
import { NotificationDeliveryService } from '../notifications/notification-delivery.service';
import {
  buildMealView,
  MEAL_LETTER_GRACE_MINUTES,
  MEAL_LETTER_INTERVAL_MS,
  MEAL_LETTER_JOB,
  mealLetter,
  parseMealRows,
  SCHOOLS_PER_TICK,
} from './meal-counts';

const isoDay = (value: Date) => value.toISOString().slice(0, 10);

/** What a pass of one school came to. */
type SchoolOutcome = 'SENT' | 'NOTHING_TO_SAY' | 'NOT_SENT';

/**
 * Måltidskollen's letter (20270123090000), a job of the JobRunner. Off when MEAL_LETTER_BACKGROUND=off (the
 * test setup). With no school having turned the letter on it is one query every two minutes and changes nothing.
 *
 * Each tick:
 *   1. app.meal_letter_schools(now, grace): the schools with the letter on whose cut-off has passed today, by
 *      no more than the grace, and that have a sitting today;
 *   2. JobRunner.claimNightly (hour 0: the database has already asked the school's own hour): those of them
 *      with no letter today, at most five, each claimed by exactly one API instance;
 *   3. per school, one after another, app.meal_letter(school, today) gives the address and the day's counts,
 *      as of the cut-off, and the day's letter goes through the delivery that is already there (sendLetter,
 *      which keeps the mail pace of every other mail);
 *   4. the claim is marked done once the mail was taken. Until then it is open and taken again two hours on,
 *      which is inside the grace, so a crash or a mail Resend refused costs one retry and never a day of them.
 *
 * AS OF THE CUT-OFF. The counts do not depend on the time of the pass (the cut-off is a point on the day's
 * own clock, and an absence is before it when its first report is), so a letter that goes late says what a
 * letter on time would have said, and says what has come in since as "anmäld efter ... och inte avdragen".
 *
 * WHAT IS NOT DONE. A school that has turned the letter off between the first and the second step is not
 * written to, and neither is a day without a sitting: the claim stays open and the next question does not
 * name the school. At-least-once: a process that stops between the mail and the mark sends the letter again
 * two hours on, with the same figures.
 *
 * A school that fails is logged by id and error class and left for the claim to retry; the next school still
 * runs. Logs carry school ids and counts, never an address, a name or a figure of a pupil.
 */
@Injectable()
export class MealLetterJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MealLetterJob.name);
  private running: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly delivery: NotificationDeliveryService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly jobs?: JobRunner,
  ) {}

  onModuleInit(): void {
    if (this.config?.get<MealLetterConfig>('mealLetter')?.background !== true || !this.jobs) return;
    this.jobs.register({ name: MEAL_LETTER_JOB, intervalMs: MEAL_LETTER_INTERVAL_MS, tick: () => this.tick() });
  }

  onModuleDestroy(): void {
    this.jobs?.unregister(MEAL_LETTER_JOB);
  }

  get scheduled(): boolean {
    return this.jobs?.isScheduled(MEAL_LETTER_JOB) ?? false;
  }

  /** One pass; a tick while the last one runs waits for it instead. Never throws. */
  async tick(now?: Date): Promise<void> {
    if (this.running) return this.running;
    const started = new Date();
    this.running = this.pass(now)
      .then((counts) => this.jobs?.settled(MEAL_LETTER_JOB, started, { ok: true, counts }))
      .catch((error: unknown) => {
        this.logger.warn(`Meal letter tick failed [${errorName(error)}]`);
        this.jobs?.settled(MEAL_LETTER_JOB, started, { ok: false, error: errorName(error) });
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async pass(now?: Date): Promise<JobCounts> {
    const at = now ?? new Date();
    const candidates = await this.prisma.withDeliveryService((tx) =>
      tx.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`SELECT id FROM app.meal_letter_schools(${at}::timestamptz, ${MEAL_LETTER_GRACE_MINUTES}::integer) AS id`,
      ),
    );
    const ids = (candidates ?? []).map((row) => row.id);
    if (ids.length === 0 || !this.jobs) return { schools: 0 };
    const claimed = await this.jobs.claimNightly(MEAL_LETTER_JOB, 0, ids, SCHOOLS_PER_TICK, at);
    const total: JobCounts = { schools: claimed.length, failed: 0, letters: 0, unsent: 0 };
    for (const claim of claimed) {
      try {
        const outcome = await this.runSchool(claim.schoolId, claim.localDay);
        if (outcome === 'SENT') {
          total['letters'] = (total['letters'] ?? 0) + 1;
          await this.jobs.finishNightly(MEAL_LETTER_JOB, claim.schoolId, claim.localDay, new Date());
        } else {
          total['unsent'] = (total['unsent'] ?? 0) + 1;
        }
      } catch (error) {
        total['failed'] = (total['failed'] ?? 0) + 1;
        this.logger.warn(`Meal letter failed [school=${claim.schoolId}, ${errorName(error)}]`);
      }
    }
    return total;
  }

  /**
   * One school's letter for `localDay` (a DATE read as UTC midnight): the day the claim was made on, in the
   * school's own dates. Throws on a database failure; the claim is then retried.
   */
  async runSchool(schoolId: string, localDay: Date): Promise<SchoolOutcome> {
    const day = isoDay(localDay);
    const [row] =
      (await this.prisma.withDeliveryService((tx) =>
        tx.$queryRaw<Array<{ doc: unknown }>>(Prisma.sql`SELECT app.meal_letter(${schoolId}::uuid, ${day}::date) AS doc`),
      )) ?? [];
    const doc = (typeof row?.doc === 'string' ? (JSON.parse(row.doc) as unknown) : row?.doc) as
      | { school?: unknown; email?: unknown }
      | null
      | undefined;
    // The school turned the letter off after the question that named it.
    if (!doc || typeof doc.school !== 'string' || typeof doc.email !== 'string') return 'NOTHING_TO_SAY';
    const rows = parseMealRows(doc);
    const [view] = buildMealView(rows, day, day).days;
    if (!view || view.sittings.length === 0 || rows.cutoff === null) return 'NOTHING_TO_SAY';
    const letter = mealLetter(view, doc.school, rows.cutoff, rows.staffModelled);
    if (!(await this.delivery.sendLetter(doc.email, letter.subject, letter.body))) {
      this.logger.warn(`Meal letter not sent [school=${schoolId}]`);
      return 'NOT_SENT';
    }
    this.logger.log(`Meal letter [school=${schoolId}, sittings=${view.sittings.length}, portions=${view.totals.portions}]`);
    return 'SENT';
  }
}
