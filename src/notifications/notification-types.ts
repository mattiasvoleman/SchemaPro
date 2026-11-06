import type { NotificationKind } from './notifications.service';

/**
 * Which notice types a person may choose about, by role, and which of them
 * the school must deliver whatever the person chose.
 *
 * The lists are what each role actually receives today (the recipients of
 * notifyUsers' callers): families the lesson and schedule notices and their
 * own leave decisions; staff the lesson notices, their cover bookings and
 * their room bookings. The lesson notices include the three of Notiser som
 * når fram: an avbokning's digest, a lesson that goes ahead as planned after
 * all, and självstudier — each to the lesson's roster, its guardians and the
 * teachers concerned. A teacher also hears of a leave request that is theirs
 * to decide as the pupil's mentor (LEAVE_REQUESTED, Mentorns ledighetsbeslut);
 * an admin is told of none, as before. TEACHER_ABSENCE_REPORTED is in nobody's
 * list: it never leaves the inbox, so a switch for it would do nothing.
 * A week's or month's count of pupils over the school's absence limits
 * (ABSENCE_WATCH_DIGEST, Frånvarobevakning) goes to a mentor, a rektor or
 * kansli administrator and a guardian, each of whom may switch it off; a pupil
 * never gets one. Staff are booked for an absent rastvakt's pass and told when it is off
 * (SUPERVISION_COVER, SUPERVISION_COVER_WITHDRAWN, Rastvakt i vardagen): both
 * listed, both always sent.
 *
 * Krisläge (F2): an alarm that is going (CRISIS_ALARM) and its end (CRISIS_ENDED)
 * reach all the school's staff whatever they chose, and are offered no switch:
 * a notice a person could turn off would be a teacher who never learnt that the
 * building was being emptied. They say only that, never a pupil, a group or a
 * place. After a real alarm, and only if the school chose to tell them, a
 * guardian is told that it happened and ended (CRISIS_GUARDIAN_AFTER); that one
 * is a choice, and names nobody.
 *
 * Vikariefrågan (D4): a teacher is asked to cover (COVER_REQUESTED) and told
 * when the lesson went to somebody else, the question was taken back or the
 * absence went away (COVER_REQUEST_CLOSED); the administrator who asked is
 * told who said yes (COVER_REQUEST_ACCEPTED) and, in the same type as the
 * colleagues' end of it, that the time ran out with nobody saying yes
 * (COVER_REQUEST_CLOSED, reason UNANSWERED). All three are choices: the in-app
 * row is always written, and a colleague who would rather not be pushed still
 * finds the question in the app.
 */

export const NOTIFICATION_TYPES: readonly NotificationKind[] = [
  'ABSENCE_UNREPORTED',
  'LEAVE_DECIDED',
  'LESSON_CANCELLED',
  'LESSON_SUBSTITUTE',
  'LESSON_ROOM_CHANGED',
  'SCHEDULE_CHANGED',
  'ROOM_BOOKING_DECIDED',
  'TEACHER_ABSENCE_REPORTED',
  'LESSON_COVER_WITHDRAWN',
  'LESSON_REINSTATED',
  'LESSON_SUPERVISED_STUDY',
  'CANCELLATION_DIGEST',
  'LEAVE_REQUESTED',
  'SUPERVISION_COVER',
  'SUPERVISION_COVER_WITHDRAWN',
  'COVER_REQUESTED',
  'COVER_REQUEST_ACCEPTED',
  'COVER_REQUEST_CLOSED',
  'ABSENCE_WATCH_DIGEST',
  'CRISIS_ALARM',
  'CRISIS_ENDED',
  'CRISIS_GUARDIAN_AFTER',
];

type ChoosingRole = 'GUARDIAN' | 'STUDENT' | 'TEACHER' | 'SCHOOL_ADMIN';

const STAFF: readonly NotificationKind[] = [
  'LESSON_CANCELLED',
  'CANCELLATION_DIGEST',
  'LESSON_REINSTATED',
  'LESSON_SUBSTITUTE',
  'LESSON_SUPERVISED_STUDY',
  'LESSON_COVER_WITHDRAWN',
  'LESSON_ROOM_CHANGED',
  'ROOM_BOOKING_DECIDED',
  'SUPERVISION_COVER',
  'SUPERVISION_COVER_WITHDRAWN',
];

/** What a family hears about the pupil's lessons, in the order the settings list them. */
const LESSONS: readonly NotificationKind[] = [
  'LESSON_CANCELLED',
  'CANCELLATION_DIGEST',
  'LESSON_REINSTATED',
  'LESSON_SUBSTITUTE',
  'LESSON_SUPERVISED_STUDY',
  'LESSON_ROOM_CHANGED',
  'SCHEDULE_CHANGED',
];

export const TYPES_BY_ROLE: Record<ChoosingRole, readonly NotificationKind[]> = {
  GUARDIAN: [...LESSONS, 'LEAVE_DECIDED', 'ABSENCE_UNREPORTED', 'ABSENCE_WATCH_DIGEST', 'CRISIS_GUARDIAN_AFTER'],
  STUDENT: [...LESSONS, 'LEAVE_DECIDED'],
  TEACHER: [...STAFF, 'LEAVE_REQUESTED', 'ABSENCE_WATCH_DIGEST', 'COVER_REQUESTED', 'COVER_REQUEST_CLOSED'],
  SCHOOL_ADMIN: [...STAFF, 'ABSENCE_WATCH_DIGEST', 'COVER_REQUEST_ACCEPTED', 'COVER_REQUEST_CLOSED'],
};

/**
 * Shown to the role as "always sent", and refused if chosen:
 *
 *   * ABSENCE_UNREPORTED for a guardian — Skollagen 7 kap. 19 a §: the
 *     guardians are told the same day (also a CHECK in 20261013100000);
 *   * LESSON_COVER_WITHDRAWN for staff — vikarieplanering relies on the
 *     substitute being told that a booked lesson is off;
 *   * SUPERVISION_COVER and SUPERVISION_COVER_WITHDRAWN for staff — a pass
 *     is the vikarie's own booking, as LESSON_SUBSTITUTE with cover is (always
 *     delivered, below), and a yard nobody knows they watch is what Rastvakt
 *     i vardagen is for. Unlike LESSON_SUBSTITUTE the type carries nothing
 *     else, so its switch can say "always sent".
 */
export const REQUIRED_BY_ROLE: Record<ChoosingRole, ReadonlySet<NotificationKind>> = {
  GUARDIAN: new Set(['ABSENCE_UNREPORTED']),
  STUDENT: new Set(),
  TEACHER: new Set(['LESSON_COVER_WITHDRAWN', 'SUPERVISION_COVER', 'SUPERVISION_COVER_WITHDRAWN']),
  SCHOOL_ADMIN: new Set(['LESSON_COVER_WITHDRAWN', 'SUPERVISION_COVER', 'SUPERVISION_COVER_WITHDRAWN']),
};

/**
 * Whether one notice is delivered whatever its recipients chose: the unreported
 * absence, a substitute's own booking (LESSON_SUBSTITUTE with meta.cover ===
 * true — the type also carries the class's "has a substitute") and its
 * withdrawal, a rastvaktspass booked and withdrawn (20261210090000), and an
 * alarm and its end (Krisläge, 20270113090000).
 */
export function deliveredRegardless(type: NotificationKind, meta: Record<string, unknown>): boolean {
  return (
    type === 'ABSENCE_UNREPORTED' ||
    type === 'CRISIS_ALARM' ||
    type === 'CRISIS_ENDED' ||
    type === 'LESSON_COVER_WITHDRAWN' ||
    type === 'SUPERVISION_COVER' ||
    type === 'SUPERVISION_COVER_WITHDRAWN' ||
    (type === 'LESSON_SUBSTITUTE' && meta['cover'] === true)
  );
}

/** Never e-mailed or pushed: a colleague's absence is HR data, kept in the admins' inbox. */
export const NEVER_EXTERNAL: ReadonlySet<NotificationKind> = new Set(['TEACHER_ABSENCE_REPORTED']);

export function isChoosingRole(role: string): role is ChoosingRole {
  return Object.prototype.hasOwnProperty.call(TYPES_BY_ROLE, role);
}
