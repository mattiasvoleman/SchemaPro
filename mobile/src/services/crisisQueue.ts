import * as ExpoCrypto from 'expo-crypto';
import { ApiError } from './api';
import { SecureTokenStore } from './auth/secureTokenStore';
import { patchCachedCrisis } from './crisisCache';
import { MAX_MARKS_PER_CALL, isLocalCall, isTransportFailure, postMyMarks, type MyCall } from './crisis';
import {
  countPendingCrisisMarks,
  deleteCrisisMarks,
  enqueueCrisisMarks,
  getPendingCrisisMarks,
  incrementCrisisRetry,
  markCrisisMarksSynced,
  purgeSyncedCrisisMarks,
  whenDatabaseReady,
} from './database/localDatabase';
import { noNetwork } from './network/deviceOffline';
import { getAccessToken } from './supabase';
import type { PendingCrisisMark, PendingCrisisPupil, QueuedMarkState } from '../types';

/**
 * THE ROLL CALL'S OUTBOX (Krisläge, F2).
 *
 * Every tap is written to the encrypted database FIRST (crisis_queue) and is
 * only then sent. A teacher in a schoolyard with one bar of signal taps
 * "finns" on twenty pupils and the screen must show twenty pupils found at
 * once; the gateway hears of them when it can. Nothing here waits for the
 * network, and nothing is lost to it.
 *
 * WHEN IT IS SENT. After every tap (queueCrisisMarks), at start and when the
 * app returns to the front, when the network comes back, and on a short timer
 * while the roll call is on screen (services' callers: context/SyncContext.tsx
 * and hooks/useCrisis.ts). They all call flushCrisisQueue, which is
 * single-flight: one pass at a time, and a tap that arrives while a pass is in
 * the air makes one more pass after it rather than wait for the next timer.
 * This is the attendance queue's pattern (sync/attendance_sync_worker.ts) with
 * its two differences spelled out below.
 *
 * WHOSE. The signed-in teacher's rows only: a tablet is shared, the gateway
 * stamps the sender from the bearer, and a colleague's marks sent under this
 * teacher's token would be signed by someone who was never there. That holds for
 * every mark, whether it names a call, a lesson or (a teacher with no group who
 * found a pupil) the alarm, and for a taking-back (RETRACTED) as for a found.
 *
 * WHAT A FAILURE MEANS. The gateway's answer decides, and a mark is never
 * dropped for a reason that is only about the network or about a moment:
 *   * FINAL, and only these four, by status AND code (crisis.service.ts):
 *     409 CRISIS_ALARM_ENDED (an hour after the end), 404 CRISIS_ALARM_NOT_FOUND,
 *     403 CRISIS_NOT_YOURS, 400 CRISIS_MARK_INVALID (a mark the group cannot
 *     take: a pupil it will not hold, MISSING for a pupil who is not on the
 *     list, a taking-back (RETRACTED) with nothing of the teacher's to take back,
 *     or "not in the building", which only the administration may say; the app
 *     sends none of the last three on purpose). The marks cannot be taken, now
 *     or ever: they are deleted and counted, and the screen says so. The
 *     web's queue (web/lib/crisis-queue.ts) is to classify 404 and 409 the
 *     same way, so that the two never disagree about a mark;
 *   * everything else is KEPT and sent again: no answer, 5xx, 408, 401 (the
 *     next pass renews the sign-in), a 404 or 409 WITHOUT one of those codes (a
 *     gateway without the route; a 409 WRITE_CONFLICT, which the gateway
 *     answers when two requests deadlocked and the next one goes through);
 *   * 429: the pass stops and waits (WAIT_MS) before trying again.
 * A 400 or 403 without a code, and a 410, 413 or 422, are the gateway refusing
 * the request itself (a body it will not read, a role that is gone): the same
 * call would be refused again and, kept, would hold every mark behind it, so
 * they are dropped as the four are.
 * The first difference from attendance: the gateway answers a whole call with
 * one status, so one refused mark in a call of four hundred refuses all of
 * them. A permanent refusal therefore HALVES the call and sends the halves on
 * their own, down to the single mark, so that the mark that is wrong is
 * dropped and the three hundred and ninety-nine that are right are not. The
 * second: every tap is sent, not only a pupil's latest, because the protocol
 * of an alarm is the timeline of every mark.
 *
 * IDEMPOTENT. A mark's id is the phone's own (a uuid made at the tap), and the
 * gateway stores an id once, so a pass that sent a call and lost the answer
 * sends it again without harm.
 */

/** How long a pass waits after a 429 before trying again. */
const WAIT_MS = 15_000;
/** A request that has not answered by then is a network that is not there. */
const REQUEST_TIMEOUT_MS = 15_000;
/** Requests one pass may spend on halving calls, so that a call full of refusals cannot hold the pass for minutes. */
const REQUEST_BUDGET = 60;
/** Sent rows are kept this long, to be read as sent, and then go. */
const KEEP_SENT_MS = 24 * 3_600_000;

/** Why marks were dropped: the screen says it in the teacher's language. */
export type DropReason = 'ENDED' | 'NOT_FOUND' | 'NOT_YOURS' | 'INVALID' | 'UNRESOLVED';

export interface Dropped {
  readonly reason: DropReason;
  readonly count: number;
}

export type Stopped = 'DONE' | 'NO_SESSION' | 'OFFLINE' | 'RETRY' | 'WAIT' | 'BUDGET';

export interface FlushResult {
  /** The marks the gateway took in this flush (stored, or already held). */
  readonly sent: readonly PendingCrisisMark[];
  readonly dropped: readonly Dropped[];
  /** Marks this teacher still has to send. */
  readonly remaining: number;
  readonly stopped: Stopped;
}

export type Failure =
  | { readonly kind: 'RETRY'; readonly answered: boolean }
  | { readonly kind: 'WAIT' }
  | { readonly kind: 'PERMANENT'; readonly reason: DropReason };

/** The gateway's own refusals of a mark: the status and the code that together make a refusal final. */
const FINAL: Readonly<Record<string, { readonly status: number; readonly reason: DropReason }>> = {
  CRISIS_ALARM_ENDED: { status: 409, reason: 'ENDED' },
  CRISIS_ALARM_NOT_FOUND: { status: 404, reason: 'NOT_FOUND' },
  CRISIS_NOT_YOURS: { status: 403, reason: 'NOT_YOURS' },
  CRISIS_MARK_INVALID: { status: 400, reason: 'INVALID' },
};

/** What a failed call means for the marks in it. See the header. */
export function classifyFailure(error: unknown): Failure {
  if (!(error instanceof ApiError)) return { kind: 'RETRY', answered: false };
  const { status, code } = error;
  if (status === 429) return { kind: 'WAIT' };
  const final = code ? FINAL[code] : undefined;
  if (final && final.status === status) return { kind: 'PERMANENT', reason: final.reason };
  // 401 renews with the next pass, 408 and 5xx are the network or the server, and a 404 or 409 that
  // is none of the codes above (WRITE_CONFLICT among them) is not about the marks themselves.
  if (status === 403) return { kind: 'PERMANENT', reason: 'NOT_YOURS' };
  if (status >= 400 && status < 500 && ![401, 404, 408, 409].includes(status)) return { kind: 'PERMANENT', reason: 'INVALID' };
  return { kind: 'RETRY', answered: status > 0 };
}

// ─── Events and what the screen has not yet been told ─────────────────────────

export type QueueEvent = { readonly type: 'ENQUEUED' } | { readonly type: 'FLUSHED'; readonly result: FlushResult };

const listeners = new Set<(event: QueueEvent) => void>();
const unseen = new Map<DropReason, number>();

function emit(event: QueueEvent): void {
  for (const listener of [...listeners]) listener(event);
}

/** The roll call on screen hears of a tap and of a flush, to show what is waiting and what was taken. */
export function subscribeCrisisQueue(listener: (event: QueueEvent) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Marks dropped since the last call. A flush can happen while the screen is not
 * mounted (the app's own timer), and the teacher must still be told when they
 * open it: so drops are kept here until someone takes them.
 */
export function takeUnseenDrops(): Dropped[] {
  const taken = [...unseen].map(([reason, count]) => ({ reason, count }));
  unseen.clear();
  return taken;
}

// ─── Writing ─────────────────────────────────────────────────────────────────

/**
 * A tap as a row. A mark on a list the gateway gave names the call; on a list
 * the phone built it names the lesson, and the gateway finds its call by the
 * alarm that was going at `at`; for a teacher with no group right now who found
 * a pupil it names the alarm itself (`alarmId` in place of `call`). `notBefore`
 * (the time of the push that began the alarm, which comes from the push
 * service's clock) keeps a phone whose clock trails from timing a mark before the
 * alarm it belongs to. `pupil` is the name and class of a pupil picked in the
 * search for "found with me", so that the pending row can name them until the
 * gateway has the mark.
 */
export function newCrisisMark(args: {
  readonly call?: Pick<MyCall, 'id' | 'lessonId'>;
  readonly alarmId?: string;
  readonly studentId: string;
  readonly state: QueuedMarkState;
  readonly teacherId: string;
  readonly pupil?: PendingCrisisPupil;
  readonly notBefore?: number | null;
  readonly now?: number;
}): Omit<PendingCrisisMark, 'retryCount'> {
  const now = args.now ?? Date.now();
  if (!args.call === !args.alarmId) throw new Error('A mark names a call or an alarm, and one of them.');
  const local = args.call ? isLocalCall(args.call) : false;
  return {
    id: ExpoCrypto.randomUUID(),
    callId: args.call && !local ? args.call.id : null,
    lessonId: args.call && local ? args.call.lessonId : null,
    alarmId: args.alarmId ?? null,
    studentId: args.studentId,
    state: args.state,
    // Only a mark by lesson is resolved by its time; a mark by call or by alarm needs no clamp.
    at: new Date(local ? Math.max(now, args.notBefore ?? 0) : now).toISOString(),
    teacherId: args.teacherId,
    ...(args.pupil ? { pupil: args.pupil } : {}),
  };
}

/** Writes the taps to the queue (all or none), then sends. The write is what the teacher is told succeeded. */
export async function queueCrisisMarks(marks: readonly Omit<PendingCrisisMark, 'retryCount'>[]): Promise<void> {
  await enqueueCrisisMarks(marks);
  emit({ type: 'ENQUEUED' });
  void flushCrisisQueue();
}

/**
 * Takes back a "found with me" that has not left the phone: the unsent marks for the pupil on that
 * group (the found, and any taking-back already queued) are deleted, and nothing is sent about them.
 * False when there is nothing to delete, or when a pass is in the air, which may have sent the found
 * mark already: the taking-back is then a mark of its own, sent after it. Only for a pupil the gateway
 * does not hold as found here; for one it holds, a RETRACTED mark is what takes them back.
 */
export async function cancelQueuedFound(
  teacherId: string,
  group: { readonly callId: string } | { readonly alarmId: string },
  studentId: string,
): Promise<boolean> {
  if (running) return false;
  await whenDatabaseReady();
  const rows = (await getPendingCrisisMarks(teacherId)).filter(
    (row) => row.studentId === studentId && ('callId' in group ? row.callId === group.callId : row.alarmId === group.alarmId),
  );
  if (rows.length === 0) return false;
  await deleteCrisisMarks(rows.map((row) => row.id));
  emit({ type: 'ENQUEUED' });
  return true;
}

// ─── Sending ─────────────────────────────────────────────────────────────────

let running: Promise<FlushResult> | null = null;
let again = false;
let pausedUntil = 0;

/**
 * Sends what this teacher has queued. Never throws: a pass that fails says why
 * in its result and the marks stay.
 */
export function flushCrisisQueue(): Promise<FlushResult> {
  if (running) {
    again = true;
    return running;
  }
  running = (async (): Promise<FlushResult> => {
    let total: FlushResult = { sent: [], dropped: [], remaining: 0, stopped: 'DONE' };
    try {
      do {
        again = false;
        total = merge(total, await pass());
      } while (again && total.stopped === 'DONE');
    } catch {
      // A database that is not open yet, a sign-in that could not be read: the marks are where they were.
      total = { ...total, stopped: 'RETRY' };
    } finally {
      again = false;
      running = null;
    }
    emit({ type: 'FLUSHED', result: total });
    return total;
  })();
  return running;
}

function merge(a: FlushResult, b: FlushResult): FlushResult {
  const dropped = new Map<DropReason, number>();
  for (const d of [...a.dropped, ...b.dropped]) dropped.set(d.reason, (dropped.get(d.reason) ?? 0) + d.count);
  return {
    sent: [...a.sent, ...b.sent],
    dropped: [...dropped].map(([reason, count]) => ({ reason, count })),
    remaining: b.remaining,
    stopped: b.stopped,
  };
}

interface Pass {
  readonly sent: PendingCrisisMark[];
  readonly dropped: Map<DropReason, number>;
  budget: number;
  stop: Exclude<Stopped, 'DONE' | 'NO_SESSION' | 'OFFLINE'> | null;
}

async function pass(): Promise<FlushResult> {
  const nothing = (stopped: Stopped, remaining = 0): FlushResult => ({ sent: [], dropped: [], remaining, stopped });
  const session = await SecureTokenStore.getTeacherSession();
  if (!session) return nothing('NO_SESSION');
  const teacherId = session.teacherId;

  await whenDatabaseReady();
  const queued = await getPendingCrisisMarks(teacherId);
  if (queued.length === 0) return nothing('DONE');
  if (Date.now() < pausedUntil) return nothing('WAIT', queued.length);
  if (await noNetwork()) return nothing('OFFLINE', queued.length);
  const token = await getAccessToken();
  if (!token) return nothing('RETRY', queued.length);

  const state: Pass = { sent: [], dropped: new Map(), budget: REQUEST_BUDGET, stop: null };
  for (let from = 0; from < queued.length && !state.stop; from += MAX_MARKS_PER_CALL) {
    await send(queued.slice(from, from + MAX_MARKS_PER_CALL), token, state);
  }

  if (state.sent.length > 0) await patchCachedCrisis(teacherId, state.sent).catch(() => undefined);
  await purgeSyncedCrisisMarks(new Date(Date.now() - KEEP_SENT_MS).toISOString()).catch(() => undefined);
  const dropped = [...state.dropped].map(([reason, count]) => ({ reason, count }));
  for (const d of dropped) unseen.set(d.reason, (unseen.get(d.reason) ?? 0) + d.count);
  return {
    sent: state.sent,
    dropped,
    remaining: await countPendingCrisisMarks(teacherId),
    stopped: state.stop ?? 'DONE',
  };
}

/** One call, and, when the gateway refuses it for good, its two halves. */
async function send(rows: readonly PendingCrisisMark[], token: string, state: Pass): Promise<void> {
  if (state.stop || rows.length === 0) return;
  if (state.budget <= 0) {
    state.stop = 'BUDGET';
    return;
  }
  state.budget--;
  const ids = rows.map((row) => row.id);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const answer = await postMyMarks(rows, { token, signal: controller.signal });
    clearTimeout(timer);
    // Stored and already-held alike are taken. Unresolved belong to no alarm of
    // this teacher's and never will: they are dropped, not kept for ever.
    const unresolved = new Set(answer.unresolved);
    const taken = rows.filter((row) => !unresolved.has(row.id));
    await markCrisisMarksSynced(taken.map((row) => row.id));
    state.sent.push(...taken);
    if (unresolved.size > 0) {
      await deleteCrisisMarks([...unresolved]);
      drop(state, 'UNRESOLVED', unresolved.size);
    }
  } catch (error) {
    clearTimeout(timer);
    const failure = isTransportFailure(error) ? ({ kind: 'RETRY', answered: false } as const) : classifyFailure(error);
    if (failure.kind === 'WAIT') {
      pausedUntil = Date.now() + WAIT_MS;
      state.stop = 'WAIT';
    } else if (failure.kind === 'RETRY') {
      if (failure.answered) await incrementCrisisRetry(ids).catch(() => undefined);
      state.stop = 'RETRY';
    } else if (rows.length === 1) {
      await deleteCrisisMarks(ids);
      drop(state, failure.reason, 1);
    } else {
      const half = Math.ceil(rows.length / 2);
      await send(rows.slice(0, half), token, state);
      await send(rows.slice(half), token, state);
    }
  }
}

function drop(state: Pass, reason: DropReason, count: number): void {
  state.dropped.set(reason, (state.dropped.get(reason) ?? 0) + count);
}

/** For tests: forget a pause and a pass in flight. */
export function resetCrisisQueueForTests(): void {
  running = null;
  again = false;
  pausedUntil = 0;
  unseen.clear();
  listeners.clear();
}
