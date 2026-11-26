import { SEND_CHUNK } from './expo-push.client';
import type { Plan, PlannedMail, PlannedPush, QueuedNotice } from './notification-queue';
import { RECIPIENT_CHUNK } from './notification-outbox';
import { NEVER_PUSHED, deliveredRegardless } from './notification-types';
import type { NotificationKind } from './notifications.service';
import { pushKindOf, pushText, type PushKind, type PushLocale } from './push-messages';

/**
 * What a queued row sends, worked out once when the row is first claimed and then frozen on it (QueuedNotice.plan).
 * Everything that depends on the day's state of the world is read here and nowhere after: who has an address and has
 * not opted out, which devices are live and in what language, the text of each push. A retry, on the same process or
 * another, sends this plan's packets and reads none of it again, so a packet is the same packet each time it is tried.
 */

/**
 * Addresses per mail. Resend documents 50 recipients for `to`, and nothing
 * larger for a mail as a whole, so a mail holds 50: the sender's own address
 * as `to` and 49 on BCC. A whole-school digest of some 1,800 people is about
 * 37 mails, never one.
 */
export const EMAIL_BCC_CHUNK = 49;

/** A push lives a day: a notice about today's lessons is no use tomorrow. */
export const PUSH_TTL_SECONDS = 86_400;
/**
 * An alarm (and its end) is told like an alarm: sent with high priority on a channel of its own that the phone
 * rings on, and not kept longer than it is true. A phone that was off for an hour must not get "Ett larm pågår"
 * for an alarm that ended before it came back; the app also asks the gateway before it shows a list.
 */
export const URGENT_PUSH_TTL_SECONDS = 600;
export const URGENT_PUSH_CHANNEL = 'crisis';
export const URGENT_PUSH_TYPES: ReadonlySet<string> = new Set(['CRISIS_ALARM', 'CRISIS_ENDED']);

/** A live device of one of the people asked about (app.push_targets). */
export interface PushTarget {
  token_id: string;
  user_id: string;
  token: string;
  locale: string;
  timezone: string;
}

/** What planning reads from the database. */
export interface PlanSources {
  /** Who of `userIds` said no to `type` outside the app (NotificationOptOuts). */
  optOuts(schoolId: string, userIds: string[], type: NotificationKind): Promise<Set<string>>;
  /** The addresses of the active people among `userIds` who have one. */
  addresses(schoolId: string, userIds: readonly string[]): Promise<Map<string, string>>;
  /** The live devices of `userIds`, minus opt-outs unless `required`. */
  pushTargets(schoolId: string, userIds: string[], type: NotificationKind, required: boolean): Promise<PushTarget[]>;
}

/** What may be sent this time: Resend's key and Expo are what the environment says now. */
export interface Channels {
  mail: boolean;
  push: boolean;
  from: string;
}

/** The row's entries with their recipients cut out of the flattened arrays. */
export function entriesOf(row: Pick<QueuedNotice, 'entries' | 'recipientIds' | 'notificationIds'>) {
  let at = 0;
  return row.entries.map((entry) => {
    const recipients = row.recipientIds.slice(at, at + entry.n).map((userId, i) => ({ userId, notificationId: row.notificationIds[at + i]! }));
    at += entry.n;
    return { type: entry.type, meta: entry.meta, email: entry.email, recipients };
  });
}

/** One person's notices of one kind in one transaction: one push. */
interface PushNotice {
  userId: string;
  type: NotificationKind;
  kind: PushKind;
  meta: Record<string, unknown>;
  notificationId: string;
  count: number;
  required: boolean;
}

export async function planNotice(row: QueuedNotice, channels: Channels, sources: PlanSources): Promise<Plan> {
  const entries = entriesOf(row);
  const mail = channels.mail ? await planMail(row.schoolId, entries, sources) : [];
  const push = channels.push ? await planPush(row.schoolId, entries, sources) : [];
  return { from: channels.from, mail, push };
}

/**
 * The mail of each entry: its caller's subject and body, unchanged, to the people the entry names who have an address,
 * minus the recipients who opted out of the type (NotificationOptOuts) — except for the notices the school must deliver
 * (deliveredRegardless) — in packets of EMAIL_BCC_CHUNK addresses. TEACHER_ABSENCE_REPORTED never leaves the inbox.
 */
async function planMail(schoolId: string, entries: ReturnType<typeof entriesOf>, sources: PlanSources): Promise<PlannedMail[]> {
  const packets: PlannedMail[] = [];
  for (const [e, entry] of entries.entries()) {
    if (!entry.email) continue;
    const ids = [...new Set(entry.recipients.map((r) => r.userId))];
    const addresses = await sources.addresses(schoolId, ids);
    const withAddress = ids.filter((id) => addresses.has(id));
    if (withAddress.length === 0) continue;
    const optedOut = deliveredRegardless(entry.type, entry.meta) ? new Set<string>() : await sources.optOuts(schoolId, withAddress, entry.type);
    // One address once, whoever shares it (a guardian's two children's mails go to one box, not two).
    const seen = new Set<string>();
    const bcc: string[] = [];
    for (const id of withAddress) {
      if (optedOut.has(id)) continue;
      const address = addresses.get(id)!;
      const key = address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      bcc.push(address);
    }
    for (let at = 0; at < bcc.length; at += EMAIL_BCC_CHUNK) packets.push({ e, bcc: bcc.slice(at, at + EMAIL_BCC_CHUNK) });
  }
  return packets;
}

/**
 * The push of the row, as the delivery has always made it:
 *   1. One push per person and kind per transaction: a person with three cancelled lessons gets "3 lektioner är inställda." (C2).
 *   2. app.push_targets gives each person's live tokens, minus opt-outs unless the notice is one the school must
 *      deliver, with the school's timezone.
 *   3. Each message is written in its device's language with the templates of push-messages.ts: no name, no free text,
 *      no subject, group or room.
 * Cut into packets of SEND_CHUNK, which is what Expo takes in one request.
 */
async function planPush(schoolId: string, entries: ReturnType<typeof entriesOf>, sources: PlanSources): Promise<PlannedPush[][]> {
  const notices = new Map<string, PushNotice>();
  for (const entry of entries) {
    const kind = pushKindOf(entry.type, entry.meta);
    if (!kind || NEVER_PUSHED.has(entry.type)) continue;
    const required = deliveredRegardless(entry.type, entry.meta);
    for (const recipient of entry.recipients) {
      const key = `${recipient.userId}|${kind}`;
      const seen = notices.get(key);
      if (seen) {
        seen.count++;
        continue;
      }
      notices.set(key, { userId: recipient.userId, type: entry.type, kind, meta: entry.meta, notificationId: recipient.notificationId, count: 1, required });
    }
  }

  // The people to ask about, per type and whether opt-outs count.
  const groups = new Map<string, PushNotice[]>();
  for (const notice of notices.values()) {
    const key = `${notice.type}|${notice.required}`;
    const group = groups.get(key);
    if (group) group.push(notice);
    else groups.set(key, [notice]);
  }

  const messages: PlannedPush[] = [];
  for (const group of groups.values()) {
    const { type, required } = group[0]!;
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
      targets.push(...(await sources.pushTargets(schoolId, people.slice(at, at + RECIPIENT_CHUNK), type, required)));
    }
    for (const target of targets) {
      const locale: PushLocale = target.locale === 'en' ? 'en' : 'sv';
      for (const notice of noticesOf.get(target.user_id) ?? []) {
        const text = pushText(notice.kind, notice.meta, locale, target.timezone, notice.count);
        messages.push({ t: target.token_id, to: target.token, ti: text.title, b: text.body, n: notice.notificationId, y: notice.type });
      }
    }
  }

  const packets: PlannedPush[][] = [];
  for (let at = 0; at < messages.length; at += SEND_CHUNK) packets.push(messages.slice(at, at + SEND_CHUNK));
  return packets;
}
