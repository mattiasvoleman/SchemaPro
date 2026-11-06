import { ApiError } from "@/lib/api";
import { CRISIS_STORAGE_PREFIX } from "@/lib/crisis-storage";
import type { FoundHereView, MarkResult, MyAlarm, MyCall, MyCrisisResponse, PupilName, PupilView, QueuedMark } from "@/lib/crisis-types";
import { MAX_MARKS_PER_CALL, countPupils, targetOf } from "@/lib/crisis-view";

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
 * WHOSE. The device may be shared: one browser, one teacher after another.
 * Both keys carry the id of the signed-in profile, a login reads and sends
 * only its own, and signing out wipes every login's
 * (lib/crisis-storage.ts clearCrisisStorage). A mark sent under another
 * teacher's token would be signed by someone who was never there, and the
 * list holds the names of every pupil of the school.
 *
 * WHAT A FAILURE MEANS. A mark carries its own uuid, so sending it twice
 * stores it once (skipDuplicates in the gateway): a request whose answer was
 * lost is simply sent again. Only an answer from the gateway that says "no"
 * to the mark itself is permanent (400, 403: the group is not yours, the
 * pupil may not be marked so; 404 CRISIS_ALARM_NOT_FOUND and 409
 * CRISIS_ALARM_ENDED: the alarm is gone or over); a refusal to talk (no
 * network, a timeout, 401 while the session wakes, 429, 5xx) is not, and the
 * mark stays queued. Neither is a 404 or a 409 without those codes: a
 * deadlock the gateway lost answers 409 WRITE_CONFLICT and the same mark
 * goes through on the next try. The phone's queue (mobile/src/services/
 * crisisQueue.ts classifyFailure) draws the line in the same place.
 */

/** The prefix of every key, whoever it is kept for; the ids follow after a colon. */
const QUEUE_PREFIX = `${CRISIS_STORAGE_PREFIX}queue.v2:`;
const SNAPSHOT_PREFIX = `${CRISIS_STORAGE_PREFIX}mine.v2:`;
export const queueKey = (userId: string): string => `${QUEUE_PREFIX}${userId}`;
export const snapshotKey = (userId: string): string => `${SNAPSHOT_PREFIX}${userId}`;
/** The keys of the first version, which had no user in them: whatever is under them is nobody's, and is removed when seen. */
export const LEGACY_KEYS = [`${CRISIS_STORAGE_PREFIX}queue.v1`, `${CRISIS_STORAGE_PREFIX}mine.v1`] as const;
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

/** Removes the keys of the first version, which nobody can own. */
export function forgetLegacy(store: Store | null = defaultStore()): void {
  for (const key of LEGACY_KEYS) write(key, null, store);
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

const isName = (value: unknown): value is PupilName =>
  isRecord(value) &&
  typeof value.firstName === "string" &&
  typeof value.lastName === "string" &&
  (value.className === null || typeof value.className === "string");

/** A mark names its group, or (a teacher with no group) the alarm: one of the two. */
function isMark(value: unknown): value is QueuedMark {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (typeof value.callId === "string") !== (typeof value.alarmId === "string") &&
    typeof value.studentId === "string" &&
    (value.state === "FOUND" || value.state === "MISSING" || value.state === "AWAY" || value.state === "RETRACTED") &&
    typeof value.at === "string" &&
    !Number.isNaN(Date.parse(value.at)) &&
    (value.pupil === undefined || isName(value.pupil))
  );
}

/** The marks this login still has to send, oldest first. Whatever in the storage is not a mark is left out. */
export function loadQueue(userId: string, store: Store | null = defaultStore()): QueuedMark[] {
  const stored = read(queueKey(userId), store);
  return Array.isArray(stored) ? stored.filter(isMark) : [];
}

export function saveQueue(userId: string, queue: readonly QueuedMark[], store: Store | null = defaultStore()): boolean {
  return write(queueKey(userId), queue.length === 0 ? null : queue, store);
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

/**
 * The list as it is kept: what the gateway gave this teacher, and no roster. A list of the school's
 * other pupils (`others`, which an earlier version of this page held for the picker, and which the
 * gateway no longer sends) is never written to the device nor read back from it: the names of a
 * whole school do not belong in plain text in a browser.
 */
function withoutRoster(snapshot: Snapshot): Snapshot {
  if (!snapshot.data.alarms.some((alarm) => "others" in alarm)) return snapshot;
  const alarms = snapshot.data.alarms.map((alarm) => {
    const { others: _roster, ...rest } = alarm as MyAlarm & { others?: unknown };
    return rest;
  });
  return { ...snapshot, data: { ...snapshot.data, alarms } };
}

export function loadSnapshot(userId: string, now: number, store: Store | null = defaultStore()): Snapshot | null {
  const stored = read(snapshotKey(userId), store);
  if (!isSnapshot(stored)) return null;
  return now - stored.receivedAt > SNAPSHOT_MAX_AGE_MS || stored.receivedAt > now + 60_000 ? null : withoutRoster(stored);
}

export function saveSnapshot(userId: string, snapshot: Snapshot, store: Store | null = defaultStore()): boolean {
  return write(snapshotKey(userId), withoutRoster(snapshot), store);
}

/** How far the gateway's clock was from this device's when the list came: added to a mark's time. */
export const skewOf = (snapshot: Snapshot | null): number => (snapshot ? Date.parse(snapshot.data.asOf) - snapshot.receivedAt : 0);

/** The key a pupil is waiting under: in a group, or (a teacher with no group) in the alarm. */
export const pendingKey = (target: string, studentId: string): string => `${target}:${studentId}`;

/**
 * The pupils a teacher found who are on none of the list at hand (`kept`: what the gateway has, in the
 * group's `foundHere` or the alarm's `foundFree`), with the queue laid over them: a queued FOUND adds the
 * pupil, by the name and class the mark carries, a queued RETRACTED takes them away. Whatever is not about
 * `target` is left alone. Returns `kept` itself when the queue changes nothing.
 */
function foundAmong(
  kept: readonly FoundHereView[],
  target: string,
  latest: ReadonlyMap<string, QueuedMark>,
  pending: Set<string>,
  listed?: ReadonlySet<string>,
): readonly FoundHereView[] {
  let next = kept;
  for (const mark of latest.values()) {
    if (targetOf(mark) !== target || listed?.has(mark.studentId)) continue;
    if (mark.state === "RETRACTED") {
      next = next.filter((one) => one.studentId !== mark.studentId);
    } else if (mark.state === "FOUND" && mark.pupil) {
      pending.add(pendingKey(target, mark.studentId));
      if (!next.some((one) => one.studentId === mark.studentId)) next = [...next, { studentId: mark.studentId, ...mark.pupil, markedAt: mark.at }];
    }
  }
  return next;
}

/**
 * The list as the teacher has left it: every queued mark laid over the
 * gateway's answer, the pupil it is for shown as that mark says and counted
 * so, and its key in `pending` so the page can say that it has not arrived.
 * A pupil with several queued marks takes the latest (by the time they were
 * made; the later one of two equal times).
 *
 * A FOUND mark for a pupil who is not on the call's list is a pupil the
 * teacher found who stands elsewhere ("found with me"): the pupil is
 * added to the call's `foundHere`, or (a mark made with no group, by the
 * alarm) to the alarm's `foundFree`, waiting like the other marks, by the
 * name and class the mark itself carries, so that no roster of the school's
 * pupils is needed to draw the row, and counted nowhere on this page (the
 * count is of the pupil's own list). A RETRACTED mark takes such a pupil away
 * again. The gateway refuses MISSING for a pupil who is not on the list, so
 * the page never queues one and none is shown here.
 */
export function applyQueue(
  data: MyCrisisResponse,
  queue: readonly QueuedMark[],
): { data: MyCrisisResponse; pending: Set<string> } {
  const latest = new Map<string, QueuedMark>();
  for (const mark of queue) {
    const key = pendingKey(targetOf(mark), mark.studentId);
    const before = latest.get(key);
    if (!before || Date.parse(mark.at) >= Date.parse(before.at)) latest.set(key, mark);
  }
  if (latest.size === 0) return { data, pending: new Set() };
  const pending = new Set<string>();
  const alarms = data.alarms.map((alarm): MyAlarm => ({
    ...alarm,
    calls: alarm.calls.map((call): MyCall => {
      let touched = false;
      const listed = new Set<string>();
      const pupils = call.pupils.map((pupil): PupilView => {
        listed.add(pupil.studentId);
        const mark = latest.get(pendingKey(call.id, pupil.studentId));
        // A retraction is of a find elsewhere, never of a pupil on the list.
        if (!mark || mark.state === "RETRACTED") return pupil;
        touched = true;
        pending.add(pendingKey(call.id, pupil.studentId));
        return { ...pupil, status: mark.state, markedAt: mark.at };
      });
      const kept = call.foundHere ?? [];
      const found = foundAmong(kept, call.id, latest, pending, listed);
      if (found !== kept) return { ...call, pupils, foundHere: [...found], counts: countPupils(pupils.map((pupil) => pupil.status)) };
      return touched ? { ...call, pupils, counts: countPupils(pupils.map((pupil) => pupil.status)) } : call;
    }),
    foundFree: [...foundAmong(alarm.foundFree ?? [], alarm.id, latest, pending)],
  }));
  return { data: { ...data, alarms }, pending };
}

export type Failure = { kind: "permanent"; code: string } | { kind: "transient" };

/** The statuses in which the gateway has answered "no" to the mark itself, whatever it says in the body. */
const REFUSED = new Set([400, 403, 410, 413, 422]);

/**
 * A 404 and a 409 are final only with the code that says the alarm is gone or over. Without it they
 * are the way the mark was sent, not the mark: a gateway without the route, a proxy, a deadlock lost
 * (409 WRITE_CONFLICT). Such a mark is kept and sent again.
 */
const REFUSED_WITH_CODE: Readonly<Record<number, string>> = { 404: "CRISIS_ALARM_NOT_FOUND", 409: "CRISIS_ALARM_ENDED" };

/** What a failed send means for the marks in it. */
export function classify(error: unknown): Failure {
  if (error instanceof ApiError && (REFUSED.has(error.status) || (error.code !== undefined && error.code === REFUSED_WITH_CODE[error.status]))) {
    return { kind: "permanent", code: error.code ?? `HTTP_${error.status}` };
  }
  return { kind: "transient" };
}

/** The refusals that are about the whole group (its alarm is over, it is not the teacher's) and not about one pupil. */
const CALL_LEVEL = new Set(["CRISIS_ALARM_ENDED", "CRISIS_ALARM_NOT_FOUND", "CRISIS_NOT_YOURS"]);

/** A mark the gateway answered `unresolved`: it belongs to no alarm of the teacher's. */
export const UNRESOLVED = "CRISIS_MARK_UNRESOLVED";

export interface Dropped {
  mark: QueuedMark;
  code: string;
}

export interface FlushResult {
  /** Acknowledged by the gateway (stored, or already there). */
  sent: QueuedMark[];
  /** Refused for good: to be thrown away and told. */
  dropped: Dropped[];
  /** Still to send: the network did not answer. */
  unsent: QueuedMark[];
}

type Send = (marks: QueuedMark[]) => Promise<MarkResult>;

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
async function deliver(batch: QueuedMark[], send: Send): Promise<FlushResult> {
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
    // Per group, or (marks made with no group) per alarm: what a refusal about the whole is about.
    const targets = new Set(batch.map(targetOf));
    if (CALL_LEVEL.has(failure.code)) {
      if (targets.size === 1) return { sent: [], dropped: batch.map((mark) => ({ mark, code: failure.code })), unsent: [] };
      return deliverInOrder([...targets].map((target) => batch.filter((mark) => targetOf(mark) === target)), send);
    }
    const middle = Math.ceil(batch.length / 2);
    return deliverInOrder([batch.slice(0, middle), batch.slice(middle)], send);
  }
}

/** Batches one after another; once one is left unsent, the rest are too. */
async function deliverInOrder(batches: QueuedMark[][], send: Send): Promise<FlushResult> {
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
export async function flushMarks(queue: readonly QueuedMark[], send: Send): Promise<FlushResult> {
  const batches: QueuedMark[][] = [];
  for (let at = 0; at < queue.length; at += MAX_MARKS_PER_CALL) batches.push(queue.slice(at, at + MAX_MARKS_PER_CALL));
  return deliverInOrder(batches, send);
}
