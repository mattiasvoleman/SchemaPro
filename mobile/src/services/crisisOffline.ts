import * as Notifications from 'expo-notifications';
import { localCalls } from './crisisLocalList';
import type { AlarmHint, MyCall, MyCrisisResponse } from './crisis';
import {
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
 * not tap a banner: they unlock the phone and open the app.
 *
 * The instants are kept in memory at once and in the encrypted database as soon
 * as it is open (a tap that launches the app is handled before the provider
 * that opens it has finished), and the database is cleared at sign-out with
 * the rest of the cache.
 */

/** A hint older than this is not about an alarm still going: the gateway ends a real one after 12 hours. */
export const HINT_TTL_MS = 12 * 3_600_000;
/** How far before the push an alarm in the cache may have started and still be the one it told of (a push can be late). */
const PUSH_LATE_MS = 15 * 60_000;
/** And how far after: the clocks of the push service and the gateway differ by seconds. */
const PUSH_EARLY_MS = 60_000;

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
}

/** The alarm and end pushes still in the tray: the teacher who opens the app by hand did not tap one. */
export async function rememberPresentedCrisisPushes(now: number = Date.now()): Promise<void> {
  try {
    const presented = await Notifications.getPresentedNotificationsAsync();
    for (const notification of presented) await rememberCrisisPush(notification, now);
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
}
