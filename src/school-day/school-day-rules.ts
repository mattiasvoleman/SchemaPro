import { holdsTime, occupancyFindings, overlaps, poolNotDeclared, type PersonDay, type Span } from '../cover/cover-rules';
import type { RoomBusyCode, TeacherBusyCode } from './school-day.types';

/*
 * SKOLANS DAG: WHO AND WHAT IS FREE, AS PURE RULES.
 *
 * A teacher is free over an interval when the Vikarietavla's rules for
 * OCCUPIED find nothing (cover-rules.ts occupancyFindings, lifted out of
 * hardFindings so that the two cannot drift): not absent (ABSENT), not in a
 * lesson that holds its time (BUSY_LESSON; a cancelled lesson frees the
 * teacher), not on a rastvaktspass (BUSY_SUPERVISION), not inside an uppdrag's
 * slot (BUSY_DUTY) or a closure (UNAVAILABLE), not holding a room booking
 * (BOOKED_ROOM), and, for a member of the substitute pool without a post,
 * inside a window they declared (POOL_NOT_DECLARED).
 *
 * The rules of hardFindings that do NOT apply, because they answer another
 * question — may we ask this person to cover — are LUNCH, DAILY_REST,
 * DAILY_CAP, CONSECUTIVE_TEACHING and WORK_DAYS. A teacher who is free here
 * can still be refused there; the page says so.
 *
 * A room is free when no lesson that holds its time uses it (ROOM_IN_USE),
 * no booking in PENDING or APPROVED holds it (ROOM_BOOKED: the EXCLUDE
 * constraint of RoomBookings holds a room for a request too), no closure for
 * the room covers the time (ROOM_CLOSED), and the loans between this school
 * and another leave it to this school then (the booking page's own rule,
 * room-bookings/loan-holds.ts: ROOM_LENT when it is lent out in an approved
 * window, ROOM_BORROWED_OUTSIDE_LOAN when it is the school's room for a
 * borrowed one and the loans do not cover the interval). The test for "holds
 * its time" is the Vikarietavla's holdsTime.
 *
 * Touching is free everywhere: a lesson that ends at 10:00 does not make its
 * teacher busy at 10:00 (cover-rules.ts overlaps).
 */

export interface RoomDay {
  roomId: string;
  lessons: Array<{ id: string; start: number; end: number; status: 'SCHEDULED' | 'CANCELLED' | 'COMPLETED' | 'RESCHEDULED' }>;
  bookings: Span[];
  closures: Span[];
  /** What loanBookingRefusal says of the interval for this room; none for a room no loan names. */
  loan?: 'ROOM_LENT' | 'ROOM_BORROWED_OUTSIDE_LOAN' | null;
}

/** The rules that say a room is not free over the span, each once, in the order of the header. */
export function roomFindings(day: RoomDay, span: Span): RoomBusyCode[] {
  const codes: RoomBusyCode[] = [];
  if (day.lessons.some((lesson) => holdsTime(lesson) && overlaps(lesson, span))) {
    codes.push('ROOM_IN_USE');
  }
  if (day.bookings.some((booking) => overlaps(booking, span))) codes.push('ROOM_BOOKED');
  if (day.closures.some((closure) => overlaps(closure, span))) codes.push('ROOM_CLOSED');
  if (day.loan) codes.push(day.loan);
  return codes;
}

export interface TeacherFreedom {
  free: boolean;
  reasons: TeacherBusyCode[];
}

/**
 * Whether a teacher is free over the span, and by which rules they are not.
 * An inactive person is no teacher of the school's day and never reaches
 * here; the caller leaves them out.
 */
export function teacherFreedom(day: PersonDay, span: Span): TeacherFreedom {
  const reasons: TeacherBusyCode[] = [];
  for (const finding of occupancyFindings(day, span)) {
    if (!reasons.includes(finding.code as TeacherBusyCode)) reasons.push(finding.code as TeacherBusyCode);
  }
  if (poolNotDeclared(day, span)) reasons.push('POOL_NOT_DECLARED');
  return { free: reasons.length === 0, reasons };
}

/** The Vikarietavla's occupied rules a teacher is asked, in order: the page names them. */
export const TEACHER_RULES: readonly TeacherBusyCode[] = [
  'ABSENT',
  'BUSY_LESSON',
  'BUSY_SUPERVISION',
  'BUSY_DUTY',
  'UNAVAILABLE',
  'BOOKED_ROOM',
  'POOL_NOT_DECLARED',
];

export const ROOM_RULES: readonly RoomBusyCode[] = ['ROOM_IN_USE', 'ROOM_BOOKED', 'ROOM_CLOSED', 'ROOM_LENT', 'ROOM_BORROWED_OUTSIDE_LOAN'];

/**
 * Minutes since the school's local midnight, by the wall clock. Cached per
 * instant: a school has a few dozen distinct start and end instants a day.
 * DST-safe by construction: the clock is read through Intl in the school's
 * timezone, never by subtracting midnight (a day of 23 or 25 hours would be
 * wrong after the change).
 */
export function wallClockMinutes(timeZone: string): (instant: number) => number {
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const cache = new Map<number, number>();
  return (instant) => {
    const cached = cache.get(instant);
    if (cached !== undefined) return cached;
    let hours = 0;
    let minutes = 0;
    for (const part of formatter.formatToParts(new Date(instant))) {
      if (part.type === 'hour') hours = Number(part.value);
      else if (part.type === 'minute') minutes = Number(part.value);
    }
    const value = (hours === 24 ? 0 : hours) * 60 + minutes;
    cache.set(instant, value);
    return value;
  };
}

/**
 * A span clipped to one local day, in minutes on that day: 0 for an instant
 * at or before the day's start, 1440 for one at or after its end (the next
 * midnight reads as 24:00 and not as 00:00).
 */
export function clipToDay(
  span: Span,
  day: { start: number; end: number },
  clock: (instant: number) => number,
): { start: number; end: number } | null {
  if (span.end <= day.start || span.start >= day.end) return null;
  const start = span.start <= day.start ? 0 : clock(span.start);
  const end = span.end >= day.end ? 1440 : clock(span.end);
  return end > start ? { start, end } : null;
}
