import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { OptimizationProxyService } from './optimization-proxy.service';
import type {
  AiEngineConflictDetail,
  ObjectiveWeights,
  ScheduleRules,
} from './interfaces/ai-engine-payload.interface';

export type JobStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
export type SolverStatus = 'OPTIMAL' | 'FEASIBLE' | 'INFEASIBLE' | 'TIMEOUT';

export interface OptimizationJobView {
  id: string;
  status: JobStatus;
  solverStatus: SolverStatus | null;
  lessonsGenerated: number;
  conflictSummary: string | null;
  conflicts: Array<Pick<AiEngineConflictDetail, 'category' | 'message'>>;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

const JOB_SELECT = {
  id: true,
  status: true,
  solverStatus: true,
  lessonsGenerated: true,
  conflictSummary: true,
  conflicts: true,
  error: true,
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

    const job = await this.prisma.withRls(user, (tx) =>
      tx.optimizationJob.create({
        data: {
          schoolId: user.schoolId as string,
          academicYearId,
          actorId: user.userId ?? null,
          status: 'PENDING',
          weights: (weights ?? undefined) as Prisma.InputJsonValue | undefined,
        },
        select: { id: true },
      }),
    );

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
    const job = await this.prisma.withRls(user, (tx) =>
      tx.optimizationJob.findUnique({ where: { id: jobId }, select: JOB_SELECT }),
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
    const jobs = await this.prisma.withRls(user, (tx) =>
      tx.optimizationJob.findMany({
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
        conflicts: (response.conflicts?.conflicts ?? []).map((conflict) => ({
          category: conflict.category,
          message: conflict.message,
        })) as unknown as Prisma.InputJsonValue,
        finishedAt: new Date(),
      });
    } catch (error) {
      this.logger.warn(`Optimization job failed [jobId=${jobId}]`);
      await this.update(jobId, user, {
        status: 'FAILED',
        error:
          error instanceof Error ? error.message : 'The optimization run failed.',
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
    conflicts: unknown;
    error: string | null;
    createdAt: Date;
    finishedAt: Date | null;
  }): OptimizationJobView {
    return {
      id: job.id,
      status: job.status as JobStatus,
      solverStatus: (job.solverStatus as SolverStatus | null) ?? null,
      lessonsGenerated: job.lessonsGenerated,
      conflictSummary: job.conflictSummary,
      conflicts: Array.isArray(job.conflicts)
        ? (job.conflicts as Array<Pick<AiEngineConflictDetail, 'category' | 'message'>>)
        : [],
      error: job.error,
      createdAt: job.createdAt.toISOString(),
      finishedAt: job.finishedAt ? job.finishedAt.toISOString() : null,
    };
  }
}
