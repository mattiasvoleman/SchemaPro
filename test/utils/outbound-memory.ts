import { randomUUID } from 'node:crypto';
import {
  QueueFullError,
  type NewNotice,
  type OutboundStore,
  type Plan,
  type QueuedNotice,
  type Step,
} from '../../src/notifications/notification-queue';

/**
 * The outgoing queue in memory, for the specs of what reads it: the same rules as the database's functions
 * (20270309090000) on plain arrays, so a spec can run two consumers on one queue, stop one in the middle and start another.
 * The database's own behaviour is held by the RLS suite and scripts/test/probe-utkorg.ts; this is only so the delivery's logic
 * (what it plans, in what order, what it counts and when it lets go) can be read without a database.
 */
export interface MemoryRow extends NewNotice {
  id: string;
  status: 'PENDING' | 'CLAIMED' | 'DONE' | 'GAVE_UP';
  claim: string | null;
  leaseUntil: number | null;
  notBefore: number;
  createdAt: number;
  attempts: number;
  plan: Plan | null;
  mailDone: number;
  pushDone: number;
  mailsSent: number;
  mailsFailed: number;
  pushSent: number;
  pushFailed: number;
}

export class MemoryOutbound implements OutboundStore {
  readonly rows: MemoryRow[] = [];
  /** The addresses of the people the delivery may mail; a person who is not here has none (or is gone). */
  readonly directory = new Map<string, string>();
  /** What `slot` answers, in order; then zero. A spec that tests pacing sets it. */
  slots: number[] = [];
  readonly slotCalls: Array<{ channel: string; intervalMs: number }> = [];
  /** A number to refuse enqueues with after (the full queue is 5,000). */
  limit = 5000;
  /** Throws on the next call of this name once (the database was not there). */
  failNext: string | null = null;
  private clock = 0;

  /** A moment that moves on every use, so rows made one after another are in order. */
  now(): number {
    return Date.now() + this.clock;
  }

  /** Moves the clock on: leases run out and a row handed back for a retry comes due. */
  forward(ms: number): void {
    this.clock += ms;
  }

  private gate(name: string): void {
    if (this.failNext === name) {
      this.failNext = null;
      throw new Error(`the database was not there (${name})`);
    }
  }

  async enqueue(notice: NewNotice): Promise<string> {
    this.gate('enqueue');
    if (this.rows.filter((row) => row.status === 'PENDING' || row.status === 'CLAIMED').length >= this.limit) throw new QueueFullError();
    const at = this.now();
    const row: MemoryRow = {
      ...structuredClone(notice),
      id: randomUUID(),
      status: 'PENDING',
      claim: null,
      leaseUntil: null,
      notBefore: at,
      createdAt: at,
      attempts: 0,
      plan: null,
      mailDone: 0,
      pushDone: 0,
      mailsSent: 0,
      mailsFailed: 0,
      pushSent: 0,
      pushFailed: 0,
    };
    this.rows.push(row);
    return row.id;
  }

  async claim(consumer: string, urgent: boolean, leaseMs: number): Promise<QueuedNotice | null> {
    this.gate('claim');
    const now = this.now();
    const due = this.rows
      .filter((row) => row.urgent === urgent && ((row.status === 'PENDING' && row.notBefore <= now) || (row.status === 'CLAIMED' && row.leaseUntil! < now)))
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!due) return null;
    due.status = 'CLAIMED';
    due.claim = `${consumer}/${randomUUID()}`;
    due.leaseUntil = now + leaseMs;
    due.attempts += 1;
    return {
      ...structuredClone({ schoolId: due.schoolId, urgent: due.urgent, entries: due.entries, recipientIds: due.recipientIds, notificationIds: due.notificationIds }),
      id: due.id,
      claim: due.claim,
      plan: structuredClone(due.plan),
      mailDone: due.mailDone,
      pushDone: due.pushDone,
      mailsFailed: due.mailsFailed,
      pushFailed: due.pushFailed,
      attempts: due.attempts,
      createdAt: new Date(due.createdAt),
    };
  }

  private held(notice: { id: string; claim: string }): MemoryRow | undefined {
    return this.rows.find((row) => row.id === notice.id && row.status === 'CLAIMED' && row.claim === notice.claim);
  }

  async plan(notice: Pick<QueuedNotice, 'id' | 'claim'>, plan: Plan, leaseMs: number): Promise<boolean> {
    this.gate('plan');
    const row = this.held(notice);
    if (!row || row.plan) return false;
    row.plan = structuredClone(plan);
    row.leaseUntil = this.now() + leaseMs;
    return true;
  }

  async advance(notice: Pick<QueuedNotice, 'id' | 'claim'>, step: Step, leaseMs: number): Promise<boolean> {
    this.gate('advance');
    const row = this.held(notice);
    if (!row) return false;
    row.mailDone = Math.max(row.mailDone, step.mailDone ?? 0);
    row.pushDone = Math.max(row.pushDone, step.pushDone ?? 0);
    row.mailsSent += Math.max(step.mailSent ?? 0, 0);
    row.mailsFailed += Math.max(step.mailFailed ?? 0, 0);
    row.pushSent += Math.max(step.pushSent ?? 0, 0);
    row.pushFailed += Math.max(step.pushFailed ?? 0, 0);
    row.leaseUntil = this.now() + leaseMs;
    return true;
  }

  async finish(notice: Pick<QueuedNotice, 'id' | 'claim'>, status: 'DONE'): Promise<boolean> {
    this.gate('finish');
    const row = this.held(notice);
    if (!row) return false;
    row.status = status;
    row.claim = null;
    row.leaseUntil = null;
    // What a finished row may not hold: the database's CHECK, here as a rule.
    row.entries = [];
    row.recipientIds = [];
    row.notificationIds = [];
    row.plan = null;
    return true;
  }

  async release(notice: Pick<QueuedNotice, 'id' | 'claim'>, delayMs: number): Promise<boolean> {
    this.gate('release');
    const row = this.held(notice);
    if (!row) return false;
    row.status = 'PENDING';
    row.claim = null;
    row.leaseUntil = null;
    row.notBefore = this.now() + delayMs;
    return true;
  }

  async slot(channel: 'EMAIL' | 'PUSH', intervalMs: number): Promise<number> {
    this.gate('slot');
    this.slotCalls.push({ channel, intervalMs });
    return this.slots.shift() ?? 0;
  }

  async sweep(): Promise<{ gaveUp: number; deleted: number }> {
    this.gate('sweep');
    return { gaveUp: 0, deleted: 0 };
  }

  async addresses(_schoolId: string, userIds: readonly string[]): Promise<Map<string, string>> {
    this.gate('addresses');
    const found = new Map<string, string>();
    for (const id of userIds) {
      const address = this.directory.get(id);
      if (address) found.set(id, address);
    }
    return found;
  }

  /** Rows by status, for what a spec says about the queue. */
  count(status: MemoryRow['status']): number {
    return this.rows.filter((row) => row.status === status).length;
  }
}
