import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CoverRequestsConfig } from '../config/configuration';
import { errorName, JobRunner } from '../jobs/job-runner';
import { CoverRequestsService } from './cover-requests.service';

/** The job's name in the runner and in JobRuns. */
export const COVER_REQUESTS_JOB = 'cover-requests';
/**
 * How often the open requests whose time is out are ended. A request past its
 * expiresAt cannot be answered whether or not this has run (the database
 * refuses the yes, the board and the colleague's list read it as expired);
 * the job only settles the stored status and frees the lesson for a new
 * request, which creating one also does for its own lessons.
 */
export const COVER_REQUESTS_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Ends the open vikarieförfrågningar whose time is out (app.cover_requests_expire,
 * 20270102091000), a job of the JobRunner. Off when COVER_REQUESTS_BACKGROUND=off
 * (the test setup). Never throws; each pass is counted in JobRuns.
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
      .expire()
      .then((expired) => {
        if (expired > 0) this.logger.log(`Cover requests expired [count=${expired}]`);
        this.jobs?.settled(COVER_REQUESTS_JOB, started, { ok: true, counts: { expired } });
      })
      .catch((error: unknown) => {
        this.logger.warn(`Cover request expiry failed [${errorName(error)}]`);
        this.jobs?.settled(COVER_REQUESTS_JOB, started, { ok: false, error: errorName(error) });
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }
}
