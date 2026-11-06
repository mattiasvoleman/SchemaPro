import { ApiError, apiRequest } from './api';
import { compareSwedish } from '../utils/sorting';
import type { CrisisMarkState, PendingCrisisMark } from '../types';

/**
 * Krisläge (F2), the app's side of the roll call of an alarm: the gateway
 * client, the types it speaks, and the pure functions that turn what the
 * gateway answered plus what the phone has not yet sent into what the screen
 * draws.
 *
 * The types are copied from the gateway's src/crisis/crisis-views.ts and
 * dto/crisis.dto.ts, not imported: mobile is its own package. They are the
 * CONTRACT, so a change there is a change here; crisis.test.ts pins the shapes
 * and routes the screens read.
 *
 * Two readers share the alarm. A TEACHER reads their own groups
 * (GET /api/v1/crisis/mine) and marks pupils found or missing, offline-first
 * (services/crisisQueue.ts). An administrator starts and ends the alarm and
 * reads the whole of it (the /alarms routes); nothing of theirs is queued: an
 * alarm that is started or ended on a delay is a different alarm.
 */

// ─── The gateway's types (crisis-views.ts) ───────────────────────────────────

export type CrisisKind = 'EVACUATION' | 'LOCKDOWN';
export type CrisisMode = 'LIVE' | 'DRILL';
/**
 * Why a pupil is on a group. NO_LESSON is the one group of an alarm that
 * gathers every pupil who is on no lesson's list (before the first lesson, after
 * the last, a lesson that is cancelled): the school does not know where they
 * are and the administration answers for them. A teacher normally never gets
 * it, and its groupName and subjectName are Swedish stand-ins that a screen
 * does not show as they are (callTitle).
 */
export type CallBasis = 'LESSON' | 'NEXT_LESSON' | 'NO_LESSON';
/**
 * FOUND / MISSING: marked by a teacher (or the administration). AWAY: marked "not
 * in the building" (not seen today) by the administration, and only by it: a
 * teacher cannot say it, the gateway refuses it (CRISIS_MARK_INVALID). It is
 * counted for itself and never as found: a pupil nobody has seen is not a pupil
 * who was found. ABSENT_BEFORE: not marked and absent before the alarm (the
 * register of the day, a report or a leave), so nobody is asked to find them.
 * UNREPORTED: not marked and expected, so someone still has to say.
 */
export type PupilStatus = 'FOUND' | 'MISSING' | 'AWAY' | 'ABSENT_BEFORE' | 'UNREPORTED';
export type PriorSource = 'ATTENDANCE' | 'REPORTED';

export interface PupilCounts {
  readonly pupils: number;
  readonly found: number;
  readonly missing: number;
  /** Marked not in the building by the administration: its own figure, never added to `found`. */
  readonly away: number;
  readonly absentBefore: number;
  readonly unreported: number;
}

export interface PupilView {
  readonly studentId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly status: PupilStatus;
  readonly priorAbsentSource: PriorSource | null;
  /** When the latest mark was made, by the sender's clock. */
  readonly markedAt: string | null;
  /** Who made it: the administration's view only. */
  readonly markedBy?: string | null;
}

/** A pupil a teacher on the call found who is on another list (or none): "found with me". */
export interface FoundHere {
  readonly studentId: string;
  readonly firstName: string;
  readonly lastName: string;
  /** The pupil's own class, so that two of the same name can be told apart. */
  readonly className: string | null;
  /** When the teacher marked them, by the sender's clock. */
  readonly markedAt: string;
}

/**
 * A pupil of the school who is on none of the teacher's lists, as the search for "found with me" answers
 * (POST /crisis/mine/pupils). Held nowhere: not in the list, not on the phone's disk.
 */
export interface OtherPupil {
  readonly studentId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly className: string | null;
}

/** A teacher's group, as the phone shows it and keeps it offline. */
export interface MyCall {
  readonly id: string;
  readonly lessonId: string | null;
  readonly basis: CallBasis;
  readonly groupName: string;
  readonly subjectName: string;
  readonly roomName: string | null;
  readonly lessonStartsAt: string;
  readonly lessonEndsAt: string;
  readonly completedAt: string | null;
  /** The colleagues who answer for the group beside the teacher. */
  readonly colleagues: readonly string[];
  readonly counts: PupilCounts;
  readonly pupils: readonly PupilView[];
  /** Pupils not on this list whom a teacher on the call found. They count on their own list, not here. */
  readonly foundHere: readonly FoundHere[];
}

export interface AlarmView {
  readonly id: string;
  readonly kind: CrisisKind;
  readonly mode: CrisisMode;
  readonly startedAt: string;
  readonly startedBy: string | null;
  readonly endedAt: string | null;
  readonly endedBy: string | null;
  readonly autoEnded: boolean;
  readonly endNote: string | null;
  readonly guardiansNotifiedAt: string | null;
}

export interface MyAlarm extends AlarmView {
  readonly calls: readonly MyCall[];
  /**
   * Pupils this teacher found who are on none of their lists and were found with no group: a teacher with no
   * group right now (a gap, a duty, a timetable that lacks them) can say they found a pupil too, and the
   * mark names the alarm in place of a call.
   */
  readonly foundFree: readonly FoundHere[];
}

export interface MyCrisisResponse {
  /** The moment the gateway answered: a phone holding the list offline shows how old it is. */
  readonly asOf: string;
  readonly alarms: readonly MyAlarm[];
}

export interface TeacherView {
  readonly userId: string | null;
  readonly name: string | null;
  readonly role: 'LEAD' | 'ASSISTANT' | 'SUBSTITUTE';
  /** Their first mark on the call. */
  readonly answeredAt: string | null;
}

export interface CallView {
  readonly id: string;
  readonly lessonId: string | null;
  readonly basis: CallBasis;
  readonly groupName: string;
  readonly subjectName: string;
  readonly roomName: string | null;
  readonly lessonStartsAt: string;
  readonly lessonEndsAt: string;
  readonly completedAt: string | null;
  /** Nobody is on the call to answer for it: the administration marks the group. */
  readonly uncovered: boolean;
  readonly teachers: readonly TeacherView[];
  readonly counts: PupilCounts;
  readonly pupils: readonly PupilView[];
}

export interface AlarmSummary extends AlarmView {
  /** Pupils on the group nobody has a lesson with (NO_LESSON): they count in `counts` like all the others. */
  readonly unlisted: number;
  readonly calls: number;
  /** Calls that are complete, or have nobody to ask. */
  readonly callsComplete: number;
  readonly counts: PupilCounts;
  readonly teachers: number;
  readonly teachersAnswered: number;
}

/** The administration's view of one alarm. */
export interface AlarmDetail {
  readonly alarm: AlarmSummary;
  readonly calls: readonly CallView[];
}

/** What a mark answers: how many were stored, how many were already, and the ones that belong to no alarm of the caller's. */
export interface MarkResult {
  readonly stored: number;
  readonly duplicates: number;
  readonly unresolved: readonly string[];
}

/** One call carries at most this many marks (MAX_MARKS_PER_CALL, crisis.dto.ts). */
export const MAX_MARKS_PER_CALL = 400;

// ─── Counting, as the gateway counts ─────────────────────────────────────────

export function statusOf(state: CrisisMarkState | 'AWAY' | null, prior: PriorSource | null): PupilStatus {
  if (state) return state;
  return prior ? 'ABSENT_BEFORE' : 'UNREPORTED';
}

export function countPupils(statuses: readonly PupilStatus[]): PupilCounts {
  let found = 0;
  let missing = 0;
  let away = 0;
  let absentBefore = 0;
  let unreported = 0;
  for (const status of statuses) {
    if (status === 'FOUND') found++;
    else if (status === 'MISSING') missing++;
    else if (status === 'AWAY') away++;
    else if (status === 'ABSENT_BEFORE') absentBefore++;
    else unreported++;
  }
  return { pupils: statuses.length, found, missing, away, absentBefore, unreported };
}

export function pupilName(pupil: { readonly firstName: string; readonly lastName: string }): string {
  return `${pupil.firstName} ${pupil.lastName}`.trim();
}

// ─── Reading what the gateway (or the phone's own copy of it) holds ──────────

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const orNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

function otherPupilOf(raw: unknown): OtherPupil | null {
  const r = raw as Partial<Record<keyof OtherPupil, unknown>> | null;
  if (!r || typeof r.studentId !== 'string' || r.studentId === '') return null;
  return { studentId: r.studentId, firstName: text(r.firstName), lastName: text(r.lastName), className: orNull(r.className) };
}

function foundHereOf(raw: unknown): FoundHere | null {
  const r = raw as Partial<Record<keyof FoundHere, unknown>> | null;
  if (!r || typeof r.studentId !== 'string' || r.studentId === '' || typeof r.markedAt !== 'string') return null;
  return { studentId: r.studentId, firstName: text(r.firstName), lastName: text(r.lastName), className: orNull(r.className), markedAt: r.markedAt };
}

function listOf<T>(raw: unknown, read: (item: unknown) => T | null): T[] {
  if (!Array.isArray(raw)) return [];
  const items: T[] = [];
  for (const item of raw) {
    const entry = read(item);
    if (entry) items.push(entry);
  }
  return items;
}

/** Figures from a gateway that does not count `away` (older than "not in the building") read it as nought. */
function countsOf(raw: unknown): PupilCounts {
  const c = (raw ?? {}) as Partial<Record<keyof PupilCounts, unknown>>;
  const n = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  return { pupils: n(c.pupils), found: n(c.found), missing: n(c.missing), away: n(c.away), absentBefore: n(c.absentBefore), unreported: n(c.unreported) };
}

/**
 * The alarms as the phone works with them. A gateway older than "found with me"
 * sends no `foundHere` on a group and no `foundFree` on an alarm, one older than
 * "not in the building" no `away` in the figures, and a list the phone kept before
 * then has none of them: they read as an empty list and nought, and a malformed
 * entry is left out rather than taken down with the screen that is needed most.
 * A list kept by a build that held every other pupil of the school in it (`others`)
 * loses them here: the picker asks the gateway now, and nothing of the school is kept
 * beyond the teacher's own groups. (An unknown `basis` is left as it is: a screen
 * words anything but NO_LESSON as a lesson.)
 */
export function normalizeAlarms(alarms: readonly unknown[]): MyAlarm[] {
  return alarms.map((raw) => {
    const { others: _held, ...alarm } = raw as MyAlarm & { others?: unknown };
    return {
      ...alarm,
      calls: (Array.isArray(alarm.calls) ? alarm.calls : []).map((call) => ({
        ...call,
        counts: countsOf(call.counts),
        foundHere: listOf(call.foundHere, foundHereOf),
      })),
      foundFree: listOf(alarm.foundFree, foundHereOf),
    };
  });
}

/** The administration's figures with `away` read as nought where the gateway does not say it. */
function normalizeSummary<T extends AlarmSummary>(alarm: T): T {
  return { ...alarm, counts: countsOf(alarm.counts), unlisted: typeof alarm.unlisted === 'number' ? alarm.unlisted : 0 };
}

function normalizeDetail(detail: AlarmDetail): AlarmDetail {
  return {
    alarm: normalizeSummary(detail.alarm),
    calls: (Array.isArray(detail.calls) ? detail.calls : []).map((call) => ({ ...call, counts: countsOf(call.counts) })),
  };
}

// ─── The gateway ─────────────────────────────────────────────────────────────

const BASE = '/api/v1/crisis';

/**
 * The teacher's list: the alarms the gateway lets them read (an open one, or
 * one that ended within the hour) and their groups. A 404 WITHOUT a code is a
 * gateway that has no such route (older than Krisläge): no alarm, not an error
 * on every visit. The route's own refusals carry a code.
 */
export async function fetchMyCrisis(options: { readonly signal?: AbortSignal } = {}): Promise<MyCrisisResponse> {
  try {
    const answer = await apiRequest<Partial<MyCrisisResponse> | undefined>(`${BASE}/mine`, options.signal ? { signal: options.signal } : {});
    return { asOf: answer?.asOf ?? new Date().toISOString(), alarms: normalizeAlarms(answer?.alarms ?? []) };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404 && !error.code) return { asOf: new Date().toISOString(), alarms: [] };
    throw error;
  }
}

/**
 * A mark as the gateway takes it: the group by call OR lesson OR alarm, exactly one. The alarm is for a
 * teacher with no group, who says they found a pupil all the same.
 */
export function markBody(mark: PendingCrisisMark): Record<string, string> {
  const group: Record<string, string> = mark.callId
    ? { callId: mark.callId }
    : mark.lessonId
      ? { lessonId: mark.lessonId }
      : { alarmId: mark.alarmId as string };
  return { id: mark.id, ...group, studentId: mark.studentId, state: mark.state, at: mark.at };
}

/** POST /api/v1/crisis/mine/marks, at most MAX_MARKS_PER_CALL; idempotent per mark id. */
export async function postMyMarks(
  marks: readonly PendingCrisisMark[],
  options: { readonly token?: string; readonly signal?: AbortSignal } = {},
): Promise<MarkResult> {
  const answer = await apiRequest<Partial<MarkResult> | undefined>(`${BASE}/mine/marks`, {
    method: 'POST',
    body: { marks: marks.map(markBody) },
    ...(options.token ? { token: options.token } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return {
    stored: Number(answer?.stored ?? 0),
    duplicates: Number(answer?.duplicates ?? 0),
    unresolved: Array.isArray(answer?.unresolved) ? answer.unresolved : [],
  };
}

/** The shortest search the gateway answers, and the most names it gives back (POST /crisis/mine/pupils). */
export const SEARCH_MIN_CHARS = 2;
export const SEARCH_LIMIT = 25;

/**
 * The pupils of the school who are on none of this teacher's lists, whose name or class begins as `query`
 * does: the picker for "found with me" asks as the teacher types. The gateway excludes the teacher's own
 * pupils and includes the pupils whose identity is protected. Nothing of the answer is kept anywhere: it is
 * on the screen while the picker is, and gone with it. The question is a POST with the alarm and the text in
 * the body, never in the URL: what a teacher types is part of a pupil's name, and the gateway logs and
 * echoes URLs (and keeps no personal data in its logs).
 */
export async function searchOtherPupils(alarmId: string, query: string, options: { readonly signal?: AbortSignal } = {}): Promise<OtherPupil[]> {
  const answer = await apiRequest<unknown>(`${BASE}/mine/pupils`, {
    method: 'POST',
    body: { alarmId, q: query.trim() },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return listOf(answer, otherPupilOf).slice(0, SEARCH_LIMIT);
}

export async function startAlarm(kind: CrisisKind, mode: CrisisMode): Promise<AlarmDetail> {
  return normalizeDetail(await apiRequest<AlarmDetail>(`${BASE}/alarms`, { method: 'POST', body: { kind, mode } }));
}

/** The school's newest alarms, open ones included. */
export async function fetchAlarmList(limit = 5): Promise<AlarmSummary[]> {
  return ((await apiRequest<AlarmSummary[] | undefined>(`${BASE}/alarms?limit=${limit}`)) ?? []).map(normalizeSummary);
}

export async function fetchAlarmDetail(alarmId: string): Promise<AlarmDetail> {
  return normalizeDetail(await apiRequest<AlarmDetail>(`${BASE}/alarms/${encodeURIComponent(alarmId)}`));
}

export async function endAlarm(alarmId: string): Promise<AlarmDetail> {
  return normalizeDetail(await apiRequest<AlarmDetail>(`${BASE}/alarms/${encodeURIComponent(alarmId)}/end`, { method: 'POST', body: {} }));
}

/**
 * The administration says a pupil is not in the building (POST /crisis/alarms/:id/marks, state AWAY), by
 * the pupil's own group. Live, never queued, like everything the administration does; only the
 * administration may say it: the teacher's route refuses AWAY (CRISIS_MARK_INVALID).
 */
export function markAway(alarm: { readonly id: string; readonly startedAt: string }, callId: string, studentId: string, markId: string): Promise<MarkResult> {
  // Not before the alarm began: the gateway holds a mark between the alarm's start and now.
  const at = new Date(Math.max(Date.now(), Date.parse(alarm.startedAt))).toISOString();
  return apiRequest<Partial<MarkResult> | undefined>(`${BASE}/alarms/${encodeURIComponent(alarm.id)}/marks`, {
    method: 'POST',
    body: { marks: [{ id: markId, callId, studentId, state: 'AWAY', at }] },
  }).then((answer) => ({
    stored: Number(answer?.stored ?? 0),
    duplicates: Number(answer?.duplicates ?? 0),
    unresolved: Array.isArray(answer?.unresolved) ? answer.unresolved : [],
  }));
}

// ─── Why a call failed ───────────────────────────────────────────────────────

/** Whether a request died in the phone's own network layer (React Native's fetch rejects with a TypeError, or an AbortError). */
export function isTransportFailure(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof Error && error.name === 'AbortError');
}

/**
 * What an administrator's call came to, in the gateway's own codes
 * (crisis.service.ts): the role may not start an alarm (CRISIS_NOT_YOURS,
 * 403), one of that mode is already going (CRISIS_ALARM_OPEN, 409), the alarm
 * is over (CRISIS_ALARM_ENDED, 409) or gone (CRISIS_ALARM_NOT_FOUND, 404).
 */
export type AdminFailure = 'NOT_YOURS' | 'ALARM_OPEN' | 'ENDED' | 'NOT_FOUND' | 'OFFLINE' | 'FAILED';

export function adminFailureOf(error: unknown): AdminFailure {
  if (!(error instanceof ApiError)) return isTransportFailure(error) ? 'OFFLINE' : 'FAILED';
  switch (error.code) {
    case 'CRISIS_NOT_YOURS':
      return 'NOT_YOURS';
    case 'CRISIS_ALARM_OPEN':
      return 'ALARM_OPEN';
    case 'CRISIS_ALARM_ENDED':
      return 'ENDED';
    case 'CRISIS_ALARM_NOT_FOUND':
      return 'NOT_FOUND';
    default:
      return 'FAILED';
  }
}

// ─── What a teacher's screen draws ───────────────────────────────────────────

/** A list the phone built itself has these in its ids: a mark on it names the lesson, not the call. */
export const LOCAL_CALL_PREFIX = 'local:';
export const LOCAL_ALARM_ID = 'local';

export const isLocalCall = (call: { readonly id: string }): boolean => call.id.startsWith(LOCAL_CALL_PREFIX);

/**
 * How far the phone's clock may trail the gateway's before a mark made by
 * lesson no longer finds its alarm: the gateway resolves a lesson to "the
 * alarm that had started when the mark was made", by the mark's own time.
 */
const CLOCK_TOLERANCE_MS = 5 * 60_000;

/** An alarm stops being offered when the gateway would no longer hand it over: an hour after it ended. */
export const ENDED_GRACE_MS = 60 * 60_000;
/** The longest an alarm stands open before the gateway ends it itself (crisis_settle). */
const OPEN_LIMIT_MS: Readonly<Record<CrisisMode, number>> = { LIVE: 12 * 3_600_000, DRILL: 3 * 3_600_000 };

/**
 * Whether an alarm a phone still holds is one the gateway would hand over
 * now. The cache outlives the alarm: yesterday's list must not greet a
 * teacher as if it were going on.
 */
export function stillRelevant(alarm: AlarmView, now: number): boolean {
  if (alarm.endedAt) return now - Date.parse(alarm.endedAt) <= ENDED_GRACE_MS;
  return now - Date.parse(alarm.startedAt) < OPEN_LIMIT_MS[alarm.mode];
}

interface Resolved {
  readonly alarm: MyAlarm;
  /** Null for a mark that names the alarm itself: a teacher with no group. */
  readonly call: MyCall | null;
}

function resolveTarget(alarms: readonly MyAlarm[], mark: PendingCrisisMark): Resolved | null {
  if (mark.alarmId) {
    const alarm = alarms.find((candidate) => candidate.id === mark.alarmId);
    return alarm ? { alarm, call: null } : null;
  }
  if (mark.callId) {
    for (const alarm of alarms) {
      const call = alarm.calls.find((candidate) => candidate.id === mark.callId);
      if (call) return { alarm, call };
    }
    return null;
  }
  // By lesson, as the gateway resolves it: of the alarms that had started
  // when the mark was made, the latest. A list the phone built itself is
  // matched whatever its time: it has no start of its own but the push's.
  const at = Date.parse(mark.at);
  let best: Resolved | null = null;
  for (const alarm of alarms) {
    const call = alarm.calls.find((candidate) => candidate.lessonId === mark.lessonId);
    if (!call) continue;
    const started = alarm.id === LOCAL_ALARM_ID || Date.parse(alarm.startedAt) <= at + CLOCK_TOLERANCE_MS;
    if (started && (!best || Date.parse(alarm.startedAt) > Date.parse(best.alarm.startedAt))) best = { alarm, call };
  }
  return best;
}

export interface Overlaid {
  readonly alarms: readonly MyAlarm[];
  /**
   * `${callId}:${studentId}` of every pupil with a mark the phone has not sent; for a pupil found with no
   * group, `alarm:${alarmId}:${studentId}` (waitingKey).
   */
  readonly waiting: ReadonlySet<string>;
}

/** Where a pupil found with the teacher is held: on a call, or, for a teacher with no group, on the alarm. */
export const foundPlace = (alarmId: string, call: { readonly id: string } | null): string => (call ? call.id : `alarm:${alarmId}`);
export const waitingKey = (place: string, studentId: string): string => `${place}:${studentId}`;

/** A pupil by name from what a mark holds, else from the groups of the teacher (a pupil of another of their own). */
function nameOf(alarm: MyAlarm, mark: PendingCrisisMark): OtherPupil | null {
  if (mark.pupil) return { studentId: mark.studentId, ...mark.pupil };
  for (const call of alarm.calls) {
    const pupil = call.pupils.find((candidate) => candidate.studentId === mark.studentId);
    if (pupil) return { studentId: mark.studentId, firstName: pupil.firstName, lastName: pupil.lastName, className: null };
  }
  return null;
}

/** A list of pupils found with the teacher, the taken-back ones out (null) and the new ones in. */
function withFound(held: readonly FoundHere[], effects: ReadonlyMap<string, FoundHere | null> | undefined): readonly FoundHere[] {
  if (!effects || effects.size === 0) return held;
  const kept = held.filter((entry) => effects.get(entry.studentId) !== null);
  const added = [...effects.values()].filter((entry): entry is FoundHere => entry !== null);
  return [...kept, ...added];
}

/**
 * The list with the marks the phone holds put on it. What a pupil shows as is
 * the teacher's latest tap, sent or not: the list that was read last does not
 * know about a tap made a second ago, and a tap that vanishes until the network
 * returns is a teacher who taps again. A mark older than the one the list
 * already holds for the pupil does not replace it, as the gateway keeps the
 * latest by time. The same function lays the queue over a list from the
 * gateway and over one the phone built, and a mark by lesson finds its call in
 * whichever of the two is there, which is why the local list can be replaced by
 * the gateway's without the teacher marking again.
 *
 * A FOUND mark for a pupil who is not on the call's list is "found with me":
 * the gateway keeps it on the call as such (or, for a teacher with no group, on
 * the alarm: `foundFree`), and here the pupil is put there, by the name the mark
 * carries, until the list that comes back carries them. A RETRACTED mark takes
 * such a pupil out again, and a FOUND after it puts them back; the order is the
 * order of the taps. A MISSING mark for such a pupil is not drawn: the gateway
 * refuses it (CRISIS_MARK_INVALID), because a pupil who is on no list of the
 * teacher's cannot be missing from it. RETRACTED is nothing to a pupil of a list.
 */
export function overlayMarks(alarms: readonly MyAlarm[], marks: readonly PendingCrisisMark[]): Overlaid {
  const waiting = new Set<string>();
  const changes = new Map<string, Map<string, { state: CrisisMarkState; at: string }>>();
  // place -> pupil -> the entry to add, or null to take the one the gateway holds away
  const here = new Map<string, Map<string, FoundHere | null>>();
  const ordered = [...marks].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const mark of ordered) {
    const target = resolveTarget(alarms, mark);
    if (!target) continue;
    const pupil = target.call?.pupils.find((candidate) => candidate.studentId === mark.studentId);
    if (!pupil) {
      if (mark.state === 'MISSING') continue;
      const place = foundPlace(target.alarm.id, target.call);
      const onServer = (target.call ? target.call.foundHere : target.alarm.foundFree).some((held) => held.studentId === mark.studentId);
      const effects = here.get(place) ?? new Map<string, FoundHere | null>();
      if (mark.state === 'RETRACTED') {
        // Out of sight at once. What the gateway does not hold has nothing to take away.
        if (onServer) effects.set(mark.studentId, null);
        else effects.delete(mark.studentId);
        waiting.delete(waitingKey(place, mark.studentId));
      } else {
        const who = nameOf(target.alarm, mark);
        if (!who) continue;
        waiting.add(waitingKey(place, mark.studentId));
        // The gateway already holds them found here: the row is its own, and this mark only waits.
        if (onServer) effects.delete(mark.studentId);
        else effects.set(mark.studentId, { studentId: who.studentId, firstName: who.firstName, lastName: who.lastName, className: who.className, markedAt: mark.at });
      }
      here.set(place, effects);
      continue;
    }
    if (mark.state === 'RETRACTED') continue;
    waiting.add(waitingKey(target.call!.id, mark.studentId));
    if (pupil.markedAt !== null && Date.parse(pupil.markedAt) > Date.parse(mark.at)) continue;
    const forCall = changes.get(target.call!.id) ?? new Map<string, { state: CrisisMarkState; at: string }>();
    forCall.set(mark.studentId, { state: mark.state, at: mark.at });
    changes.set(target.call!.id, forCall);
  }
  if (changes.size === 0 && [...here.values()].every((effects) => effects.size === 0)) return { alarms, waiting };
  return {
    waiting,
    alarms: alarms.map((alarm) => ({
      ...alarm,
      foundFree: withFound(alarm.foundFree, here.get(foundPlace(alarm.id, null))),
      calls: alarm.calls.map((call) => {
        const forCall = changes.get(call.id);
        const effects = here.get(call.id);
        if (!forCall && !effects) return call;
        const pupils = forCall
          ? call.pupils.map((pupil) => {
              const change = forCall.get(pupil.studentId);
              return change ? { ...pupil, status: change.state, markedAt: change.at } : pupil;
            })
          : call.pupils;
        return {
          ...call,
          pupils,
          counts: forCall ? countPupils(pupils.map((pupil) => pupil.status)) : call.counts,
          foundHere: withFound(call.foundHere, effects),
        };
      }),
    })),
  };
}

/** The list with marks the gateway has taken written into it: what is kept for the next time the network is gone. */
export function withSentMarks(response: MyCrisisResponse, marks: readonly PendingCrisisMark[]): MyCrisisResponse {
  return { ...response, alarms: overlayMarks(response.alarms, marks).alarms };
}

/** One alarm, or the list the phone built, as the screen draws it. */
export interface AlarmBlock {
  readonly key: string;
  /** The phone built this list itself: no list came from the gateway. */
  readonly local: boolean;
  /** Not known for a local list: the push says only that an alarm is going. */
  readonly kind: CrisisKind | null;
  readonly mode: CrisisMode | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly calls: readonly MyCall[];
  /** The pupils the teacher found with no group; none for a list the phone built itself. */
  readonly foundFree: readonly FoundHere[];
}

export interface AlarmHint {
  /** When the push that said an alarm began arrived, in ms. */
  readonly alarmAt: number | null;
  /** When the push that said it ended arrived, in ms. */
  readonly endedAt: number | null;
}

export interface ViewInput {
  readonly response: MyCrisisResponse | null;
  /** The calls the phone built from its own cache, when no list came. */
  readonly local: readonly MyCall[];
  readonly pending: readonly PendingCrisisMark[];
  readonly hint: AlarmHint | null;
  readonly now: number;
}

/**
 * What the teacher sees: the open alarms first (newest first), then those that
 * ended within the hour, then, when no list came for the alarm the push told
 * of, the list the phone built. An end push the phone has seen closes the
 * alarms that began before it, so a phone that was offline for the end does not
 * go on asking for marks.
 */
export function teacherBlocks(input: ViewInput): { blocks: AlarmBlock[]; waiting: ReadonlySet<string> } {
  const { response, local, pending, hint, now } = input;
  const held: MyAlarm[] = (response?.alarms ?? [])
    .filter((alarm) => stillRelevant(alarm, now))
    .map((alarm) =>
      !alarm.endedAt && hint?.endedAt && Date.parse(alarm.startedAt) <= hint.endedAt
        ? { ...alarm, endedAt: new Date(hint.endedAt).toISOString() }
        : alarm,
    )
    .sort(
      (a, b) =>
        Number(a.endedAt !== null) - Number(b.endedAt !== null) || Date.parse(b.startedAt) - Date.parse(a.startedAt),
    );

  const localAlarm: MyAlarm | null =
    local.length > 0 && hint?.alarmAt
      ? {
          id: LOCAL_ALARM_ID,
          kind: 'EVACUATION',
          mode: 'LIVE',
          startedAt: new Date(hint.alarmAt).toISOString(),
          startedBy: null,
          endedAt: null,
          endedBy: null,
          autoEnded: false,
          endNote: null,
          guardiansNotifiedAt: null,
          calls: local,
          // A pupil found who is on no list cannot be searched for without the gateway, so the
          // screen does not offer it on a list the phone built.
          foundFree: [],
        }
      : null;

  const { alarms, waiting } = overlayMarks(localAlarm ? [...held, localAlarm] : held, pending);
  return {
    waiting,
    blocks: alarms.map((alarm) => {
      const isLocal = alarm.id === LOCAL_ALARM_ID;
      return {
        key: alarm.id,
        local: isLocal,
        kind: isLocal ? null : alarm.kind,
        mode: isLocal ? null : alarm.mode,
        startedAt: alarm.startedAt,
        endedAt: alarm.endedAt,
        calls: alarm.calls,
        foundFree: alarm.foundFree,
      };
    }),
  };
}

/** The pupils a tap on "Alla finns" marks: those nobody has marked and nobody expected to be missing. */
export function unmarkedPupils(call: MyCall): PupilView[] {
  return call.pupils.filter((pupil) => pupil.status === 'UNREPORTED');
}

/** "Marked" is found or missing: how far through the group the teacher is. */
export function markedCount(counts: PupilCounts): number {
  return counts.found + counts.missing;
}

// ─── Pupils found with the teacher ───────────────────────────────────────────

/** The pupils found with the teacher (on a call, or on the alarm for a teacher with no group), by name, Swedish order. */
export function foundHereSorted(found: readonly FoundHere[]): FoundHere[] {
  return [...found].sort((a, b) => compareSwedish(pupilName(a), pupilName(b)) || (a.studentId < b.studentId ? -1 : 1));
}

// ─── What the administration's screen draws ──────────────────────────────────

/** The alarms of the list that are going on. */
export const openAlarms = (alarms: readonly AlarmSummary[]): AlarmSummary[] => alarms.filter((alarm) => alarm.endedAt === null);

/**
 * The pupils marked missing, in the order of the groups, with the group they belong to. The group of
 * a NO_LESSON call has no name of its own (the gateway's is a Swedish stand-in): `basis` says so, and
 * the screen words it.
 */
export function missingPupils(detail: AlarmDetail): Array<{ studentId: string; name: string; groupName: string; basis: CallBasis; callId: string }> {
  return detail.calls.flatMap((call) =>
    call.pupils
      .filter((pupil) => pupil.status === 'MISSING')
      .map((pupil) => ({ studentId: pupil.studentId, name: pupilName(pupil), groupName: call.groupName, basis: call.basis, callId: call.id })),
  );
}

/**
 * The teachers who have not said anything yet on a group still waiting for
 * someone to: by name, with the groups. A teacher of a group that is complete
 * (everyone expected has a mark, from anyone) is not waited for.
 */
export function silentTeachers(detail: AlarmDetail): Array<{ name: string; groups: string[] }> {
  const byName = new Map<string, string[]>();
  for (const call of detail.calls) {
    if (call.counts.unreported === 0) continue;
    for (const teacher of call.teachers) {
      if (teacher.userId === null || teacher.answeredAt !== null || !teacher.name) continue;
      byName.set(teacher.name, [...(byName.get(teacher.name) ?? []), call.groupName]);
    }
  }
  return [...byName].map(([name, groups]) => ({ name, groups }));
}

/** The groups nobody answers for: the administration marks them. */
export const uncoveredCalls = (detail: AlarmDetail): CallView[] =>
  detail.calls.filter((call) => call.uncovered && call.counts.unreported > 0);
