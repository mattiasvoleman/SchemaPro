import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/*
 * A GENERERA RUN AS A QUEUE ENTRY (omgång 12, M4; migration 20270222090000).
 *
 * A run is a row in OptimizationJobs that the API process which took the
 * request works on in the background. The row is durable, the process is
 * not, so the row carries what a queue entry needs to survive the process:
 *
 *   - a LEASE ("leaseUntil"): until when the run holds its year. The process
 *     renews it every HEARTBEAT_INTERVAL_MS while it works, and each renewal
 *     sets it to the longest the engine can still be solving for the run
 *     (leaseSecondsFor). A run whose lease has run out has no engine call left
 *     to wait for, and the year can be given to the next one;
 *   - a CLAIM ("claimedBy"): which process holds it, for the log;
 *   - one active run per year, in the database: the partial unique index
 *     OptimizationJobs_one_active_per_year, which the gateway answers
 *     409 GENERATE_ALREADY_RUNNING;
 *   - a SWEEP (app.optimization_jobs_sweep) that fails a run whose lease has
 *     run out with ENGINE_RUN_ABANDONED.
 *
 * Schemaförslag's runs have the same four things (schedule-candidates.service.ts)
 * in their own table; the two kinds are kept apart by the year's start lock and
 * each start's check of the other kind's table, not by a constraint, which
 * cannot span tables.
 */

/** A second start of a year that has a Generera run going (the partial unique index, or the start's own check). */
export const GENERATE_ALREADY_RUNNING = 'GENERATE_ALREADY_RUNNING';

/**
 * How a run ends when its process is gone: the sweep's, and a restart's own
 * (OnModuleDestroy). Stored as errorCode, so the page says it in Swedish.
 */
export const ENGINE_RUN_ABANDONED = 'ENGINE_RUN_ABANDONED';

/** The English kept beside the code, as every stored refusal keeps it; the web says it by the code. */
export const ABANDONED_MESSAGE = 'The run stopped before it finished: the service that ran it was restarted or lost.';
/** What a restart that could say so itself stores instead. */
export const INTERRUPTED_MESSAGE = 'The service restarted while the run was going.';

/** The sweep's name in the runner and in JobRuns. */
export const GENERATE_SWEEP_JOB = 'generate-runs-sweep';
/**
 * Every five minutes. A start sweeps first, and a page reads an expired lease
 * as the abandonment it will become (abandonedAt), so this is for the rows
 * nobody starts after and for the candidate runs' cross-check to find them
 * ended.
 */
export const GENERATE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** How often the process that runs a job renews its lease. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * The sweep's other limit, as schemaförslag's: a run that began more than this
 * long ago has lost its process whatever its lease says (the lease is renewed
 * by a timer, and a timer can outlive the work it was for).
 */
export const RUN_MAX_AGE_MS = 30 * 60 * 1000;

/** The API's own steps around the engine call: reading the school before it, writing the timetable after. */
export const LEASE_MARGIN_SECONDS = 30;
/** The database's bounds on a lease (OptimizationJobs_lease_follows_the_heartbeat allows an hour). */
export const LEASE_MIN_SECONDS = 60;
export const LEASE_MAX_SECONDS = 3600;
/** What a lease is when the configuration says nothing: the engine's ceiling at its default budget, and the margin. */
const DEFAULT_WAIT_SECONDS = 240;

/**
 * The lease a run takes at each renewal, in seconds: the API's own wait for
 * the engine (AI_ENGINE_TIMEOUT_MS), which docs/DEPLOYMENT.md requires to exceed
 * the engine's ceiling (its budget, its probe and thirty seconds: 230 s at 180
 * and 20), plus the API's own steps. So the sweep never abandons a run whose
 * engine call could still be solving, and a second solve is never started
 * beside the first on the strength of a lease that ran out too soon.
 *
 * It follows the wait the API actually enforces, as the page's "up to N
 * minutes" does, until the engine can say its own ceiling (M1).
 *
 * The engine's 503 at its ceiling stops its wait, not its solve thread
 * (ENGINE_TIMED_OUT, optimization-proxy.service.ts): the ten seconds the API's
 * wait has over the ceiling and the thirty here are where that goes. A margin,
 * not a proof, until the engine reports when its thread ends.
 */
export function leaseSecondsFor(waitSeconds: number | undefined): number {
  const wait = typeof waitSeconds === 'number' && Number.isFinite(waitSeconds) ? waitSeconds : DEFAULT_WAIT_SECONDS;
  return Math.min(LEASE_MAX_SECONDS, Math.max(LEASE_MIN_SECONDS, Math.ceil(wait) + LEASE_MARGIN_SECONDS));
}

/** This process, by name: the host, the process id and a random part, so a restart on one host is another claimant. */
export const INSTANCE_NAME = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`.slice(0, 100);

/** The second start of a year that already has a run going. */
export function generateAlreadyRunning(): ConflictException {
  return new ConflictException({
    message: 'Generera kör redan för läsåret. Vänta tills körningen är klar.',
    code: GENERATE_ALREADY_RUNNING,
  });
}

/** P2002, or 23505 under the adapter: here, the partial unique index on the year's active run. */
export function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === 'P2002') return true;
  const cause = (error.meta as { driverAdapterError?: { cause?: { originalCode?: unknown } } } | undefined)
    ?.driverAdapterError?.cause;
  return cause?.originalCode === '23505';
}

/**
 * When an active run was abandoned, as the sweep will record it: the moment
 * its lease ran out, or now for a run past the sweep's other limit. Null for a
 * run that is not active, or whose lease holds. A page reads this so that it
 * never polls a dead run for ever while the sweep is a few minutes off.
 *
 * `leaseUntil` is the database's clock and `now` the API's, so a few seconds
 * of skew move the verdict a few seconds; the lease is minutes.
 */
export function abandonedAt(
  run: { status: string; leaseUntil?: Date | null; createdAt: Date },
  now: Date,
): Date | null {
  if (run.status !== 'PENDING' && run.status !== 'RUNNING') return null;
  const leaseEnds = run.leaseUntil;
  if (!leaseEnds) return null;
  const lapsed = leaseEnds.getTime() < now.getTime();
  const tooOld = run.createdAt.getTime() < now.getTime() - RUN_MAX_AGE_MS;
  if (!lapsed && !tooOld) return null;
  return new Date(Math.min(leaseEnds.getTime(), now.getTime()));
}
