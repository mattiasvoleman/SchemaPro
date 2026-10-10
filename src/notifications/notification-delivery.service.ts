import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import type { OutboxBatch, OutboxEntry } from './notification-outbox';
import { NEVER_EXTERNAL, deliveredRegardless } from './notification-types';
import type { NotificationKind } from './notifications.service';

/** Pending batches beyond which a new one is refused (logged; the in-app rows are already committed). */
export const MAX_PENDING_BATCHES = 1000;

/**
 * Delivers what NotificationsService wrote, after the transaction that wrote
 * it has committed: e-mail through Resend, as before.
 *
 * WHY AFTER THE COMMIT. notifyUsers used to dispatch e-mail before the
 * caller's transaction had committed, so a write that was refused or rolled
 * back after the notice could already have mailed. Only the cover module
 * deferred its notices (cover.service.ts afterCommit). Now every caller's
 * notices wait for the commit: PrismaService.onCommit runs one hook per
 * transaction, which hands this service the transaction's whole outbox.
 *
 * ONE AT A TIME. A DRAFT publish or a cover-board day notifies once per
 * class or per substitute inside one transaction; were each delivered on its
 * own, a publish would start dozens of deliveries at once against a pool of
 * ten. Batches go through one process-wide serial queue: the next starts
 * when the last has finished. The queue is bounded (MAX_PENDING_BATCHES).
 *
 * E-mail is one BCC mail per notifyUsers call, with the caller's subject and
 * body, unchanged, minus the recipients who opted out of the type
 * (NotificationOptOuts, read by userId through app.delivery_opt_outs in
 * withDeliveryService) — except for the notices the school must deliver
 * (deliveredRegardless). Configured with `RESEND_API_KEY` + `EMAIL_FROM`;
 * when unset nothing is sent and nothing is queued. TEACHER_ABSENCE_REPORTED
 * never leaves the inbox.
 */
@Injectable()
export class NotificationDeliveryService {
  private readonly logger = new Logger(NotificationDeliveryService.name);
  private readonly queue: OutboxBatch[] = [];
  private running: Promise<void> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /** Whether an entry of this shape has anywhere to go beyond the in-app inbox. */
  wants(entry: { type: NotificationKind; email?: unknown }): boolean {
    if (NEVER_EXTERNAL.has(entry.type)) return false;
    return Boolean(entry.email) && this.emailConfigured();
  }

  emailConfigured(): boolean {
    return Boolean(process.env.RESEND_API_KEY);
  }

  /** Queues one committed transaction's notices. Never throws. */
  enqueue(batch: OutboxBatch): void {
    if (batch.length === 0) return;
    if (this.queue.length >= MAX_PENDING_BATCHES) {
      this.logger.warn(`Delivery queue full; ${batch.length} notice(s) not mirrored [pending=${this.queue.length}]`);
      return;
    }
    this.queue.push(batch);
    if (!this.running) this.running = this.drain();
  }

  /** Resolves once the queue is empty and nothing is being delivered. */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  private async drain(): Promise<void> {
    try {
      for (let batch = this.queue.shift(); batch; batch = this.queue.shift()) {
        try {
          await this.deliver(batch);
        } catch (error) {
          this.logger.warn(`Delivery failed [${error instanceof Error ? error.name : 'unknown'}, notices=${batch.length}]`);
        }
      }
    } finally {
      this.running = null;
    }
  }

  private async deliver(batch: OutboxBatch): Promise<void> {
    for (const entry of batch) await this.email(entry);
  }

  private async email(entry: OutboxEntry): Promise<void> {
    if (!entry.email || !this.emailConfigured() || NEVER_EXTERNAL.has(entry.type)) return;
    const withAddress = entry.email.recipients.filter((r) => Boolean(r.email));
    if (withAddress.length === 0) return;
    const optedOut = deliveredRegardless(entry.type, entry.meta)
      ? new Set<string>()
      : await this.optOuts(entry.schoolId, withAddress.map((r) => r.userId), entry.type);
    const addresses = withAddress.filter((r) => !optedOut.has(r.userId)).map((r) => r.email);
    await this.sendEmails(addresses, entry.email.subject, entry.email.body);
  }

  /** Who of `userIds` said no to `type` outside the app (NotificationOptOuts). */
  private async optOuts(schoolId: string, userIds: string[], type: NotificationKind): Promise<Set<string>> {
    const rows = await this.prisma.withDeliveryService((tx) =>
      tx.$queryRaw<{ user_id: string }[]>(
        Prisma.sql`SELECT u::text AS user_id FROM app.delivery_opt_outs(${schoolId}::uuid, ${userIds}::uuid[], ${type}::"NotificationType") AS u`,
      ),
    );
    return new Set((rows ?? []).map((row) => row.user_id));
  }

  private async sendEmails(addresses: string[], subject: string, body: string): Promise<void> {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.EMAIL_FROM ?? 'SchemaPro <noreply@schemapro.app>';
    if (!apiKey || addresses.length === 0) return;

    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from,
          // BCC so recipients never see each other's addresses.
          to: [from.replace(/^.*<|>$/g, '')],
          bcc: addresses,
          subject,
          text: body,
        }),
      });
      if (!response.ok) {
        this.logger.warn(`Email dispatch failed [status=${response.status}]`);
      }
    } catch {
      this.logger.warn('Email dispatch failed [network]');
    }
  }
}
