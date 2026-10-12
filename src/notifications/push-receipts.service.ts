import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { PushConfig } from '../config/configuration';
import { PrismaService } from '../database/prisma.service';
import { errorName, JobRunner, type JobCounts } from '../jobs/job-runner';
import { ExpoPushClient } from './expo-push.client';

/** The job's name in the runner and in JobRuns. */
export const RECEIPT_JOB = 'push-receipts';
/** How often the receipts are asked for. Expo: check about 15 minutes after sending; receipts live 24 h. */
export const RECEIPT_INTERVAL_MS = 5 * 60 * 1000;
export const RECEIPT_BATCH = 1000;

/**
 * Reads Expo's receipts for the tickets the delivery stored, and revokes the
 * tokens Expo says no longer reach a device (DeviceNotRegistered).
 *
 * A job of the JobRunner (src/jobs), registered ONLY when push is enabled:
 * with PUSH_NOTIFICATIONS off there is no interval at all. The interval is
 * unref'd, so it never keeps the process alive, and is cleared on shutdown.
 * Each pass is counted in JobRuns. Each tick:
 *
 *   1. app.push_due_receipts(1000) — housekeeping (tickets past 24 h, tokens
 *      revoked 30 days ago or unseen for 180), then a claim of the tickets
 *      due, FOR UPDATE SKIP LOCKED, so two API instances never ask for the
 *      same receipt and a claim nobody settles is retried after an hour;
 *   2. ExpoPushClient.receipts, 1000 ids a request;
 *   3. app.push_receipts_settled(checked, dead) — the tickets that had a
 *      receipt are deleted, the dead tokens revoked. A ticket without a
 *      receipt yet stays for a later tick.
 *
 * Logs counts per error code (MessageTooBig, MessageRateExceeded,
 * MismatchSenderId, InvalidCredentials, DeviceNotRegistered); never a token.
 */
@Injectable()
export class PushReceiptsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PushReceiptsService.name);
  private running: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly expo?: ExpoPushClient,
    @Optional() private readonly jobs?: JobRunner,
  ) {}

  onModuleInit(): void {
    if (this.config?.get<PushConfig>('push')?.enabled !== true || !this.expo || !this.jobs) return;
    this.jobs.register({ name: RECEIPT_JOB, intervalMs: RECEIPT_INTERVAL_MS, tick: () => this.tick() });
  }

  onModuleDestroy(): void {
    this.jobs?.unregister(RECEIPT_JOB);
  }

  /** Whether the interval is set (push is on). */
  get scheduled(): boolean {
    return this.jobs?.isScheduled(RECEIPT_JOB) ?? false;
  }

  /** One pass; a tick while the last one runs waits for it instead. Never throws. */
  async tick(): Promise<void> {
    if (this.running) return this.running;
    const started = new Date();
    this.running = this.pass()
      .then((counts) => this.jobs?.settled(RECEIPT_JOB, started, { ok: true, counts }))
      .catch((error: unknown) => {
        this.logger.warn(`Receipt check failed [${errorName(error)}]`);
        this.jobs?.settled(RECEIPT_JOB, started, { ok: false, error: errorName(error) });
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async pass(): Promise<JobCounts> {
    if (!this.expo) return {};
    const due = await this.prisma.withDeliveryService((tx) =>
      tx.$queryRaw<{ ticket_id: string }[]>(Prisma.sql`SELECT ticket_id FROM app.push_due_receipts(${RECEIPT_BATCH}::integer)`),
    );
    const ids = (due ?? []).map((row) => row.ticket_id);
    if (ids.length === 0) return { due: 0 };
    const receipts = await this.expo.receipts(ids);
    const checked = Object.keys(receipts);
    const dead: string[] = [];
    const errors = new Map<string, number>();
    for (const [id, receipt] of Object.entries(receipts)) {
      if (receipt.status !== 'error') continue;
      const code = receipt.details?.error ?? 'Unknown';
      errors.set(code, (errors.get(code) ?? 0) + 1);
      if (code === 'DeviceNotRegistered') dead.push(id);
    }
    if (errors.size > 0) {
      this.logger.warn(`Push receipts with errors [${[...errors].map(([code, n]) => `${code}=${n}`).join(', ')}]`);
    }
    if (checked.length === 0) return { due: ids.length, checked: 0, revoked: 0 };
    await this.prisma.withDeliveryService((tx) =>
      tx.$executeRaw(Prisma.sql`SELECT app.push_receipts_settled(${checked}::text[], ${dead}::text[])`),
    );
    this.logger.log(`Push receipts settled [checked=${checked.length}, waiting=${ids.length - checked.length}]`);
    return { due: ids.length, checked: checked.length, revoked: dead.length };
  }
}
