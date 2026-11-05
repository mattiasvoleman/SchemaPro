import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CoverRequestsConfig } from '../config/configuration';
import { errorName, JobRunner } from '../jobs/job-runner';
import { CoverRequestsService } from './cover-requests.service';

/** The job's name in the runner and in JobRuns. */
export const COVER_REQUESTS_JOB = 'cover-requests';
/**
 * How often the open requests are settled. A request past its expiresAt
 * cannot be answered whether or not this has run (the database refuses the
 * yes, the board and the colleague's list read it as expired), and one whose
 * lesson was cancelled or whose absence was taken back is refused when it is
 * answered; the job settles the stored status, frees the lessons for a new
 * request (creating one also does it for its own lessons), and tells who it
 * concerns: the sender when nobody said yes in time, the colleagues the
 * question still waited on when it is no longer needed.
 */
export const COVER_REQUESTS_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Settles the open vikarieförfrågningar (app.cover_requests_settle,
 * 20270102091000): ends the ones whose time is out or whose grounds are gone,
 * a job of the JobRunner. Off when COVER_REQUESTS_BACKGROUND=off (the test
 * setup); gallring then still removes a request nobody can answer any more
 * once it is older than the cutoff. Never throws; each pass is counted in
 * JobRuns.
 */
@Injectable()
export class CoverRequestsJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CoverRequestsJob.name);
  private running: Promise<void> | null = null;

  constructor(
    private readonly requests: CoverRequestsService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly jobs?: JobRunner,
  ) {}

  onModuleInit(): void {
    if (this.config?.get<CoverRequestsConfig>('coverRequests')?.background !== true || !this.jobs) return;
    this.jobs.register({ name: COVER_REQUESTS_JOB, intervalMs: COVER_REQUESTS_INTERVAL_MS, tick: () => this.tick() });
  }

  onModuleDestroy(): void {
    this.jobs?.unregister(COVER_REQUESTS_JOB);
  }

  /** One pass; a tick while the last one runs waits for it instead. Never throws. */
  async tick(): Promise<void> {
    if (this.running) return this.running;
    const started = new Date();
    this.running = this.requests
      .settle()
      .then((counts) => {
        if (counts.expired + counts.notNeeded > 0) {
          this.logger.log(`Cover requests settled [expired=${counts.expired}, notNeeded=${counts.notNeeded}]`);
        }
        this.jobs?.settled(COVER_REQUESTS_JOB, started, { ok: true, counts: { ...counts } });
      })
      .catch((error: unknown) => {
        this.logger.warn(`Cover request settling failed [${errorName(error)}]`);
        this.jobs?.settled(COVER_REQUESTS_JOB, started, { ok: false, error: errorName(error) });
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }
}
