import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { LeaveConsentConfig } from '../config/configuration';
import { errorName, JobRunner } from '../jobs/job-runner';
import { LEAVE_CONSENT_INTERVAL_MS, LEAVE_CONSENT_JOB } from './leave-consent';
import { LeaveService } from './leave.service';

/**
 * Ledighetspolicyns pass (20270205091000), a job of the JobRunner: one reminder to each guardian
 * who has not answered a request for consent two days after it was filed, and the notices to the
 * mentors of a request that became clear because a custody ended (a guardian's yes tells them in
 * its own transaction). Off when LEAVE_CONSENT_BACKGROUND=off (the test setup). With nothing due it
 * is two cheap queries a quarter of an hour. Never throws; each pass is counted in JobRuns: how
 * many notices were written and how many of them were reminders.
 */
@Injectable()
export class LeaveConsentJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LeaveConsentJob.name);
  private running: Promise<void> | null = null;

  constructor(
    private readonly leave: LeaveService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly jobs?: JobRunner,
  ) {}

  onModuleInit(): void {
    if (this.config?.get<LeaveConsentConfig>('leaveConsent')?.background !== true || !this.jobs) return;
    this.jobs.register({ name: LEAVE_CONSENT_JOB, intervalMs: LEAVE_CONSENT_INTERVAL_MS, tick: () => this.tick() });
  }

  onModuleDestroy(): void {
    this.jobs?.unregister(LEAVE_CONSENT_JOB);
  }

  /** One pass; a tick while the last one runs waits for it instead. Never throws. */
  async tick(): Promise<void> {
    if (this.running) return this.running;
    const started = new Date();
    this.running = this.leave
      .consentPass()
      .then((counts) => {
        if (counts.notices > 0) this.logger.log(`Consent notices written [notices=${counts.notices}, reminded=${counts.reminded}]`);
        this.jobs?.settled(LEAVE_CONSENT_JOB, started, { ok: true, counts: { ...counts } });
      })
      .catch((error: unknown) => {
        this.logger.warn(`Consent pass failed [${errorName(error)}]`);
        this.jobs?.settled(LEAVE_CONSENT_JOB, started, { ok: false, error: errorName(error) });
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }
}
