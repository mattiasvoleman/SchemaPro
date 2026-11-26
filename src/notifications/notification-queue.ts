import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import type { NotificationKind } from './notifications.service';

/**
 * The outgoing queue (OutboundNotices, 20270309090000): the one place the gateway speaks SQL to it. Every call is one
 * transaction of the delivery's door (PrismaService.withDeliveryService), which has no principal: the functions behind
 * it are job doors that refuse a login.
 *
 * A row is one lane's notices of one school from one committed transaction. A process takes it with a claim (a
 * consumer's name and a random number), and every later step must show the claim, so a process that stood still past its
 * lease and wakes up with an old one is told no (false) and stops. The queue's rules (lease, counters, emptying a
 * finished row) are the database's; this file only carries them.
 */

/** One notice-call of the row: its type and meta, how many of the row's recipients it has, and its mail if it has one. */
export interface StoredEntry {
  type: NotificationKind;
  meta: Record<string, unknown>;
  /** How many of the row's (recipientIds, notificationIds) are this entry's, in order. */
  n: number;
  email?: { subject: string; body: string };
}

/** What a new row holds. */
export interface NewNotice {
  schoolId: string;
  urgent: boolean;
  entries: StoredEntry[];
  recipientIds: string[];
  notificationIds: string[];
}

/** One mail packet: the entry whose subject and body it has, and the addresses on BCC. */
export interface PlannedMail {
  e: number;
  bcc: string[];
}

/** One device's push, written and addressed: the token's id and value, the title and body, the notice's id and type. */
export interface PlannedPush {
  t: string;
  to: string;
  ti: string;
  b: string;
  n: string;
  y: string;
}

/**
 * What a row sends, decided once: the sender's address, the mail packets (after opt-outs, 49 addresses each) and the
 * push packets (100 devices each). Frozen on the row at its first claim, so a retry sends the same packets, which is
 * what an idempotency key needs. Holds addresses and tokens, and goes with the row when it is finished.
 */
export interface Plan {
  from: string;
  mail: PlannedMail[];
  push: PlannedPush[][];
}

/** A claimed row. `claim` is what every later step shows. */
export interface QueuedNotice extends NewNotice {
  id: string;
  claim: string;
  plan: Plan | null;
  mailDone: number;
  pushDone: number;
  mailsFailed: number;
  pushFailed: number;
  attempts: number;
  createdAt: Date;
}

/** What a step adds: the packets begun or done, and the counts. */
export interface Step {
  mailDone?: number;
  pushDone?: number;
  mailSent?: number;
  mailFailed?: number;
  pushSent?: number;
  pushFailed?: number;
}

/** A queue that would not take a row because it holds 5,000 already (OB429). */
export class QueueFullError extends Error {
  constructor() {
    super('The outgoing queue is full');
    this.name = 'QueueFullError';
  }
}

/** The token the delivery asks for its queue by: the database's in the module, a spec's in memory in the e2e harness. */
export const OUTBOUND_STORE = Symbol('OUTBOUND_STORE');

/** What the delivery needs of the queue: the database's, or a spec's in memory. */
export interface OutboundStore {
  enqueue(notice: NewNotice): Promise<string>;
  claim(consumer: string, urgent: boolean, leaseMs: number): Promise<QueuedNotice | null>;
  plan(notice: Pick<QueuedNotice, 'id' | 'claim'>, plan: Plan, leaseMs: number): Promise<boolean>;
  advance(notice: Pick<QueuedNotice, 'id' | 'claim'>, step: Step, leaseMs: number): Promise<boolean>;
  finish(notice: Pick<QueuedNotice, 'id' | 'claim'>, status: 'DONE'): Promise<boolean>;
  release(notice: Pick<QueuedNotice, 'id' | 'claim'>, delayMs: number): Promise<boolean>;
  /** Milliseconds until the next mail (EMAIL) or push request (PUSH) may go, for the whole fleet. */
  slot(channel: 'EMAIL' | 'PUSH', intervalMs: number): Promise<number>;
  sweep(): Promise<{ gaveUp: number; deleted: number }>;
  /** The addresses of the active people among `userIds` who have one. */
  addresses(schoolId: string, userIds: readonly string[]): Promise<Map<string, string>>;
}

const seconds = (ms: number) => Math.max(0, ms) / 1000;

interface ClaimRow {
  notice_id: string;
  claim: string;
  school_id: string;
  urgent: boolean;
  entries: StoredEntry[];
  recipient_ids: string[];
  notification_ids: string[];
  plan: Plan | null;
  mail_done: number;
  push_done: number;
  mails_failed: number;
  push_failed: number;
  attempts: number;
  created_at: Date;
}

export class OutboundQueue implements OutboundStore {
  constructor(private readonly prisma: PrismaService) {}

  async enqueue(notice: NewNotice): Promise<string> {
    try {
      const [row] = await this.prisma.withDeliveryService((tx) =>
        tx.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`SELECT app.outbound_enqueue(${notice.schoolId}::uuid, ${notice.urgent}, ${JSON.stringify(notice.entries)}::jsonb,
                                                 ${notice.recipientIds}::uuid[], ${notice.notificationIds}::uuid[])::text AS id`,
        ),
      );
      return row!.id;
    } catch (error) {
      if (sqlStateOf(error) === 'OB429') throw new QueueFullError();
      throw error;
    }
  }

  async claim(consumer: string, urgent: boolean, leaseMs: number): Promise<QueuedNotice | null> {
    const rows = await this.prisma.withDeliveryService((tx) =>
      tx.$queryRaw<ClaimRow[]>(
        Prisma.sql`SELECT notice_id::text AS notice_id, claim, school_id::text AS school_id, urgent, entries,
                          recipient_ids::text[] AS recipient_ids, notification_ids::text[] AS notification_ids, plan,
                          mail_done, push_done, mails_failed, push_failed, attempts, created_at
                     FROM app.outbound_claim(${consumer}, ${urgent}, make_interval(secs => ${seconds(leaseMs)}::double precision))`,
      ),
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.notice_id,
      claim: row.claim,
      schoolId: row.school_id,
      urgent: row.urgent,
      entries: row.entries,
      recipientIds: row.recipient_ids,
      notificationIds: row.notification_ids,
      plan: row.plan,
      mailDone: row.mail_done,
      pushDone: row.push_done,
      mailsFailed: row.mails_failed,
      pushFailed: row.push_failed,
      attempts: row.attempts,
      createdAt: row.created_at,
    };
  }

  async plan(notice: Pick<QueuedNotice, 'id' | 'claim'>, plan: Plan, leaseMs: number): Promise<boolean> {
    return this.answer(
      (tx) =>
        tx.$queryRaw<Array<{ ok: boolean }>>(
          Prisma.sql`SELECT app.outbound_plan(${notice.id}::uuid, ${notice.claim}, ${JSON.stringify(plan)}::jsonb,
                                              make_interval(secs => ${seconds(leaseMs)}::double precision)) AS ok`,
        ),
    );
  }

  async advance(notice: Pick<QueuedNotice, 'id' | 'claim'>, step: Step, leaseMs: number): Promise<boolean> {
    return this.answer(
      (tx) =>
        tx.$queryRaw<Array<{ ok: boolean }>>(
          Prisma.sql`SELECT app.outbound_advance(${notice.id}::uuid, ${notice.claim}, make_interval(secs => ${seconds(leaseMs)}::double precision),
                                                 ${step.mailDone ?? 0}::integer, ${step.pushDone ?? 0}::integer,
                                                 ${step.mailSent ?? 0}::integer, ${step.mailFailed ?? 0}::integer,
                                                 ${step.pushSent ?? 0}::integer, ${step.pushFailed ?? 0}::integer) AS ok`,
        ),
    );
  }

  async finish(notice: Pick<QueuedNotice, 'id' | 'claim'>, status: 'DONE'): Promise<boolean> {
    return this.answer(
      (tx) =>
        tx.$queryRaw<Array<{ ok: boolean }>>(
          Prisma.sql`SELECT app.outbound_finish(${notice.id}::uuid, ${notice.claim}, ${status}, NULL) AS ok`,
        ),
    );
  }

  async release(notice: Pick<QueuedNotice, 'id' | 'claim'>, delayMs: number): Promise<boolean> {
    return this.answer(
      (tx) =>
        tx.$queryRaw<Array<{ ok: boolean }>>(
          Prisma.sql`SELECT app.outbound_release(${notice.id}::uuid, ${notice.claim}, make_interval(secs => ${seconds(delayMs)}::double precision)) AS ok`,
        ),
    );
  }

  async slot(channel: 'EMAIL' | 'PUSH', intervalMs: number): Promise<number> {
    const [row] = await this.prisma.withDeliveryService((tx) =>
      tx.$queryRaw<Array<{ wait: number }>>(Prisma.sql`SELECT app.outbound_slot(${channel}, ${Math.max(1, Math.round(intervalMs))}::integer) AS wait`),
    );
    return Number(row?.wait ?? 0);
  }

  async sweep(): Promise<{ gaveUp: number; deleted: number }> {
    const [row] = await this.prisma.withDeliveryService((tx) =>
      tx.$queryRaw<Array<{ gave_up: number; deleted: number }>>(Prisma.sql`SELECT gave_up, deleted FROM app.outbound_sweep()`),
    );
    return { gaveUp: Number(row?.gave_up ?? 0), deleted: Number(row?.deleted ?? 0) };
  }

  async addresses(schoolId: string, userIds: readonly string[]): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    // A whole-school digest is some 1,800 people: asked 500 at a time, like the opt-outs and the devices.
    for (let at = 0; at < userIds.length; at += 500) {
      const chunk = userIds.slice(at, at + 500);
      const rows = await this.prisma.withDeliveryService((tx) =>
        tx.$queryRaw<Array<{ user_id: string; email: string }>>(
          Prisma.sql`SELECT user_id::text AS user_id, email FROM app.outbound_addresses(${schoolId}::uuid, ${chunk}::uuid[])`,
        ),
      );
      for (const row of rows ?? []) found.set(row.user_id, row.email);
    }
    return found;
  }

  private async answer(call: (tx: Parameters<Parameters<PrismaService['withDeliveryService']>[0]>[0]) => Promise<Array<{ ok: boolean }>>): Promise<boolean> {
    const [row] = await this.prisma.withDeliveryService(call);
    return row?.ok === true;
  }
}

/** The SQLSTATE under a Prisma error, from the adapter's cause or the rendered message (as every module of the gateway reads it). */
export function sqlStateOf(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null;
  const cause = (error.meta as { driverAdapterError?: { cause?: { originalCode?: unknown } } } | undefined)?.driverAdapterError?.cause;
  if (typeof cause?.originalCode === 'string') return cause.originalCode;
  return /Code: `([0-9A-Z]{5})`/.exec(error.message)?.[1] ?? null;
}
