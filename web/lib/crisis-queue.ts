import { ApiError } from "@/lib/api";
import type { MarkInput, MarkResult, MyCall, MyCrisisResponse, PupilView } from "@/lib/crisis-types";
import { MAX_MARKS_PER_CALL, countPupils } from "@/lib/crisis-view";

/*
 * THE TEACHER'S PAGE ON A BAD NETWORK (Krisläge).
 *
 * A teacher on a playground has a phone with one bar. Two things are kept in
 * localStorage so that the page works as well as it can: the last answer of
 * GET /crisis/mine (the groups and their pupils, shown again when the page is
 * opened or the signal is gone), and the marks the teacher has made that the
 * gateway has not yet acknowledged (the queue). A queued mark is shown as
 * "waiting" on its pupil until the gateway has answered it; the page sends the
 * queue when the network comes back (`online`), when the page gets focus, and
 * on a short timer.
 *
 * EVERY storage access is in a try/catch: a private window, blocked site data
 * or a full quota must leave the page working, just without memory.
 *
 * WHAT A FAILURE MEANS. A mark carries its own uuid, so sending it twice
 * stores it once (skipDuplicates in the gateway): a request whose answer was
 * lost is simply sent again. Only an answer from the gateway that says "no"
 * is permanent (400, 403, 404, 409: the alarm is over, the group is not yours,
 * the pupil is not on its list); a refusal to talk (no network, a timeout, 401
 * while the session wakes, 429, 5xx) is not, and the mark stays queued.
 */

export const QUEUE_KEY = "rastra.crisis.queue.v1";
export const SNAPSHOT_KEY = "rastra.crisis.mine.v1";
/** A list older than this is not shown as the truth about an alarm: it is hours since anyone was asked. */
export const SNAPSHOT_MAX_AGE_MS = 4 * 3_600_000;

/** The last answer of the gateway and the local time it came at (to tell how far apart the clocks are). */
export interface Snapshot {
  data: MyCrisisResponse;
  receivedAt: number;
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStore(): Store | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function read(key: string, store: Store | null): unknown {
  try {
    const raw = store?.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown | null, store: Store | null): boolean {
  try {
    if (!store) return false;
    if (value === null) store.removeItem(key);
    else store.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

function isMark(value: unknown): value is MarkInput {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.callId === "string" &&
    typeof value.studentId === "string" &&
    (value.state === "FOUND" || value.state === "MISSING") &&
    typeof value.at === "string" &&
    !Number.isNaN(Date.parse(value.at))
  );
}

/** The marks still to send, oldest first. Whatever in the storage is not a mark is left out. */
export function loadQueue(store: Store | null = defaultStore()): MarkInput[] {
  const stored = read(QUEUE_KEY, store);
  return Array.isArray(stored) ? stored.filter(isMark) : [];
}

export function saveQueue(queue: readonly MarkInput[], store: Store | null = defaultStore()): boolean {
  return write(QUEUE_KEY, queue.length === 0 ? null : queue, store);
}

function isSnapshot(value: unknown): value is Snapshot {
  return (
    isRecord(value) &&
    typeof value.receivedAt === "number" &&
    isRecord(value.data) &&
    typeof value.data.asOf === "string" &&
    Array.isArray(value.data.alarms)
  );
}

export function loadSnapshot(now: number, store: Store | null = defaultStore()): Snapshot | null {
  const stored = read(SNAPSHOT_KEY, store);
  if (!isSnapshot(stored)) return null;
  return now - stored.receivedAt > SNAPSHOT_MAX_AGE_MS || stored.receivedAt > now + 60_000 ? null : stored;
}

export function saveSnapshot(snapshot: Snapshot, store: Store | null = defaultStore()): boolean {
  return write(SNAPSHOT_KEY, snapshot, store);
}

/** How far the gateway's clock was from this device's when the list came: added to a mark's time. */
export const skewOf = (snapshot: Snapshot | null): number => (snapshot ? Date.parse(snapshot.data.asOf) - snapshot.receivedAt : 0);

/** The key a pupil in a group is waiting under. */
export const pendingKey = (callId: string, studentId: string): string => `${callId}:${studentId}`;

/**
 * The list as the teacher has left it: every queued mark laid over the
 * gateway's answer, the pupil it is for shown as that mark says and counted
 * so, and its key in `pending` so the page can say that it has not arrived.
 * A pupil with several queued marks takes the latest (by the time they were
 * made; the later one of two equal times).
 */
export function applyQueue(
  data: MyCrisisResponse,
  queue: readonly MarkInput[],
): { data: MyCrisisResponse; pending: Set<string> } {
  const latest = new Map<string, MarkInput>();
  for (const mark of queue) {
    const key = pendingKey(mark.callId, mark.studentId);
    const before = latest.get(key);
    if (!before || Date.parse(mark.at) >= Date.parse(before.at)) latest.set(key, mark);
  }
  if (latest.size === 0) return { data, pending: new Set() };
  const pending = new Set<string>();
  const alarms = data.alarms.map((alarm) => ({
    ...alarm,
    calls: alarm.calls.map((call): MyCall => {
      let touched = false;
      const pupils = call.pupils.map((pupil): PupilView => {
        const mark = latest.get(pendingKey(call.id, pupil.studentId));
        if (!mark) return pupil;
        touched = true;
        pending.add(pendingKey(call.id, pupil.studentId));
        return { ...pupil, status: mark.state, markedAt: mark.at };
      });
      return touched ? { ...call, pupils, counts: countPupils(pupils.map((pupil) => pupil.status)) } : call;
    }),
  }));
  return { data: { ...data, alarms }, pending };
}

export type Failure = { kind: "permanent"; code: string } | { kind: "transient" };

/** The statuses in which the gateway has answered "no" to the mark itself, and not to the way it was sent. */
const REFUSED = new Set([400, 403, 404, 409, 410, 413, 422]);

/** What a failed send means for the marks in it. */
export function classify(error: unknown): Failure {
  if (error instanceof ApiError && REFUSED.has(error.status)) return { kind: "permanent", code: error.code ?? `HTTP_${error.status}` };
  return { kind: "transient" };
}

/** The refusals that are about the whole group (its alarm is over, it is not the teacher's) and not about one pupil. */
const CALL_LEVEL = new Set(["CRISIS_ALARM_ENDED", "CRISIS_ALARM_NOT_FOUND", "CRISIS_NOT_YOURS"]);

/** A mark the gateway answered `unresolved`: it belongs to no alarm of the teacher's. */
export const UNRESOLVED = "CRISIS_MARK_UNRESOLVED";

export interface Dropped {
  mark: MarkInput;
  code: string;
}

export interface FlushResult {
  /** Acknowledged by the gateway (stored, or already there). */
  sent: MarkInput[];
  /** Refused for good: to be thrown away and told. */
  dropped: Dropped[];
  /** Still to send: the network did not answer. */
  unsent: MarkInput[];
}

type Send = (marks: MarkInput[]) => Promise<MarkResult>;

const empty = (): FlushResult => ({ sent: [], dropped: [], unsent: [] });

function join(...parts: FlushResult[]): FlushResult {
  return {
    sent: parts.flatMap((part) => part.sent),
    dropped: parts.flatMap((part) => part.dropped),
    unsent: parts.flatMap((part) => part.unsent),
  };
}

/**
 * Sends one batch, and what it learns of a refusal it uses.
 *
 * The gateway stores a batch in one transaction, so one mark it refuses (a
 * pupil who is not on the group's list) refuses the lot. The batch is then
 * halved until the refused marks are alone, and the others still arrive. A
 * refusal about the group as a whole (CALL_LEVEL) is not halved by mark but
 * split by group, and a group that is refused so is dropped whole. The first
 * time the network does not answer, nothing after it is tried.
 */
async function deliver(batch: MarkInput[], send: Send): Promise<FlushResult> {
  if (batch.length === 0) return empty();
  try {
    const result = await send(batch);
    const gone = new Set(result.unresolved);
    return {
      sent: batch.filter((mark) => !gone.has(mark.id)),
      dropped: batch.filter((mark) => gone.has(mark.id)).map((mark) => ({ mark, code: UNRESOLVED })),
      unsent: [],
    };
  } catch (error) {
    const failure = classify(error);
    if (failure.kind === "transient") return { sent: [], dropped: [], unsent: batch };
    if (batch.length === 1) return { sent: [], dropped: [{ mark: batch[0]!, code: failure.code }], unsent: [] };
    const calls = new Set(batch.map((mark) => mark.callId));
    if (CALL_LEVEL.has(failure.code)) {
      if (calls.size === 1) return { sent: [], dropped: batch.map((mark) => ({ mark, code: failure.code })), unsent: [] };
      return deliverInOrder([...calls].map((callId) => batch.filter((mark) => mark.callId === callId)), send);
    }
    const middle = Math.ceil(batch.length / 2);
    return deliverInOrder([batch.slice(0, middle), batch.slice(middle)], send);
  }
}

/** Batches one after another; once one is left unsent, the rest are too. */
async function deliverInOrder(batches: MarkInput[][], send: Send): Promise<FlushResult> {
  const results: FlushResult[] = [];
  let stalled = false;
  for (const batch of batches) {
    if (stalled) {
      results.push({ sent: [], dropped: [], unsent: batch });
      continue;
    }
    const result = await deliver(batch, send);
    stalled = result.unsent.length > 0;
    results.push(result);
  }
  return join(...results);
}

/** The whole queue, MAX_MARKS_PER_CALL at a time. */
export async function flushMarks(queue: readonly MarkInput[], send: Send): Promise<FlushResult> {
  const batches: MarkInput[][] = [];
  for (let at = 0; at < queue.length; at += MAX_MARKS_PER_CALL) batches.push(queue.slice(at, at + MAX_MARKS_PER_CALL));
  return deliverInOrder(batches, send);
}
