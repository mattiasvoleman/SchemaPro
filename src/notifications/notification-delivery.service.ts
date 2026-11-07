import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { PushConfig } from '../config/configuration';
import { PrismaService } from '../database/prisma.service';
import { ExpoPushClient, type ExpoMessage } from './expo-push.client';
import { RECIPIENT_CHUNK, type OutboxBatch, type OutboxEntry, type OutboxSettled } from './notification-outbox';
import { NEVER_EXTERNAL, deliveredRegardless } from './notification-types';
import { isTimeoutError } from './request-timeout';
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

/**
 * The ticket errors that say the channel itself did not take the request, so that a reminder is not told "taken":
 * the client's own answer for a chunk it could not get through or got no answer for (RequestFailed), and the two
 * refusals of our credentials, which are the same for every device (InvalidCredentials, MismatchSenderId: Expo does
 * not accept the project's push credentials, or the sender they name is not the one the tokens belong to). The rest
 * are one device's or one message's: DeviceNotRegistered (the device is gone, and revoked), MessageTooBig and
 * MessageRateExceeded. The channel took those requests, and a retry would not change them.
 */
const CHANNEL_ERRORS: ReadonlySet<string> = new Set(['RequestFailed', 'InvalidCredentials', 'MismatchSenderId']);

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
 * How long a mail may wait for Resend's answer before it is given up (logged, not retried, like any refused mail).
 * Resend answers in well under a second; a mail that has had ten has no answer coming. The mails of a lane go one
 * at a time, so a mail that never answers holds the lane (the ordinary one carries every school's notices), and
 * without a limit it held it for as long as the runtime waits for a response, five minutes. Ten seconds is twenty
 * mail intervals: long enough for a slow answer, short enough that a Resend that does not answer at all costs a
 * wave one lane-ful of seconds a mail, not minutes.
 */
export const EMAIL_TIMEOUT_MS = 10_000;

/** A queued batch, and who wants to know how it went. */
interface Queued {
  batch: OutboxBatch;
  settled?: OutboxSettled;
}

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
 * Expo's five requests a second). Mails go one at a time in the order they
 * ask for their turn, each at least EMAIL_INTERVAL_MS after the last one
 * ACTUALLY went, not after the moment it was planned for: a timer that fires
 * late must not bring the next mail closer than the interval, and Resend
 * refuses what comes faster than two a second. So an alarm's mail waits one
 * turn, not the other lane's whole backlog, and the total rate is the one the
 * providers allow. A turn that throws costs the mail it was for and nothing more
 * (the chain goes on from a settled link, mailTurn).
 *
 * A REQUEST NOBODY ANSWERS IS GIVEN UP. A mail waits EMAIL_TIMEOUT_MS for Resend
 * (ExpoPushClient has its own limit for Expo): the mails of a lane go one at a
 * time, so one that never answered held the lane, and the ordinary lane carries
 * every school's notices, for as long as the runtime waits, five minutes. It is
 * logged and not sent again, like any mail Resend refused.
 *
 * HOW A BATCH WENT. enqueue takes a listener (OutboxSettled) that is told once,
 * when the batch has been worked through: true when every mail was taken by Resend
 * and every push request by Expo (or there was nothing outside the inbox), false
 * when one was refused, timed out, or the batch was dropped. It is not told when the
 * process stops with the batch in the queue, which is in memory: no word is an answer
 * too. Kvittens' reminder uses it to say "Skickad" only when the mail went.
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
  private readonly lanes: Record<'ordinary' | 'urgent', { queue: Queued[]; running: Promise<void> | null }> = {
    ordinary: { queue: [], running: null },
    urgent: { queue: [], running: null },
  };
  /** When the last mail really went (epoch ms), for the provider's rate. */
  private lastMailAt = 0;
  /** The mails waiting for their turn, both lanes in the order they asked: each turn starts when the one before it has gone. */
  private mailTurns: Promise<void> = Promise.resolve();
  /** The pause between two mails; a spec sets it to 0. */
  emailIntervalMs = EMAIL_INTERVAL_MS;
  /** How long a mail waits for Resend's answer; a spec shortens it. */
  emailTimeoutMs = EMAIL_TIMEOUT_MS;

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

  /**
   * Queues one committed transaction's notices: the alarms in the urgent lane, the rest in the ordinary one. Never
   * throws. `settled`, when given, is told once how the whole batch went (OutboxSettled): at once and true for a
   * batch with nothing to deliver outside the inbox, after the last lane has finished otherwise.
   */
  enqueue(batch: OutboxBatch, settled?: OutboxSettled): void {
    if (batch.length === 0) {
      this.tell(settled, true);
      return;
    }
    const urgent = batch.filter((entry) => URGENT_PUSH_TYPES.has(entry.type));
    const ordinary = urgent.length === 0 ? batch : batch.filter((entry) => !URGENT_PUSH_TYPES.has(entry.type));
    // The lanes finish apart; the caller hears once, when both have, and "delivered" only if both delivered.
    let lanes = (urgent.length > 0 ? 1 : 0) + (ordinary.length > 0 ? 1 : 0);
    let all = true;
    const part: OutboxSettled | undefined = settled
      ? (delivered) => {
          all = all && delivered;
          lanes -= 1;
          if (lanes === 0) this.tell(settled, all);
        }
      : undefined;
    if (urgent.length > 0) this.offer('urgent', urgent, part);
    if (ordinary.length > 0) this.offer('ordinary', ordinary, part);
  }

  private offer(name: 'ordinary' | 'urgent', batch: OutboxBatch, settled?: OutboxSettled): void {
    const lane = this.lanes[name];
    if (lane.queue.length >= MAX_PENDING_BATCHES) {
      this.logger.warn(`Delivery queue full; ${batch.length} notice(s) not mirrored [pending=${lane.queue.length}${name === 'urgent' ? ', lane=urgent' : ''}]`);
      this.tell(settled, false);
      return;
    }
    lane.queue.push({ batch, settled });
    if (!lane.running) lane.running = this.drain(name);
  }

  /** Tells whoever asked how a batch went. A listener that throws must not stop the lane. */
  private tell(settled: OutboxSettled | undefined, delivered: boolean): void {
    try {
      settled?.(delivered);
    } catch (error) {
      this.logger.warn(`A delivery listener failed [${error instanceof Error ? error.name : 'unknown'}]`);
    }
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
      for (let next = lane.queue.shift(); next; next = lane.queue.shift()) {
        let delivered = false;
        try {
          delivered = await this.deliver(next.batch);
        } catch (error) {
          this.logger.warn(`Delivery failed [${error instanceof Error ? error.name : 'unknown'}, notices=${next.batch.length}]`);
        }
        this.tell(next.settled, delivered);
      }
    } finally {
      lane.running = null;
    }
  }

  /** Whether every mail and every push the batch wanted was taken by its channel. */
  private async deliver(batch: OutboxBatch): Promise<boolean> {
    let delivered = true;
    for (const entry of batch) delivered = (await this.email(entry)) && delivered;
    if (this.pushEnabled()) delivered = (await this.push(batch)) && delivered;
    return delivered;
  }

  /**
   * Whether Expo took every request. A device it says is gone, and a refusal for one device or one message, is not the
   * channel failing; a refusal of our credentials, or a request the client could not get through, is (CHANNEL_ERRORS).
   */
  private async push(batch: OutboxBatch): Promise<boolean> {
    let taken = true;
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
        if (CHANNEL_ERRORS.has(code)) taken = false;
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
    return taken;
  }

  /** Whether every mail of the entry was taken by Resend (also when there was none to send). */
  private async email(entry: OutboxEntry): Promise<boolean> {
    if (!entry.email || !this.emailConfigured() || NEVER_EXTERNAL.has(entry.type)) return true;
    const withAddress = entry.email.recipients.filter((r) => Boolean(r.email));
    if (withAddress.length === 0) return true;
    const optedOut = deliveredRegardless(entry.type, entry.meta)
      ? new Set<string>()
      : await this.optOuts(entry.schoolId, withAddress.map((r) => r.userId), entry.type);
    const addresses = withAddress.filter((r) => !optedOut.has(r.userId)).map((r) => r.email);
    return this.sendEmails(addresses, entry.email.subject, entry.email.body);
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

  /**
   * Resolves when this mail may go: it is next in line, and EMAIL_INTERVAL_MS has passed since the last mail went, from
   * whichever lane. The moment is taken when the wait ends, so the interval is kept even when a timer fires late.
   */
  private async mailTurn(): Promise<void> {
    const turn = this.mailTurns.then(async () => {
      for (let wait = this.lastMailAt + this.emailIntervalMs - Date.now(); wait > 0; wait = this.lastMailAt + this.emailIntervalMs - Date.now()) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      this.lastMailAt = Date.now();
    });
    // A turn that throws must not close the mail for the process: every later turn is chained to this one, and
    // a rejected link would be skipped by all of them (and rejected by every mailTurn) until a restart. The
    // caller of THIS turn still hears of it.
    this.mailTurns = turn.catch(() => undefined);
    await turn;
  }

  /** Whether Resend took every mail (also when there was none to send). A mail that fails is logged and not sent again. */
  private async sendEmails(addresses: string[], subject: string, body: string): Promise<boolean> {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.EMAIL_FROM ?? 'Rastra Schema <noreply@schemapro.app>';
    if (!apiKey || addresses.length === 0) return true;

    let taken = true;
    for (let at = 0; at < addresses.length; at += EMAIL_BCC_CHUNK) {
      try {
        await this.mailTurn();
      } catch (error) {
        // No turn, no pace to keep: this mail is not sent, and the next one asks for a turn of its own.
        this.logger.warn(`Email dispatch skipped [turn, ${error instanceof Error ? error.name : 'unknown'}]`);
        taken = false;
        continue;
      }
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
          signal: AbortSignal.timeout(this.emailTimeoutMs),
        });
        if (!response.ok) {
          this.logger.warn(`Email dispatch failed [status=${response.status}]`);
          taken = false;
        }
      } catch (error) {
        this.logger.warn(`Email dispatch failed [${isTimeoutError(error) ? `timeout ${this.emailTimeoutMs} ms` : 'network'}]`);
        taken = false;
      }
    }
    return taken;
  }
}
