import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { PushConfig } from '../config/configuration';
import { PrismaService } from '../database/prisma.service';
import { ExpoPushClient, type ExpoMessage } from './expo-push.client';
import { RECIPIENT_CHUNK, type OutboxBatch, type OutboxEntry } from './notification-outbox';
import { NEVER_EXTERNAL, deliveredRegardless } from './notification-types';
import type { NotificationKind } from './notifications.service';
import { pushKindOf, pushText, type PushKind, type PushLocale } from './push-messages';

/** A push lives a day: a notice about today's lessons is no use tomorrow. */
export const PUSH_TTL_SECONDS = 86_400;
/**
 * An alarm (and its end) is told like an alarm: sent with high priority on a channel of its own that the phone
 * rings on, and not kept longer than it is true. A phone that was off for an hour must not get "Ett larm pågår"
 * for an alarm that ended before it came back; the app also asks the gateway before it shows a list.
 */
export const URGENT_PUSH_TTL_SECONDS = 600;
export const URGENT_PUSH_CHANNEL = 'crisis';
const URGENT_PUSH_TYPES: ReadonlySet<string> = new Set(['CRISIS_ALARM', 'CRISIS_ENDED']);

interface PushTarget {
  token_id: string;
  user_id: string;
  token: string;
  locale: string;
  timezone: string;
}

/** One person's notices of one kind in one batch: one push. */
interface PushNotice {
  schoolId: string;
  userId: string;
  type: NotificationKind;
  kind: PushKind;
  meta: Record<string, unknown>;
  notificationId: string;
  count: number;
  required: boolean;
}

/** Pending batches beyond which a new one is refused (logged; the in-app rows are already committed). */
export const MAX_PENDING_BATCHES = 1000;

/**
 * Addresses per mail. Resend documents 50 recipients for `to`, and nothing
 * larger for a mail as a whole, so a mail holds 50: the sender's own address
 * as `to` and 49 on BCC. A whole-school digest of some 1,800 people is about
 * 37 mails, never one.
 */
export const EMAIL_BCC_CHUNK = 49;

/** Resend's default rate is two requests a second: one mail at most every 500 ms. */
export const EMAIL_INTERVAL_MS = 500;

/**
 * Delivers what NotificationsService wrote, after the transaction that wrote
 * it has committed: e-mail through Resend, as before, and push through Expo
 * when PUSH_NOTIFICATIONS=expo.
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
 * AN ALARM DOES NOT WAIT IN IT. A request for a guardian's confirmation to a
 * whole school is 4 000 notices and some 82 mails, a minute or so of that
 * queue, and an alarm's push lives ten minutes (URGENT_PUSH_TTL_SECONDS). The
 * urgent types (URGENT_PUSH_TYPES) therefore go through a second serial
 * queue of their own, which starts at once beside the first one: the entries
 * of a batch are split by type when it is queued, so an alarm that shares a
 * transaction with other notices is still the urgent lane's. The two lanes
 * share the providers' pacing (one mail at most every EMAIL_INTERVAL_MS,
 * Expo's five requests a second), each mail and each request taking the next
 * free slot, so an alarm's mail waits one slot, not the other lane's whole
 * backlog, and the total rate is the one the providers allow.
 *
 * E-mail is BCC mail per notifyUsers chunk, with the caller's subject and
 * body, unchanged, minus the recipients who opted out of the type
 * (NotificationOptOuts, read by userId through app.delivery_opt_outs in
 * withDeliveryService) — except for the notices the school must deliver
 * (deliveredRegardless) — split into mails of EMAIL_BCC_CHUNK addresses and
 * sent at most one every EMAIL_INTERVAL_MS. Configured with
 * `RESEND_API_KEY` + `EMAIL_FROM`; when unset nothing is sent and nothing is
 * queued. TEACHER_ABSENCE_REPORTED never leaves the inbox.
 *
 * PUSH, only when configured (PushConfig.enabled; off by default, and then
 * nothing here touches Expo or the push tables):
 *
 *   1. One push per person and kind per batch: a person with three cancelled
 *      lessons in one transaction gets "3 lektioner är inställda." (C2).
 *   2. app.push_targets gives each person's live tokens, minus opt-outs
 *      unless the notice is one the school must deliver, with the school's
 *      timezone.
 *   3. Each message is written in its device's language with the templates of
 *      push-messages.ts — no name, no free text, no subject, group or room —
 *      and data { notificationId, type }.
 *   4. ExpoPushClient sends in chunks of 100 at five requests a second.
 *   5. app.push_settle stores the ok tickets (PushReceiptsService reads their
 *      receipts later) and revokes tokens Expo called DeviceNotRegistered.
 *
 * Counts of ticket errors are logged by code; never a token or a text.
 */
@Injectable()
export class NotificationDeliveryService {
  private readonly logger = new Logger(NotificationDeliveryService.name);
  /** The ordinary lane and the urgent one; each is serial, and they run beside each other. */
  private readonly lanes: Record<'ordinary' | 'urgent', { queue: OutboxBatch[]; running: Promise<void> | null }> = {
    ordinary: { queue: [], running: null },
    urgent: { queue: [], running: null },
  };
  /** The first moment the next mail may go (epoch ms), for the provider's rate; a mail takes the slot, whichever lane sends it. */
  private nextMailAt = 0;
  /** The pause between two mails; a spec sets it to 0. */
  emailIntervalMs = EMAIL_INTERVAL_MS;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly expo?: ExpoPushClient,
  ) {}

  /** Whether an entry of this shape has anywhere to go beyond the in-app inbox. */
  wants(entry: { type: NotificationKind; email?: unknown }): boolean {
    if (NEVER_EXTERNAL.has(entry.type)) return false;
    return (Boolean(entry.email) && this.emailConfigured()) || this.pushEnabled();
  }

  /** PUSH_NOTIFICATIONS=expo, and a client to send with. */
  pushEnabled(): boolean {
    return this.config?.get<PushConfig>('push')?.enabled === true && this.expo !== undefined;
  }

  emailConfigured(): boolean {
    return Boolean(process.env.RESEND_API_KEY);
  }

  /** Queues one committed transaction's notices: the alarms in the urgent lane, the rest in the ordinary one. Never throws. */
  enqueue(batch: OutboxBatch): void {
    if (batch.length === 0) return;
    const urgent = batch.filter((entry) => URGENT_PUSH_TYPES.has(entry.type));
    if (urgent.length > 0) this.offer('urgent', urgent);
    if (urgent.length < batch.length) this.offer('ordinary', urgent.length === 0 ? batch : batch.filter((entry) => !URGENT_PUSH_TYPES.has(entry.type)));
  }

  private offer(name: 'ordinary' | 'urgent', batch: OutboxBatch): void {
    const lane = this.lanes[name];
    if (lane.queue.length >= MAX_PENDING_BATCHES) {
      this.logger.warn(`Delivery queue full; ${batch.length} notice(s) not mirrored [pending=${lane.queue.length}${name === 'urgent' ? ', lane=urgent' : ''}]`);
      return;
    }
    lane.queue.push(batch);
    if (!lane.running) lane.running = this.drain(name);
  }

  /** Resolves once both queues are empty and nothing is being delivered. */
  async idle(): Promise<void> {
    while (this.lanes.ordinary.running || this.lanes.urgent.running) {
      await Promise.all([this.lanes.ordinary.running, this.lanes.urgent.running]);
    }
  }

  private async drain(name: 'ordinary' | 'urgent'): Promise<void> {
    const lane = this.lanes[name];
    try {
      for (let batch = lane.queue.shift(); batch; batch = lane.queue.shift()) {
        try {
          await this.deliver(batch);
        } catch (error) {
          this.logger.warn(`Delivery failed [${error instanceof Error ? error.name : 'unknown'}, notices=${batch.length}]`);
        }
      }
    } finally {
      lane.running = null;
    }
  }

  private async deliver(batch: OutboxBatch): Promise<void> {
    for (const entry of batch) await this.email(entry);
    if (this.pushEnabled()) await this.push(batch);
  }

  private async push(batch: OutboxBatch): Promise<void> {
    const notices = new Map<string, PushNotice>();
    for (const entry of batch) {
      const kind = pushKindOf(entry.type, entry.meta);
      if (!kind || NEVER_EXTERNAL.has(entry.type)) continue;
      const required = deliveredRegardless(entry.type, entry.meta);
      for (const recipient of entry.recipients) {
        const key = `${entry.schoolId}|${recipient.userId}|${kind}`;
        const seen = notices.get(key);
        if (seen) {
          seen.count++;
          continue;
        }
        notices.set(key, {
          schoolId: entry.schoolId,
          userId: recipient.userId,
          type: entry.type,
          kind,
          meta: entry.meta,
          notificationId: recipient.notificationId,
          count: 1,
          required,
        });
      }
    }

    // The people to ask about, per school, type and whether opt-outs count.
    const groups = new Map<string, PushNotice[]>();
    for (const notice of notices.values()) {
      const key = `${notice.schoolId}|${notice.type}|${notice.required}`;
      const group = groups.get(key);
      if (group) group.push(notice);
      else groups.set(key, [notice]);
    }

    const bySchool = new Map<string, Array<{ message: ExpoMessage; tokenId: string }>>();
    for (const group of groups.values()) {
      const { schoolId, type, required } = group[0]!;
      // Each person's notices, found by the person: a device is given its owner's, and a
      // whole-school digest is not read once per device (1,800 people twice over, 1,800 times each).
      const noticesOf = new Map<string, PushNotice[]>();
      for (const notice of group) {
        const own = noticesOf.get(notice.userId);
        if (own) own.push(notice);
        else noticesOf.set(notice.userId, [notice]);
      }
      const people = [...noticesOf.keys()];
      const targets: PushTarget[] = [];
      // A whole-school digest is one group of some 1,800 people: asked 500 at a time.
      for (let at = 0; at < people.length; at += RECIPIENT_CHUNK) {
        const chunk = people.slice(at, at + RECIPIENT_CHUNK);
        const rows = await this.prisma.withDeliveryService((tx) =>
          tx.$queryRaw<PushTarget[]>(
            Prisma.sql`SELECT token_id::text AS token_id, user_id::text AS user_id, token, locale, timezone
                         FROM app.push_targets(${schoolId}::uuid, ${chunk}::uuid[],
                                               ${type}::"NotificationType", ${required})`,
          ),
        );
        targets.push(...(rows ?? []));
      }
      const out = bySchool.get(schoolId) ?? [];
      for (const target of targets) {
        const locale: PushLocale = target.locale === 'en' ? 'en' : 'sv';
        for (const notice of noticesOf.get(target.user_id) ?? []) {
          const text = pushText(notice.kind, notice.meta, locale, target.timezone, notice.count);
          const urgent = URGENT_PUSH_TYPES.has(notice.type);
          out.push({
            tokenId: target.token_id,
            message: {
              to: target.token,
              title: text.title,
              body: text.body,
              data: { notificationId: notice.notificationId, type: notice.type },
              ttl: urgent ? URGENT_PUSH_TTL_SECONDS : PUSH_TTL_SECONDS,
              channelId: urgent ? URGENT_PUSH_CHANNEL : 'default',
              sound: 'default',
              priority: urgent ? 'high' : 'default',
              ...(urgent ? { interruptionLevel: 'time-sensitive' as const } : {}),
            },
          });
        }
      }
      bySchool.set(schoolId, out);
    }

    for (const [schoolId, outgoing] of bySchool) {
      if (outgoing.length === 0) continue;
      const tickets = await this.expo!.send(outgoing.map((o) => o.message));
      const ok: Array<{ id: string; tokenId: string }> = [];
      const dead = new Set<string>();
      const errors = new Map<string, number>();
      tickets.forEach((ticket, index) => {
        const tokenId = outgoing[index]!.tokenId;
        if (ticket.status === 'ok') {
          ok.push({ id: ticket.id, tokenId });
          return;
        }
        const code = ticket.details?.error ?? 'Unknown';
        errors.set(code, (errors.get(code) ?? 0) + 1);
        if (code === 'DeviceNotRegistered') dead.add(tokenId);
      });
      if (errors.size > 0) {
        this.logger.warn(
          `Push tickets with errors [${[...errors].map(([code, n]) => `${code}=${n}`).join(', ')}, sent=${outgoing.length}]`,
        );
      }
      if (ok.length > 0 || dead.size > 0) {
        await this.prisma.withDeliveryService((tx) =>
          tx.$executeRaw(
            Prisma.sql`SELECT app.push_settle(${schoolId}::uuid, ${[...dead]}::uuid[], ${JSON.stringify(ok)}::jsonb)`,
          ),
        );
      }
    }
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
    const from = process.env.EMAIL_FROM ?? 'Rastra Schema <noreply@schemapro.app>';
    if (!apiKey || addresses.length === 0) return;

    for (let at = 0; at < addresses.length; at += EMAIL_BCC_CHUNK) {
      // The next free slot, taken before waiting for it: the other lane's mail takes the one after.
      const now = Date.now();
      const slot = Math.max(now, this.nextMailAt);
      this.nextMailAt = slot + this.emailIntervalMs;
      if (slot > now) await new Promise((resolve) => setTimeout(resolve, slot - now));
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
            bcc: addresses.slice(at, at + EMAIL_BCC_CHUNK),
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
}
