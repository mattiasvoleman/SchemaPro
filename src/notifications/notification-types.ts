import type { NotificationKind } from './notifications.service';

/**
 * Which notice types a person may choose about, by role, and which of them
 * the school must deliver whatever the person chose.
 *
 * The lists are what each role actually receives today (the recipients of
 * notifyUsers' callers): families the lesson and schedule notices and their
 * own leave decisions; staff the lesson notices, their cover bookings and
 * their room bookings. TEACHER_ABSENCE_REPORTED is in nobody's list: it never
 * leaves the inbox, so a switch for it would do nothing.
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
];

type ChoosingRole = 'GUARDIAN' | 'STUDENT' | 'TEACHER' | 'SCHOOL_ADMIN';

const STAFF: readonly NotificationKind[] = [
  'LESSON_CANCELLED',
  'LESSON_SUBSTITUTE',
  'LESSON_COVER_WITHDRAWN',
  'LESSON_ROOM_CHANGED',
  'ROOM_BOOKING_DECIDED',
];

export const TYPES_BY_ROLE: Record<ChoosingRole, readonly NotificationKind[]> = {
  GUARDIAN: ['LESSON_CANCELLED', 'LESSON_SUBSTITUTE', 'LESSON_ROOM_CHANGED', 'SCHEDULE_CHANGED', 'LEAVE_DECIDED', 'ABSENCE_UNREPORTED'],
  STUDENT: ['LESSON_CANCELLED', 'LESSON_SUBSTITUTE', 'LESSON_ROOM_CHANGED', 'SCHEDULE_CHANGED', 'LEAVE_DECIDED'],
  TEACHER: STAFF,
  SCHOOL_ADMIN: STAFF,
};

/**
 * Shown to the role as "always sent", and refused if chosen:
 *
 *   * ABSENCE_UNREPORTED for a guardian — Skollagen 7 kap. 19 a §: the
 *     guardians are told the same day (also a CHECK in 20261013100000);
 *   * LESSON_COVER_WITHDRAWN for staff — vikarieplanering relies on the
 *     substitute being told that a booked lesson is off.
 */
export const REQUIRED_BY_ROLE: Record<ChoosingRole, ReadonlySet<NotificationKind>> = {
  GUARDIAN: new Set(['ABSENCE_UNREPORTED']),
  STUDENT: new Set(),
  TEACHER: new Set(['LESSON_COVER_WITHDRAWN']),
  SCHOOL_ADMIN: new Set(['LESSON_COVER_WITHDRAWN']),
};

/**
 * Whether one notice is delivered whatever its recipients chose: the unreported
 * absence, a substitute's own booking (LESSON_SUBSTITUTE with meta.cover ===
 * true — the type also carries the class's "has a substitute") and its
 * withdrawal.
 */
export function deliveredRegardless(type: NotificationKind, meta: Record<string, unknown>): boolean {
  return (
    type === 'ABSENCE_UNREPORTED' ||
    type === 'LESSON_COVER_WITHDRAWN' ||
    (type === 'LESSON_SUBSTITUTE' && meta['cover'] === true)
  );
}

/** Never e-mailed or pushed: a colleague's absence is HR data, kept in the admins' inbox. */
export const NEVER_EXTERNAL: ReadonlySet<NotificationKind> = new Set(['TEACHER_ABSENCE_REPORTED']);

export function isChoosingRole(role: string): role is ChoosingRole {
  return Object.prototype.hasOwnProperty.call(TYPES_BY_ROLE, role);
}
