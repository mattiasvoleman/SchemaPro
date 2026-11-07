import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AckConfig } from '../config/configuration';
import { errorName, JobRunner } from '../jobs/job-runner';
import { ACK_INTERVAL_MS, ACK_JOB } from './ack';
import { AckService } from './ack.service';

/**
 * Kvittens' reminder pass (20270117091000), a job of the JobRunner: once, to
 * each guardian who has not confirmed a request whose time the school chose
 * has come. The pass takes the due requests one at a time, each in a
 * transaction of its own (AckService.remind), so one that cannot be finished
 * neither stops the others nor is lost. Off when ACK_BACKGROUND=off (the test
 * setup). With no request due it is one query a quarter of an hour. Never
 * throws; each pass is counted in JobRuns: how many guardians were reminded,
 * how many requests were worked through, how many failed (the pass is then
 * recorded as failed) and how many were left for the next pass.
 */
@Injectable()
export class AckJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AckJob.name);
  private running: Promise<void> | null = null;

  constructor(
    private readonly ack: AckService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly jobs?: JobRunner,
  ) {}

  onModuleInit(): void {
    if (this.config?.get<AckConfig>('ack')?.background !== true || !this.jobs) return;
    this.jobs.register({ name: ACK_JOB, intervalMs: ACK_INTERVAL_MS, tick: () => this.tick() });
  }

  onModuleDestroy(): void {
    this.jobs?.unregister(ACK_JOB);
  }

  /** One pass; a tick while the last one runs waits for it instead. Never throws. */
  async tick(): Promise<void> {
    if (this.running) return this.running;
    const started = new Date();
    this.running = this.ack
      .remind()
      .then((counts) => {
        if (counts.reminded > 0) this.logger.log(`Reminders written [guardians=${counts.reminded}, requests=${counts.requests}]`);
        if (counts.left > 0) this.logger.warn(`The reminder pass ran out of time [left=${counts.left}]`);
        this.jobs?.settled(ACK_JOB, started, counts.failed === 0 ? { ok: true, counts: { ...counts } } : { ok: false, error: 'RequestFailed', counts: { ...counts } });
      })
      .catch((error: unknown) => {
        this.logger.warn(`Reminder pass failed [${errorName(error)}]`);
        this.jobs?.settled(ACK_JOB, started, { ok: false, error: errorName(error) });
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }
}
