import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { GallringConfig } from '../config/configuration';
import { PrismaService } from '../database/prisma.service';
import { errorName, JobRunner, type JobCounts } from '../jobs/job-runner';
import { SupabaseAdminService } from '../users/supabase-admin.service';
import { GALLRING_HOUR_LOCAL, ROW_KINDS, type RetentionDataTypeValue } from './retention';

/** The job's name in the runner, in JobRuns and in JobClaims. */
export const GALLRING_JOB = 'gallring';
/** The tick: whether a school's night is due is the claim's question, asked every five minutes. */
export const GALLRING_INTERVAL_MS = 5 * 60 * 1000;
/** Schools claimed per tick, run one after another; the next tick takes the next five. */
export const SCHOOLS_PER_TICK = 5;
/** Rows per app.gallring_purge call, each its own short transaction. */
export const PURGE_BATCH = 2000;
/** Rows per kind per school per night. A first period over years of data is spread over nights. */
export const NIGHTLY_ROW_CAP = 100_000;
/** People pseudonymised per school per night: each invited one costs a call to the auth provider. */
export const NIGHTLY_PEOPLE_CAP = 200;

interface DuePerson {
  user_id: string;
  auth_id: string;
  invited: boolean;
}

/**
 * The nightly gallring (20261021110000), a job of the JobRunner. Off when
 * GALLRING_BACKGROUND=off (the test setup). With no school having recorded a
 * period it is one query every five minutes and removes nothing.
 *
 * Each tick:
 *   1. app.gallring_schools(): the schools whose current decision for some
 *      kind is PURGE_AFTER;
 *   2. JobRunner.claimNightly: those of them past 03:00 local time with no
 *      run tonight, at most five, each claimed by exactly one API instance;
 *   3. per school, one after another:
 *      - app.gallring_begin opens the run with the periods in force (a
 *        decision that gallrar more waits 24 hours) and their cutoffs;
 *      - each row kind in batches of 2 000, each batch its own transaction
 *        counted on the run, until fewer than a batch remain or 100 000 went;
 *      - departed people: the login of each invited one is deleted at the
 *        auth provider first; whoever's login could not be deleted waits for
 *        the next night and is counted as waiting; the rest are
 *        pseudonymised (app.gallring_pseudonymise asks again who is due);
 *      - app.gallring_finish closes the run, and the claim is marked done.
 *
 * A school that fails is logged by id and error class and left for the claim
 * to retry (two hours later, the same day); the next school still runs.
 * Logs carry school ids and counts, never a name.
 */
@Injectable()
export class GallringJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GallringJob.name);
  private running: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly supabaseAdmin: SupabaseAdminService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly jobs?: JobRunner,
  ) {}

  onModuleInit(): void {
    if (this.config?.get<GallringConfig>('gallring')?.background !== true || !this.jobs) return;
    this.jobs.register({ name: GALLRING_JOB, intervalMs: GALLRING_INTERVAL_MS, tick: () => this.tick() });
  }

  onModuleDestroy(): void {
    this.jobs?.unregister(GALLRING_JOB);
  }

  get scheduled(): boolean {
    return this.jobs?.isScheduled(GALLRING_JOB) ?? false;
  }

  /** One pass; a tick while the last one runs waits for it instead. Never throws. */
  async tick(now?: Date): Promise<void> {
    if (this.running) return this.running;
    const started = new Date();
    this.running = this.pass(now)
      .then((counts) => this.jobs?.settled(GALLRING_JOB, started, { ok: true, counts }))
      .catch((error: unknown) => {
        this.logger.warn(`Gallring tick failed [${errorName(error)}]`);
        this.jobs?.settled(GALLRING_JOB, started, { ok: false, error: errorName(error) });
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async pass(now?: Date): Promise<JobCounts> {
    const at = now ?? new Date();
    const candidates = await this.prisma.withDeliveryService((tx) =>
      tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT id FROM app.gallring_schools() AS id`),
    );
    const ids = (candidates ?? []).map((row) => row.id);
    if (ids.length === 0 || !this.jobs) return { schools: 0 };
    const claimed = await this.jobs.claimNightly(GALLRING_JOB, GALLRING_HOUR_LOCAL, ids, SCHOOLS_PER_TICK, at);
    const total: JobCounts = { schools: claimed.length, failed: 0, rows: 0, people: 0 };
    for (const claim of claimed) {
      try {
        const counts = await this.runSchool(claim.schoolId);
        total['rows'] = (total['rows'] ?? 0) + counts.rows;
        total['people'] = (total['people'] ?? 0) + counts.people;
        await this.jobs.finishNightly(GALLRING_JOB, claim.schoolId, claim.localDay, new Date());
      } catch (error) {
        total['failed'] = (total['failed'] ?? 0) + 1;
        this.logger.warn(`Gallring failed [school=${claim.schoolId}, ${errorName(error)}]`);
      }
    }
    return total;
  }

  /** One school's night. Throws on a database failure; the run is left RUNNING and the next begin marks it INTERRUPTED. */
  async runSchool(schoolId: string): Promise<{ rows: number; people: number }> {
    // The run's time is the database's now, give or take: gallring_begin
    // refuses one more than ten minutes away.
    const [begun] = await this.prisma.withDeliveryService((tx) =>
      tx.$queryRaw<Array<{ run: string }>>(Prisma.sql`SELECT app.gallring_begin(${schoolId}::uuid, ${new Date()}::timestamptz) AS run`),
    );
    const run = begun?.run;
    if (!run) throw new Error('gallring_begin returned no run');

    const byKind: Partial<Record<RetentionDataTypeValue, number>> = {};
    let rows = 0;
    for (const kind of ROW_KINDS) {
      let taken = 0;
      for (;;) {
        const [batch] = await this.prisma.withDeliveryService((tx) =>
          tx.$queryRaw<Array<{ n: number }>>(
            Prisma.sql`SELECT app.gallring_purge(${run}::uuid, ${kind}::"RetentionDataType", ${PURGE_BATCH}::integer) AS n`,
          ),
        );
        const n = Number(batch?.n ?? 0);
        taken += n;
        if (n < PURGE_BATCH || taken >= NIGHTLY_ROW_CAP) break;
      }
      if (taken > 0) byKind[kind] = taken;
      rows += taken;
    }

    const due = await this.prisma.withDeliveryService((tx) =>
      tx.$queryRaw<DuePerson[]>(
        Prisma.sql`SELECT user_id, auth_id, invited FROM app.gallring_departed_due(${run}::uuid, ${NIGHTLY_PEOPLE_CAP}::integer)`,
      ),
    );
    const ready: string[] = [];
    let loginsLeft = 0;
    for (const person of due ?? []) {
      // A person never invited has a placeholder authId that matches no
      // login (UsersService); there is nothing to delete.
      if (person.invited) {
        try {
          await this.supabaseAdmin.deleteUser(person.auth_id);
        } catch (error) {
          loginsLeft += 1;
          this.logger.warn(`Gallring could not delete a login [school=${schoolId}, ${errorName(error)}]`);
          continue;
        }
      }
      ready.push(person.user_id);
    }
    let people = 0;
    if (ready.length > 0) {
      const [done] = await this.prisma.withDeliveryService((tx) =>
        tx.$queryRaw<Array<{ n: number }>>(Prisma.sql`SELECT app.gallring_pseudonymise(${run}::uuid, ${ready}::uuid[]) AS n`),
      );
      people = Number(done?.n ?? 0);
    }

    const waiting = loginsLeft > 0 ? { DEPARTED_PEOPLE_LOGIN: loginsLeft } : {};
    await this.prisma.withDeliveryService((tx) =>
      tx.$executeRaw(
        Prisma.sql`SELECT app.gallring_finish(${run}::uuid, ${JSON.stringify(waiting)}::jsonb, ${new Date()}::timestamptz)`,
      ),
    );
    const parts = Object.entries(byKind).map(([kind, n]) => `${kind}=${n}`);
    if (people > 0) parts.push(`DEPARTED_PEOPLE=${people}`);
    if (parts.length > 0) this.logger.log(`Gallring [school=${schoolId}, ${parts.join(', ')}]`);
    return { rows, people };
  }
}
