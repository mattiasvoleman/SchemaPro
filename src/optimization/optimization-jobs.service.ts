import { randomUUID } from 'node:crypto';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { OptimizationProxyService } from './optimization-proxy.service';
import type { AiEngineConflictDetail } from './interfaces/ai-engine-payload.interface';

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

interface JobRecord extends OptimizationJobView {
  /** Tenant guard — jobs are only visible to the school that started them. */
  schoolId: string;
}

const MAX_RETAINED_JOBS = 50;

/**
 * In-memory optimization job queue.
 *
 * Solver runs take seconds-to-minutes, so the trigger endpoint returns a job
 * id immediately and the UI polls `GET /jobs/:id`. A single-instance,
 * in-memory store is deliberate: jobs are ephemeral progress reports (the
 * durable output is the MasterLessons table). For multi-instance deployments
 * swap this for a Redis- or DB-backed store.
 */
@Injectable()
export class OptimizationJobsService {
  private readonly logger = new Logger(OptimizationJobsService.name);
  private readonly jobs = new Map<string, JobRecord>();

  constructor(private readonly proxy: OptimizationProxyService) {}

  start(academicYearId: string, user: AuthenticatedUser): { jobId: string } {
    const schoolId = user.schoolId ?? 'unknown';
    const job: JobRecord = {
      id: randomUUID(),
      schoolId,
      status: 'PENDING',
      solverStatus: null,
      lessonsGenerated: 0,
      conflictSummary: null,
      conflicts: [],
      error: null,
      createdAt: new Date().toISOString(),
      finishedAt: null,
    };
    this.jobs.set(job.id, job);
    this.evictOldJobs();

    // Fire and forget — errors are captured on the job record, never thrown.
    void this.run(job, academicYearId, user);

    return { jobId: job.id };
  }

  get(jobId: string, user: AuthenticatedUser): OptimizationJobView {
    const job = this.jobs.get(jobId);
    if (!job || (user.schoolId && job.schoolId !== user.schoolId)) {
      throw new NotFoundException('Optimization job not found.');
    }
    const { schoolId: _schoolId, ...view } = job;
    return view;
  }

  private async run(
    job: JobRecord,
    academicYearId: string,
    user: AuthenticatedUser,
  ): Promise<void> {
    job.status = 'RUNNING';
    try {
      const response = await this.proxy.triggerScheduling(academicYearId, user);
      job.status = 'SUCCEEDED';
      job.solverStatus = response.status;
      job.lessonsGenerated = response.lessons.length;
      job.conflictSummary = response.conflicts?.summary ?? null;
      job.conflicts = (response.conflicts?.conflicts ?? []).map((conflict) => ({
        category: conflict.category,
        message: conflict.message,
      }));
    } catch (error) {
      job.status = 'FAILED';
      job.error =
        error instanceof Error ? error.message : 'The optimization run failed.';
      this.logger.warn(`Optimization job failed [jobId=${job.id}]`);
    } finally {
      job.finishedAt = new Date().toISOString();
    }
  }

  private evictOldJobs(): void {
    if (this.jobs.size <= MAX_RETAINED_JOBS) return;
    const excess = this.jobs.size - MAX_RETAINED_JOBS;
    const oldestFirst = [...this.jobs.values()]
      .filter((job) => job.status === 'SUCCEEDED' || job.status === 'FAILED')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, excess);
    for (const job of oldestFirst) {
      this.jobs.delete(job.id);
    }
  }
}
