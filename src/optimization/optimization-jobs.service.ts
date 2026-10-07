import { HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { OptimizationProxyService } from './optimization-proxy.service';
import type {
  AiEngineConflictDetail,
  ObjectiveWeights,
  ScheduleRules,
} from './interfaces/ai-engine-payload.interface';
import { refuseRostersNotActivated } from '../year-rollover/rosters-current';

/**
 * A stored params blob, read back as the scalars the engine promised.
 *
 * Prisma hands a Json column back as `unknown`, and the column is written by
 * this service alone — but a hand-edited row must not put an object where a
 * message expects a number, because next-intl renders that as [object Object]
 * in the middle of a school's refusal. Anything that is not a scalar is
 * dropped, and the sentence falls back to the engine's English.
 */
function asParams(value: unknown): Record<string, string | number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const params: Record<string, string | number> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string' || typeof entry === 'number') params[key] = entry;
  }
  return params;
}

/**
 * What a failed run has to say for itself.
 *
 * The engine refuses a payload it cannot schedule — a lunch window a locked
 * lesson leaves nothing of, a sitting too small for a stage — and the proxy
 * throws that on as an HttpException whose body carries the refusal's own
 * name and values beside its English. Read them here so the screen can say it
 * in Swedish. Anything else that went wrong is a fault of ours, and gets its
 * message and no code: there is nothing to translate about a lost connection
 * to the engine, and pretending otherwise would put a Swedish sentence on an
 * error a school cannot act on anyway.
 */
function refusalOf(error: unknown): {
  message: string;
  code: string | null;
  params: Record<string, string | number> | null;
} {
  const fallback = 'The optimization run failed.';
  if (error instanceof HttpException) {
    const body = error.getResponse();
    if (typeof body === 'object' && body !== null) {
      const shape = body as {
        message?: unknown;
        code?: unknown;
        params?: unknown;
      };
      return {
        message: typeof shape.message === 'string' ? shape.message : error.message,
        code: typeof shape.code === 'string' ? shape.code : null,
        params: asParams(shape.params),
      };
    }
    return { message: typeof body === 'string' ? body : error.message, code: null, params: null };
  }
  return {
    message: error instanceof Error ? error.message : fallback,
    code: null,
    params: null,
  };
}

export type JobStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
export type SolverStatus = 'OPTIMAL' | 'FEASIBLE' | 'INFEASIBLE' | 'TIMEOUT';

/**
 * What of a refusal the job row keeps: the category, the sentence, and the
 * names of the groups the sentence is about. Not the id arrays — they are
 * meaningless once the run is over, and were meaningless before too, when
 * they were the engine's anonymous ones.
 */
export interface StoredConflict {
  category: AiEngineConflictDetail['category'];
  /**
   * The sentence's name and values, so the screen renders it in the reader's
   * language. Optional because a row written before the engine named its
   * sentences has neither, and the screen then shows `message` — the same
   * path a sentence takes when the web has no translation for it yet.
   */
  code?: string;
  params?: Record<string, string | number>;
  message: string;
  resourceNames: string[];
}

export interface OptimizationJobView {
  id: string;
  status: JobStatus;
  solverStatus: SolverStatus | null;
  lessonsGenerated: number;
  conflictSummary: string | null;
  conflictSummaryCode: string | null;
  conflictSummaryParams: Record<string, string | number> | null;
  conflicts: StoredConflict[];
  error: string | null;
  errorCode: string | null;
  errorParams: Record<string, string | number> | null;
  createdAt: string;
  finishedAt: string | null;
}

const JOB_SELECT = {
  id: true,
  status: true,
  solverStatus: true,
  lessonsGenerated: true,
  conflictSummary: true,
  conflictSummaryCode: true,
  conflictSummaryParams: true,
  conflicts: true,
  error: true,
  errorCode: true,
  errorParams: true,
  createdAt: true,
  finishedAt: true,
} as const;

/**
 * DB-backed optimization job store (replaces the former in-memory queue). The
 * row is what the Generate page polls and what the per-year run history reads;
 * RLS scopes every row to the admin's school.
 *
 * The row is durable, the *work* is not. `run` executes in whichever API
 * process took the request, with no lease and no sweeper, so a restart
 * mid-solve strands the row at RUNNING for ever and nothing stops two admins
 * starting overlapping runs for the same year. Turning this into a real queue
 * needs a claim column, a partial unique index on the active job per year, and
 * a startup pass that fails abandoned rows — until then, do not read this
 * class as one.
 */
@Injectable()
export class OptimizationJobsService {
  private readonly logger = new Logger(OptimizationJobsService.name);

  constructor(
    private readonly proxy: OptimizationProxyService,
    private readonly prisma: PrismaService,
  ) {}

  async start(
    academicYearId: string,
    user: AuthenticatedUser,
    weights?: ObjectiveWeights,
    rules?: ScheduleRules,
  ): Promise<{ jobId: string }> {
    if (!user.schoolId) {
      throw new NotFoundException('School context missing from token.');
    }

    const job = await this.prisma.withRls(user, async (tx) => {
      // Answered here, not in the job: a rolled year not yet activated has
      // no pupils in its classes, and the admin should hear that at the click.
      await refuseRostersNotActivated(tx, academicYearId);
      return tx.optimizationJob.create({
        data: {
          schoolId: user.schoolId as string,
          academicYearId,
          actorId: user.userId ?? null,
          status: 'PENDING',
          weights: (weights ?? undefined) as Prisma.InputJsonValue | undefined,
        },
        select: { id: true },
      });
    });

    // Fire and forget — run() records its own outcome on the job row and is
    // written never to throw. The catch stays regardless: this promise is
    // deliberately unawaited, and Node answers an unhandled rejection by
    // terminating the process, so one slip inside run() would take the API down
    // for every school on the instance instead of failing a single job.
    void this.run(job.id, academicYearId, user, weights, rules).catch(
      (error: unknown) => {
        this.logger.error(
          `Optimization job ${job.id} crashed outside its own error handling.`,
          error instanceof Error ? error.stack : String(error),
        );
      },
    );

    return { jobId: job.id };
  }

  async get(jobId: string, user: AuthenticatedUser): Promise<OptimizationJobView> {
    const job = await this.prisma.queryWithRls(user, (db) =>
      db.optimizationJob.findUnique({ where: { id: jobId }, select: JOB_SELECT }),
    );
    if (!job) {
      throw new NotFoundException('Optimization job not found.');
    }
    return this.toView(job);
  }

  /** Latest runs for an academic year (run history for the Generate page). */
  async list(
    academicYearId: string,
    user: AuthenticatedUser,
  ): Promise<OptimizationJobView[]> {
    const jobs = await this.prisma.queryWithRls(user, (db) =>
      db.optimizationJob.findMany({
        where: { academicYearId },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: JOB_SELECT,
      }),
    );
    return jobs.map((job) => this.toView(job));
  }

  private async run(
    jobId: string,
    academicYearId: string,
    user: AuthenticatedUser,
    weights?: ObjectiveWeights,
    rules?: ScheduleRules,
  ): Promise<void> {
    try {
      // Inside the try, not before it. This is the first database write after
      // the request has already returned — a pool exhaustion or a failover here
      // is the likeliest failure of the whole run — and outside the try its
      // rejection escapes into the unawaited promise above instead of landing
      // on the job row like every other failure.
      await this.update(jobId, user, { status: 'RUNNING' });
      const response = await this.proxy.triggerScheduling(
        academicYearId,
        user,
        weights ?? null,
        rules ?? null,
      );
      await this.update(jobId, user, {
        status: 'SUCCEEDED',
        solverStatus: response.status,
        lessonsGenerated: response.lessons.length,
        conflictSummary: response.conflicts?.summary ?? null,
        conflictSummaryCode: response.conflicts?.summaryCode ?? null,
        conflictSummaryParams:
          (response.conflicts?.summaryParams as Prisma.InputJsonValue) ?? Prisma.DbNull,
        conflicts: (response.conflicts?.conflicts ?? []).map(
          (conflict): StoredConflict => ({
            category: conflict.category,
            code: conflict.code,
            params: conflict.params ?? {},
            message: conflict.message,
            resourceNames: conflict.resourceNames ?? [],
          }),
        ) as unknown as Prisma.InputJsonValue,
        finishedAt: new Date(),
      });
    } catch (error) {
      this.logger.warn(`Optimization job failed [jobId=${jobId}]`);
      const refusal = refusalOf(error);
      await this.update(jobId, user, {
        status: 'FAILED',
        error: refusal.message,
        errorCode: refusal.code,
        errorParams: (refusal.params as Prisma.InputJsonValue) ?? Prisma.DbNull,
        finishedAt: new Date(),
      }).catch(() => undefined);
    }
  }

  private async update(
    jobId: string,
    user: AuthenticatedUser,
    data: Prisma.OptimizationJobUpdateInput,
  ): Promise<void> {
    await this.prisma.withRls(user, (tx) =>
      tx.optimizationJob.update({ where: { id: jobId }, data }),
    );
  }

  private toView(job: {
    id: string;
    status: string;
    solverStatus: string | null;
    lessonsGenerated: number;
    conflictSummary: string | null;
    conflictSummaryCode?: string | null;
    conflictSummaryParams?: unknown;
    conflicts: unknown;
    error: string | null;
    errorCode?: string | null;
    errorParams?: unknown;
    createdAt: Date;
    finishedAt: Date | null;
  }): OptimizationJobView {
    return {
      id: job.id,
      status: job.status as JobStatus,
      solverStatus: (job.solverStatus as SolverStatus | null) ?? null,
      lessonsGenerated: job.lessonsGenerated,
      conflictSummary: job.conflictSummary,
      // `?? null` rather than the value: a row read back from a database that
      // predates these columns has undefined where the view promises null,
      // and undefined disappears from a JSON body instead of arriving as
      // "no code, show the English".
      conflictSummaryCode: job.conflictSummaryCode ?? null,
      conflictSummaryParams: asParams(job.conflictSummaryParams),
      errorCode: job.errorCode ?? null,
      errorParams: asParams(job.errorParams),
      // Rows written before names were kept carry none; read as an empty
      // list rather than as undefined, which the page would have to guard.
      conflicts: Array.isArray(job.conflicts)
        ? (job.conflicts as Array<Partial<StoredConflict> & Pick<StoredConflict, 'category' | 'message'>>).map(
            (conflict) => ({ ...conflict, resourceNames: conflict.resourceNames ?? [] }),
          )
        : [],
      error: job.error,
      createdAt: job.createdAt.toISOString(),
      finishedAt: job.finishedAt ? job.finishedAt.toISOString() : null,
    };
  }
}
