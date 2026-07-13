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
export type SolverStatus = 'OPTIMAL' | 'FEASIBLE' | 'INFEASIBLE';

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
 * Durable, DB-backed optimization job store (replaces the former in-memory
 * queue). Jobs survive restarts, work across instances, and double as a
 * per-year run history. RLS scopes every row to the admin's school.
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

    // Fire and forget — errors are captured on the job row, never thrown.
    void this.run(job.id, academicYearId, user, weights, rules);

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
    await this.update(jobId, user, { status: 'RUNNING' });
    try {
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
