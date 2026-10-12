import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';

/** What a pass counted: rows, calls, schools. Never an id or a name (JobRuns_counts_are_counts). */
export type JobCounts = Record<string, number>;

export interface JobOutcome {
  ok: boolean;
  counts?: JobCounts;
  /** An error class name, as the logs have it; never a message. */
  error?: string;
}

export interface JobDefinition {
  /** Kebab-case, the JobRuns key: 'ss12000-sync', 'ss12000-webhooks', 'push-receipts', 'gallring'. */
  name: string;
  intervalMs: number;
  /** One pass. Must never throw; the job reports how it went through settled(). */
  tick: () => Promise<void>;
}

/** Count-only, for /health/ready: how many jobs this process schedules, failing or overdue on any instance. */
export interface JobsReadiness {
  scheduled: number;
  failing: number;
  overdue: number;
}

/** A job is overdue when no instance finished a pass in this many of its intervals. */
export const OVERDUE_INTERVALS = 3;
/**
 * How long readiness() reuses its last reading. /health/ready is the latency
 * bench's baseline and a probe hits it every few seconds; one ledger read a
 * minute keeps the probe at its single SELECT 1.
 */
export const READINESS_CACHE_MS = 60_000;

interface Scheduled {
  definition: JobDefinition;
  timer: NodeJS.Timeout;
  since: number;
  running: Promise<void> | null;
}

/** The name of whatever was thrown, for a log line or JobRuns.lastError. */
export function errorName(error: unknown): string {
  const name = error instanceof Error ? error.name : 'unknown';
  return /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(name) ? name : 'Error';
}

/** Keys that JobRuns accepts: short names, non-negative integers. */
function countsOnly(counts: JobCounts | undefined): JobCounts {
  const out: JobCounts = {};
  for (const [key, value] of Object.entries(counts ?? {})) {
    if (/^[a-zA-Z][a-zA-Z0-9]{0,39}$/.test(key) && Number.isInteger(value) && value >= 0) out[key] = value;
  }
  return out;
}

/**
 * The gateway's one place for background work (20261021090000). Before it,
 * the SS12000 scheduler, the webhook delivery and the push receipts each kept
 * a copy of the same setInterval pattern, and nothing outside the process
 * could tell whether any of them had run.
 *
 *   * A registry: each job registers in its own onModuleInit, only when its
 *     switch is on (SS12000_BACKGROUND, PUSH_NOTIFICATIONS,
 *     GALLRING_BACKGROUND), and leaves in onModuleDestroy.
 *   * One unref'd interval per job at the job's own interval, so the first
 *     pass comes one interval after boot, as before, and the timer never
 *     keeps the process alive. Cleared on shutdown.
 *   * Non-overlapping: a tick that finds the job's last pass still running
 *     waits for it instead of starting another. The jobs' own tick() keeps
 *     its guard too, since tests and probes call it directly.
 *   * A count of every pass (settled): one JobRuns row per job and UTC day,
 *     runs, failures and the pass's counts summed, written best effort in a
 *     transaction of its own. A failed write is logged once, not every
 *     minute, and never fails the job.
 *   * A per-school nightly claim (claimNightly): app.job_claim_nightly gives
 *     each school's night to exactly one API instance, which Railway can run
 *     two of during a deploy.
 *   * readiness(): counts for /health/ready.
 *
 * In-process rather than pg_cron: the compose database has no pg_cron, and
 * two of the jobs call out over HTTP.
 */
@Injectable()
export class JobRunner implements OnModuleDestroy {
  private readonly logger = new Logger(JobRunner.name);
  private readonly jobs = new Map<string, Scheduled>();
  private ledgerBroken = false;
  private reading: { at: number; value: JobsReadiness | null } | null = null;

  constructor(@Optional() private readonly prisma?: PrismaService) {}

  register(definition: JobDefinition): void {
    this.unregister(definition.name);
    const timer = setInterval(() => void this.fire(definition.name), definition.intervalMs);
    timer.unref();
    this.jobs.set(definition.name, { definition, timer, since: Date.now(), running: null });
    this.reading = null;
  }

  unregister(name: string): void {
    const job = this.jobs.get(name);
    if (!job) return;
    clearInterval(job.timer);
    this.jobs.delete(name);
    this.reading = null;
  }

  isScheduled(name: string): boolean {
    return this.jobs.has(name);
  }

  onModuleDestroy(): void {
    for (const name of [...this.jobs.keys()]) this.unregister(name);
  }

  /** The interval's call: one pass at a time per job. */
  private fire(name: string): Promise<void> {
    const job = this.jobs.get(name);
    if (!job) return Promise.resolve();
    if (job.running) return job.running;
    job.running = job.definition
      .tick()
      .catch((error: unknown) => this.logger.warn(`Job ${name} threw past its own guard [${errorName(error)}]`))
      .finally(() => {
        job.running = null;
      });
    return job.running;
  }

  /** How a pass went: counted in JobRuns. Never throws, never waits. */
  settled(name: string, startedAt: Date, outcome: JobOutcome): void {
    if (!this.prisma) return;
    const finishedAt = new Date();
    const counts = JSON.stringify(countsOnly(outcome.counts));
    const error = outcome.ok ? null : (outcome.error ?? 'unknown');
    void this.prisma
      .withDeliveryService((tx) =>
        tx.$executeRaw(
          Prisma.sql`SELECT app.job_run_settled(${name}, ${startedAt}::timestamptz, ${finishedAt}::timestamptz,
                                                ${outcome.ok}, ${error}, ${counts}::jsonb)`,
        ),
      )
      .then(() => {
        this.ledgerBroken = false;
      })
      .catch((failure: unknown) => {
        if (this.ledgerBroken) return;
        this.ledgerBroken = true;
        this.logger.warn(`Job ledger write failed [job=${name}, ${errorName(failure)}]`);
      });
  }

  /** Claims tonight's run of `job` for those of `schoolIds` past `hourLocal`; at most `limit`. */
  async claimNightly(
    job: string,
    hourLocal: number,
    schoolIds: string[],
    limit: number,
    at: Date,
  ): Promise<Array<{ schoolId: string; localDay: Date }>> {
    if (!this.prisma || schoolIds.length === 0) return [];
    const rows = await this.prisma.withDeliveryService((tx) =>
      tx.$queryRaw<Array<{ school_id: string; local_day: Date }>>(
        Prisma.sql`SELECT school_id, local_day
                     FROM app.job_claim_nightly(${job}, ${hourLocal}::integer, ${schoolIds}::uuid[], ${limit}::integer, ${at}::timestamptz)`,
      ),
    );
    return (rows ?? []).map((row) => ({ schoolId: row.school_id, localDay: row.local_day }));
  }

  /** Marks a school's night done, so no instance takes it again. */
  async finishNightly(job: string, schoolId: string, localDay: Date, at: Date): Promise<void> {
    if (!this.prisma) return;
    await this.prisma.withDeliveryService((tx) =>
      tx.$executeRaw(
        Prisma.sql`SELECT app.job_claim_finished(${job}, ${schoolId}::uuid, ${localDay}::date, ${at}::timestamptz)`,
      ),
    );
  }

  /**
   * Counts for /health/ready. Overdue: no instance finished a pass in
   * OVERDUE_INTERVALS of the job's intervals (counted from registration
   * while the job has no JobRuns row). Failing: its last pass failed. Null
   * when the ledger cannot be read, which says nothing about serving
   * traffic.
   */
  async readiness(now: Date = new Date()): Promise<JobsReadiness | null> {
    const scheduled = [...this.jobs.values()];
    if (scheduled.length === 0) return { scheduled: 0, failing: 0, overdue: 0 };
    if (!this.prisma) return null;
    if (this.reading && Math.abs(now.getTime() - this.reading.at) < READINESS_CACHE_MS) return this.reading.value;
    const value = await this.read(scheduled, now);
    this.reading = { at: now.getTime(), value };
    return value;
  }

  private async read(scheduled: Scheduled[], now: Date): Promise<JobsReadiness | null> {
    if (!this.prisma) return null;
    let rows: Array<{ job: string; last_finished: Date; last_failed: Date | null }>;
    try {
      rows = await this.prisma.withDeliveryService((tx) =>
        tx.$queryRaw<Array<{ job: string; last_finished: Date; last_failed: Date | null }>>(
          Prisma.sql`SELECT job, last_finished, last_failed FROM app.job_runs_latest()`,
        ),
      );
    } catch {
      return null;
    }
    let failing = 0;
    let overdue = 0;
    for (const { definition, since } of scheduled) {
      const row = (rows ?? []).find((candidate) => candidate.job === definition.name);
      if (row?.last_failed && row.last_failed.getTime() >= row.last_finished.getTime()) failing += 1;
      // A row from any instance says when the job last ran; only a job with
      // no row at all is counted from this process's registration.
      const last = row ? row.last_finished.getTime() : since;
      if (now.getTime() - last > OVERDUE_INTERVALS * definition.intervalMs) overdue += 1;
    }
    return { scheduled: scheduled.length, failing, overdue };
  }
}
