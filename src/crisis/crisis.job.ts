import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CrisisConfig } from '../config/configuration';
import { errorName, JobRunner } from '../jobs/job-runner';
import { CrisisService } from './crisis.service';

/** The job's name in the runner and in JobRuns. */
export const CRISIS_JOB = 'crisis';
/**
 * How often the open alarms are looked at. An alarm cannot be started twice
 * (one open per mode), so one left open by mistake would stop the next; the
 * pass ends a real alarm after 12 hours and an exercise after 3
 * (app.crisis_settle), so that is a quarter of an hour at the latest late.
 */
export const CRISIS_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Ends the alarms that have stood open longer than one can (app.crisis_settle,
 * 20270113091000), a job of the JobRunner. Off when CRISIS_BACKGROUND=off (the
 * test setup). Never throws; each pass is counted in JobRuns.
 */
@Injectable()
export class CrisisJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CrisisJob.name);
  private running: Promise<void> | null = null;

  constructor(
    private readonly crisis: CrisisService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly jobs?: JobRunner,
  ) {}

  onModuleInit(): void {
    if (this.config?.get<CrisisConfig>('crisis')?.background !== true || !this.jobs) return;
    this.jobs.register({ name: CRISIS_JOB, intervalMs: CRISIS_INTERVAL_MS, tick: () => this.tick() });
  }

  onModuleDestroy(): void {
    this.jobs?.unregister(CRISIS_JOB);
  }

  /** One pass; a tick while the last one runs waits for it instead. Never throws. */
  async tick(): Promise<void> {
    if (this.running) return this.running;
    const started = new Date();
    this.running = this.crisis
      .settle()
      .then((ended) => {
        if (ended > 0) this.logger.log(`Alarms ended by the job [ended=${ended}]`);
        this.jobs?.settled(CRISIS_JOB, started, { ok: true, counts: { ended } });
      })
      .catch((error: unknown) => {
        this.logger.warn(`Alarm settling failed [${errorName(error)}]`);
        this.jobs?.settled(CRISIS_JOB, started, { ok: false, error: errorName(error) });
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }
}
