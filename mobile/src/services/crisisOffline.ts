import * as Notifications from 'expo-notifications';
import { SecureTokenStore } from './auth/secureTokenStore';
import { readCachedCrisis, saveCachedCrisis } from './crisisCache';
import { localCalls } from './crisisLocalList';
import { fetchMyCrisis, stillRelevant, type AlarmHint, type MyCall, type MyCrisisResponse } from './crisis';
import {
  clearCrisisAlarmHint,
  getCachedLessonsAround,
  getCrisisHint,
  getRegisterAbsentees,
  getStudentsByIds,
  saveCrisisAlarmHint,
  saveCrisisEndedHint,
  whenDatabaseReady,
} from './database/localDatabase';

/**
 * WHAT THE PHONE KNOWS OF AN ALARM WHEN THE GATEWAY HAS NOT TOLD IT (Krisläge, F2).
 *
 * The push is the one thing that reaches a phone with no coverage to speak of:
 * it says THAT an alarm is going, and nothing else (push-messages.ts: not the
 * kind, no pupil, group or place; its data is { notificationId, type } and the
 * phone's own record of when it arrived). So the phone keeps two instants, when
 * the last alarm push arrived and when the last end push did, and from them:
 *
 *   * builds a list from its own cache for the lesson that was going when the
 *     alarm was told of (crisisLocalList.ts), if no list came from the gateway
 *     for it;
 *   * stops asking for marks on an alarm whose end it was told of.
 *
 * Where they come from: a push that arrives while the app is open (the
 * received listener), a tap on one (the response listener, and the tap that
 * launched the app), and, when the teacher opens the app by hand, the
 * notifications still in the tray. The tray is read because most teachers do
 * not tap a banner: they unlock the phone and open the app. (The app has no
 * background task for pushes: the alarm is a visible notification, not a data
 * message.)
 *
 * A PUSH IS NEWS, NOT TRUTH. The push service holds a push for ten minutes
 * (the gateway sends an alarm with that time to live), but a phone that was off
 * or out of coverage can still show one late, and a banner left in the tray
 * stays there for hours. So a push that says an alarm began is never turned into
 * a list by itself: handleCrisisPush first asks the gateway (GET /crisis/mine)
 * whether an alarm is still going. An alarm that stands is remembered, and the
 * list the gateway gave is kept for the next time the network is gone; if the
 * gateway says none is, the alarm hint is forgotten and the screen shows what
 * the gateway says, an ended alarm or none. Only when the gateway cannot be
 * reached does the phone do what it always did without it: believe the hint, for
 * as long as an alarm can stand (HINT_TTL_MS: the gateway ends one after twelve
 * hours). A push cannot be late (it is held ten minutes), so a hint made when a
 * push arrives is true until an end push or the gateway says otherwise, even
 * through an evacuation with no coverage at all; what can be old is a banner left
 * in the tray, and the tray is read only for banners from the last quarter of an
 * hour (TRAY_MAX_AGE_MS).
 *
 * The instants are kept in memory at once and in the encrypted database as soon
 * as it is open (a tap that launches the app is handled before the provider
 * that opens it has finished), and the database is cleared at sign-out with
 * the rest of the cache.
 */

/**
 * How long an alarm push is believed with no word from the gateway: as long as an
 * alarm can stand (the gateway ends one after twelve hours). Not shorter: the
 * phone that matters most here is the one with no coverage for the whole
 * evacuation, and a list that vanished after a quarter of an hour would vanish in
 * the middle of it. (The push is held ten minutes by the push service, so it is
 * not late; whether it is still true is asked of the gateway as soon as there is
 * a network. A list the gateway has given is kept for as long as the alarm can
 * stand too, crisis.ts stillRelevant.)
 */
export const HINT_TTL_MS = 12 * 60 * 60_000;
/** A banner in the tray older than this is not read as news: it may be left from an alarm long over. */
export const TRAY_MAX_AGE_MS = 15 * 60_000;
/** How far before the push an alarm in the cache may have started and still be the one it told of (a push can be late). */
const PUSH_LATE_MS = 15 * 60_000;
/** And how far after: the clocks of the push service and the gateway differ by seconds. */
const PUSH_EARLY_MS = 60_000;
/** How long the gateway is waited for before the phone goes on as if it had no network. */
const PATIENCE_MS = 5_000;

let memory: AlarmHint = { alarmAt: null, endedAt: null };

const later = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b));

/**
 * A notification's `date` in milliseconds. iOS reports seconds since 1970 and
 * Android milliseconds (expo-notifications serialises each platform's own);
 * 1e11 seconds is the year 5138 and 1e11 milliseconds is 1973, so either is
 * unmistakable. Nothing usable is null.
 */
export function pushTimeMs(date: unknown): number | null {
  if (typeof date !== 'number' || !Number.isFinite(date) || date <= 0) return null;
  return date < 1e11 ? Math.round(date * 1000) : Math.round(date);
}

export interface CrisisPush {
  readonly type: 'CRISIS_ALARM' | 'CRISIS_ENDED';
  readonly at: number;
}

/** The alarm or end push in a notification (or a notification response's notification), with when it arrived; null for any other. */
export function crisisPushOf(notification: unknown, now: number = Date.now()): CrisisPush | null {
  const n = notification as { date?: unknown; request?: { content?: { data?: unknown } } } | null | undefined;
  const type = (n?.request?.content?.data as { type?: unknown } | null | undefined)?.type;
  if (type !== 'CRISIS_ALARM' && type !== 'CRISIS_ENDED') return null;
  return { type, at: pushTimeMs(n?.date) ?? now };
}

/** Notes an alarm or end push. Memory first, then the database when it is open; never throws. */
export async function rememberCrisisPush(notification: unknown, now: number = Date.now()): Promise<void> {
  const push = crisisPushOf(notification, now);
  if (!push) return;
  memory =
    push.type === 'CRISIS_ALARM'
      ? { ...memory, alarmAt: later(memory.alarmAt, push.at) }
      : { ...memory, endedAt: later(memory.endedAt, push.at) };
  try {
    await whenDatabaseReady();
    const at = new Date(push.at).toISOString();
    if (push.type === 'CRISIS_ALARM') await saveCrisisAlarmHint(at);
    else await saveCrisisEndedHint(at);
  } catch {
    // Kept in memory; the next push writes it again.
  }
  hintChanged();
}

// ─── Telling the screen the hint changed ──────────────────────────────────────

const hintListeners = new Set<() => void>();

function hintChanged(): void {
  for (const listener of [...hintListeners]) listener();
}

/**
 * The roll call on screen hears when the hint changed (a push was remembered
 * after the gateway answered, or forgotten), because it may be on its way
 * through a read that started before.
 */
export function subscribeAlarmHint(listener: () => void): () => void {
  hintListeners.add(listener);
  return () => {
    hintListeners.delete(listener);
  };
}

/** Forgets the alarm hint of this push and every earlier one; a later push's stays. */
async function forgetAlarmHint(pushAt: number): Promise<void> {
  if (memory.alarmAt !== null && memory.alarmAt <= pushAt) memory = { ...memory, alarmAt: null };
  try {
    await whenDatabaseReady();
    await clearCrisisAlarmHint(new Date(pushAt).toISOString());
  } catch {
    // The memory is clear; a database that cannot be written keeps a hint that goes stale in a quarter of an hour.
  }
  hintChanged();
}

// ─── A push, and what the gateway says of it ──────────────────────────────────

/**
 * What the gateway said of the alarm a push told of. GOING: an alarm is open.
 * OVER: none is, it has ended (or never reached this teacher). UNKNOWN: the
 * gateway could not be asked or did not answer, so the push is all the phone has.
 */
export type PushVerdict = 'GOING' | 'OVER' | 'UNKNOWN';

interface Answer {
  readonly verdict: PushVerdict;
  readonly response?: MyCrisisResponse;
}

/** The pushes the gateway has already answered for, by when they were sent: asked about once, not at every glance at the tray. */
const settled = new Map<number, PushVerdict>();

async function askGateway(): Promise<Answer> {
  try {
    const response = await fetchMyCrisis();
    const now = Date.now();
    return { verdict: response.alarms.some((alarm) => alarm.endedAt === null && stillRelevant(alarm, now)) ? 'GOING' : 'OVER', response };
  } catch {
    return { verdict: 'UNKNOWN' };
  }
}

/** The list the gateway just gave, kept for the signed-in teacher unless a newer one is already there. */
async function keepList(response: MyCrisisResponse): Promise<void> {
  try {
    const session = await SecureTokenStore.getTeacherSession();
    if (!session || session.role !== 'TEACHER') return;
    const kept = await readCachedCrisis(session.teacherId);
    if (kept && Date.parse(kept.asOf) >= Date.parse(response.asOf)) return;
    await saveCachedCrisis(session.teacherId, response);
  } catch {
    // The screen reads the list itself when it is shown.
  }
}

async function applyAnswer(push: CrisisPush, answer: Answer, notification: unknown, now: number): Promise<PushVerdict> {
  if (answer.verdict === 'OVER') {
    settled.set(push.at, 'OVER');
    await forgetAlarmHint(push.at);
    return 'OVER';
  }
  if (answer.verdict === 'GOING') settled.set(push.at, 'GOING');
  await rememberCrisisPush(notification, now);
  if (answer.response) await keepList(answer.response);
  return answer.verdict;
}

/**
 * An alarm or end push has arrived (received, tapped, or found in the tray).
 *
 * An end push is remembered at once: it only closes an alarm that began before
 * it, and a late one closes nothing that is going. An alarm push is first put to
 * the gateway: see "A PUSH IS NEWS" above. Returns what the gateway said (null
 * for any other push, and for an end). Waits for the gateway for PATIENCE_MS,
 * no longer: a slow network is a phone with none, the push is remembered as it
 * always was, and an answer that comes later still corrects it. Never throws.
 */
export async function handleCrisisPush(notification: unknown, now: number = Date.now()): Promise<PushVerdict | null> {
  const push = crisisPushOf(notification, now);
  if (!push) return null;
  if (push.type === 'CRISIS_ENDED') {
    await rememberCrisisPush(notification, now);
    return null;
  }
  const known = settled.get(push.at);
  if (known) return known;

  // Only a teacher's phone has a list to ask for; an administrator's has none, and a signed-out one no bearer.
  let session: Awaited<ReturnType<typeof SecureTokenStore.getTeacherSession>> = null;
  try {
    session = await SecureTokenStore.getTeacherSession();
  } catch {
    // Unreadable: no session to ask under.
  }
  if (!session || session.role !== 'TEACHER') {
    await rememberCrisisPush(notification, now);
    return 'UNKNOWN';
  }

  const asked = askGateway();
  let patience: ReturnType<typeof setTimeout> | undefined;
  const early = await Promise.race([
    asked,
    new Promise<null>((resolve) => {
      patience = setTimeout(() => resolve(null), PATIENCE_MS);
    }),
  ]);
  clearTimeout(patience);
  if (early) return applyAnswer(push, early, notification, now);

  await rememberCrisisPush(notification, now);
  void asked.then((late) => (late.verdict === 'UNKNOWN' ? undefined : applyAnswer(push, late, notification, now))).catch(() => undefined);
  return 'UNKNOWN';
}

/** The alarm and end pushes still in the tray: the teacher who opens the app by hand did not tap one. */
export async function rememberPresentedCrisisPushes(now: number = Date.now()): Promise<void> {
  try {
    const presented = await Notifications.getPresentedNotificationsAsync();
    for (const notification of presented) {
      const delivered = pushTimeMs((notification as { date?: unknown } | null | undefined)?.date);
      if (delivered !== null && now - delivered > TRAY_MAX_AGE_MS) continue;
      await handleCrisisPush(notification, now);
    }
  } catch {
    // No tray to read (a platform without it, a permission refused).
  }
}

/** What the phone knows, from memory and the database; null when it has seen no alarm or end push, or only old ones. */
export async function readAlarmHint(now: number = Date.now()): Promise<AlarmHint | null> {
  let stored: AlarmHint = { alarmAt: null, endedAt: null };
  try {
    await whenDatabaseReady();
    const row = await getCrisisHint();
    if (row) {
      stored = {
        alarmAt: row.alarmAt ? Date.parse(row.alarmAt) : null,
        endedAt: row.endedAt ? Date.parse(row.endedAt) : null,
      };
    }
  } catch {
    // The database is not open: memory alone.
  }
  const alarmAt = later(memory.alarmAt, Number.isNaN(stored.alarmAt) ? null : stored.alarmAt);
  const endedAt = later(memory.endedAt, Number.isNaN(stored.endedAt) ? null : stored.endedAt);
  const fresh = (at: number | null): number | null => (at !== null && now - at <= HINT_TTL_MS ? at : null);
  const hint = { alarmAt: fresh(alarmAt), endedAt: fresh(endedAt) };
  return hint.alarmAt === null && hint.endedAt === null ? null : hint;
}

/**
 * Whether the phone should build its own list: it was told of an alarm that has
 * not been told to have ended, and no list from the gateway speaks for it. A
 * list speaks for it when it was read after the push arrived (the alarm began
 * before the push, so the gateway knew of it then, and whatever the list holds
 * for this teacher, nothing, is the gateway's answer), or when an alarm in it
 * began around the time the push arrived. A list read before the alarm began
 * does neither, which is the case this is for.
 */
export function needsLocalList(hint: AlarmHint | null, response: MyCrisisResponse | null): boolean {
  if (!hint || hint.alarmAt === null) return false;
  if (hint.endedAt !== null && hint.endedAt >= hint.alarmAt) return false;
  const told = hint.alarmAt;
  if (response && Date.parse(response.asOf) >= told) return false;
  return !(response?.alarms ?? []).some((alarm) => {
    const started = Date.parse(alarm.startedAt);
    return started >= told - PUSH_LATE_MS && started <= told + PUSH_EARLY_MS;
  });
}

/** The calls at `at` from the lessons and pupils this phone holds, and the register this teacher took. */
export async function loadLocalCalls(at: number, teacherId: string): Promise<MyCall[]> {
  const when = new Date(at);
  const lessons = await getCachedLessonsAround(when.toISOString());
  if (lessons.length === 0) return [];
  const pupilIds = [...new Set(lessons.flatMap((lesson) => lesson.studentIds))];
  const pupils = await getStudentsByIds(pupilIds);
  const names = new Map(pupils.map((pupil) => [pupil.id, pupil.displayName]));
  const absent = await getRegisterAbsentees(
    teacherId,
    lessons.map((lesson) => lesson.id),
  );
  return localCalls(when, lessons, names, absent);
}

/** For tests: forget what memory holds. */
export function resetAlarmHintForTests(): void {
  memory = { alarmAt: null, endedAt: null };
  settled.clear();
  hintListeners.clear();
}
