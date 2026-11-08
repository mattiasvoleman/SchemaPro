import type { ExternalConflict } from './local-types';
import { clockOfMinutes, schoolWindows, type FrameLike } from './school-time';

/*
 * WHAT STANDS IN THE WAY OF A DAY OF A SERIES, AS PURE RULES.
 *
 * A day (a date, and a start and an end on the school's clock) of a room is
 * refused when
 *   LESSON   a lesson that holds its time (SCHEDULED or COMPLETED) uses the room;
 *   BOOKING  a booking in PENDING or APPROVED holds it (the EXCLUDE constraint of
 *            RoomBookings says the same, and is the last word);
 *   FRAME    the day falls inside the school's ramtid for the years the room may
 *            host (school-time.ts), unless a lov for the whole school takes the
 *            frames off the date;
 *   CLOSED   the room has a closure then (an availability constraint on the room);
 *   LOAN     the room is lent to another school then, or is the school's own for a
 *            borrowed one and the loans do not cover the time (loan-holds.ts);
 * and is only WARNED about when
 *   ACTIVITY a schemabrytande aktivitet has a lesson then. Its replacement
 *            lessons name no room, so the activity may use this one without
 *            anything saying so; the expedition looks.
 * A day of a resource is refused when the resource's quantity is used (BOOKING)
 * or the day falls in school time (FRAME). Touching is free: a lesson that ends
 * at 18:00 does not clash with a booking from 18:00.
 *
 * `label` is data, never prose, so that the web can say the kind in either
 * language: the lesson ("Matematik 7A"), the window ("08:00-15:00"), the closure's
 * reason, how many are held ("28 av 30"). It names no person.
 *
 * PURE.
 */

/** A span of real time held by something, with what the expedition reads of it. */
export interface HeldSpan {
  /** ms since the epoch. */
  start: number;
  end: number;
  label: string;
}

/** A closure of a room: on a date, or on a weekday every week. */
export interface ClosureLike {
  /** yyyy-mm-dd, or null for a weekly closure. */
  date: string | null;
  dayOfWeek: number | null;
  /** Minutes since the school's midnight. */
  start: number;
  end: number;
  reason: string;
}

export interface RoomFacts {
  lessons: readonly HeldSpan[];
  bookings: readonly HeldSpan[];
  closures: readonly ClosureLike[];
  activities: readonly HeldSpan[];
  loan?: (startsAt: Date, endsAt: Date) => 'ROOM_LENT' | 'ROOM_BORROWED_OUTSIDE_LOAN' | null;
}

export interface ResourceFacts {
  /** How many there are. */
  quantity: number;
  /** How many the day wants. */
  wanted: number;
  bookings: ReadonlyArray<{ start: number; end: number; quantity: number }>;
}

export interface DayToCheck {
  date: string;
  /** ISO weekday 1-7. */
  weekday: number;
  startsAt: Date;
  endsAt: Date;
  /** The school's clock, minutes since midnight. */
  startMinute: number;
  endMinute: number;
}

export interface SchoolFacts {
  /** The school's frames; empty when it declared none (then FRAME is not asked). */
  frames: readonly FrameLike[];
  /** Dates with a lov for the whole school. */
  holidays: ReadonlySet<string>;
  /** The years the room may host; null for any. */
  years: { min: number | null; max: number | null };
}

const BLOCK = 'BLOCK' as const;

function sharesTime(span: { start: number; end: number }, day: DayToCheck): boolean {
  return span.start < day.endsAt.getTime() && day.startsAt.getTime() < span.end;
}

function frameConflict(day: DayToCheck, school: SchoolFacts): ExternalConflict | null {
  if (school.frames.length === 0 || school.holidays.has(day.date)) return null;
  const hit = schoolWindows(school.frames, day.weekday, school.years).find(
    (window) => window.start < day.endMinute && day.startMinute < window.end,
  );
  return hit ? { kind: 'FRAME', severity: BLOCK, label: `${clockOfMinutes(hit.start)}-${clockOfMinutes(hit.end)}` } : null;
}

function distinct(conflicts: ExternalConflict[]): ExternalConflict[] {
  const seen = new Set<string>();
  return conflicts.filter((conflict) => {
    const key = `${conflict.kind}|${conflict.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function roomDayConflicts(day: DayToCheck, facts: RoomFacts, school: SchoolFacts): ExternalConflict[] {
  const conflicts: ExternalConflict[] = [];
  for (const lesson of facts.lessons) {
    if (sharesTime(lesson, day)) conflicts.push({ kind: 'LESSON', severity: BLOCK, label: lesson.label });
  }
  for (const booking of facts.bookings) {
    if (sharesTime(booking, day)) conflicts.push({ kind: 'BOOKING', severity: BLOCK, label: booking.label });
  }
  const frame = frameConflict(day, school);
  if (frame) conflicts.push(frame);
  for (const closure of facts.closures) {
    const onTheDay = closure.date !== null ? closure.date === day.date : closure.dayOfWeek === day.weekday;
    if (onTheDay && closure.start < day.endMinute && day.startMinute < closure.end) {
      conflicts.push({ kind: 'CLOSED', severity: BLOCK, label: closure.reason });
    }
  }
  const loan = facts.loan?.(day.startsAt, day.endsAt);
  if (loan) conflicts.push({ kind: 'LOAN', severity: BLOCK, label: loan });
  for (const activity of facts.activities) {
    if (sharesTime(activity, day)) conflicts.push({ kind: 'ACTIVITY', severity: 'WARN', label: activity.label });
  }
  return distinct(conflicts);
}

/** The most a list of bookings holds at one instant inside [start, end): reached at a start, so look at each. */
export function mostHeld(bookings: ReadonlyArray<{ start: number; end: number; quantity: number }>, start: number, end: number): number {
  const inside = bookings.filter((booking) => booking.start < end && start < booking.end);
  const moments = [start, ...inside.map((booking) => booking.start).filter((at) => at > start && at < end)];
  let most = 0;
  for (const at of moments) {
    let held = 0;
    for (const booking of inside) {
      if (booking.start <= at && at < booking.end) held += booking.quantity;
    }
    most = Math.max(most, held);
  }
  return most;
}

export function resourceDayConflicts(day: DayToCheck, facts: ResourceFacts, school: SchoolFacts): ExternalConflict[] {
  const conflicts: ExternalConflict[] = [];
  const held = mostHeld(facts.bookings, day.startsAt.getTime(), day.endsAt.getTime());
  if (held + facts.wanted > facts.quantity) {
    conflicts.push({ kind: 'BOOKING', severity: BLOCK, label: `${held} av ${facts.quantity}` });
  }
  const frame = frameConflict(day, school);
  if (frame) conflicts.push(frame);
  return conflicts;
}

export function isBlocked(conflicts: readonly ExternalConflict[]): boolean {
  return conflicts.some((conflict) => conflict.severity === 'BLOCK');
}
