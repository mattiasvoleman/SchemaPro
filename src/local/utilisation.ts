import { zonedTimeToUtc } from '../common/utils/time';
import { wallClockMinutes } from '../school-day/school-day-rules';
import { addDays, datesBetween, isoWeekdayOf, mondayOf } from './external-rule';
import { mergeWindows, schoolWindows, type FrameLike, type Window } from './school-time';
import type { UtilisationBucket, UtilisationRow } from './local-types';

/*
 * UTNYTTJANDE: HOW MUCH OF A ROOM'S OR A RESOURCE'S TIME IS HELD.
 *
 * Two shares, each a booked time over a time that could be booked:
 *
 *   SCHOOL TIME     the school's windows on a teaching day (school-time.ts: the
 *                   frames of the years the room may host, nothing on a day of a
 *                   lov for the whole school or with no frame). Held by lessons
 *                   and bookings alike.
 *   OUTSIDE         the open hours (07:00-22:00 unless asked) that are NOT school
 *                   time: evenings, weekends and the lov. A day that is not a
 *                   school day is open all of its open hours.
 *
 * "Booked" is what holds the room: a lesson that holds its time (SCHEDULED or
 * COMPLETED) and a booking in APPROVED, an external hire among them. A booking
 * still waiting for a decision (PENDING) is not use yet. Held time counts once
 * where a lesson and a booking overlap (the room is held, however many ask).
 * For a resource of more than one the unit is the unit-minute: 30 tablets held
 * for an hour by 10 is 600 of the 1800 unit-minutes of that hour.
 *
 * The figures are minutes of the school's own clock, kept per week (Monday to
 * Sunday, a week cut by the period's ends is the part inside it) and for the
 * period. A day is read on the school's clock: a day with a change of summer time
 * has 23 or 25 hours, and the instants of that day are read through the zone, not
 * by subtracting midnight.
 *
 * PURE. The caller reads the frames, the lov and what holds each room.
 */

/** A time something holds, and how many it takes of what there is (1 for a room). */
export interface HeldInterval {
  /** ms since the epoch. */
  start: number;
  end: number;
  quantity: number;
}

export interface UtilisationTarget {
  kind: 'ROOM' | 'RESOURCE';
  id: string;
  name: string;
  /** How many there are: 1 for a room. */
  capacity: number;
  /** The years the room may host; null for any (and always null for a resource). */
  years: { min: number | null; max: number | null };
  held: readonly HeldInterval[];
}

export interface UtilisationInput {
  from: string;
  to: string;
  timeZone: string;
  frames: readonly FrameLike[];
  holidays: ReadonlySet<string>;
  /** The open hours, minutes since midnight. */
  open: Window;
  targets: readonly UtilisationTarget[];
}

const DAY_MS = 86_400_000;

interface DayFrame {
  date: string;
  startMs: number;
  endMs: number;
  /** A day of 23 or 25 hours: its instants are read through the zone. */
  shifted: boolean;
}

function emptyBucket(): UtilisationBucket {
  return { schoolMinutes: 0, bookedSchoolMinutes: 0, schoolShare: null, outsideMinutes: 0, bookedOutsideMinutes: 0, outsideShare: null };
}

function share(booked: number, of: number): number | null {
  return of > 0 ? Math.round((booked / of) * 10_000) / 10_000 : null;
}

function finish(bucket: UtilisationBucket): UtilisationBucket {
  bucket.schoolShare = share(bucket.bookedSchoolMinutes, bucket.schoolMinutes);
  bucket.outsideShare = share(bucket.bookedOutsideMinutes, bucket.outsideMinutes);
  return bucket;
}

function add(into: UtilisationBucket, part: UtilisationBucket): void {
  into.schoolMinutes += part.schoolMinutes;
  into.bookedSchoolMinutes += part.bookedSchoolMinutes;
  into.outsideMinutes += part.outsideMinutes;
  into.bookedOutsideMinutes += part.bookedOutsideMinutes;
}

/** The part of [open] that is not inside any of the (merged, ordered) school windows. */
function outsideWindows(open: Window, school: readonly Window[]): Window[] {
  const outside: Window[] = [];
  let cursor = open.start;
  for (const window of school) {
    if (window.end <= open.start || window.start >= open.end) continue;
    if (window.start > cursor) outside.push({ start: cursor, end: Math.min(window.start, open.end) });
    cursor = Math.max(cursor, window.end);
  }
  if (cursor < open.end) outside.push({ start: cursor, end: open.end });
  return outside;
}

/** Unit-minutes held inside each window: the sweep over the held pieces, capped at the capacity. */
function heldWithin(pieces: ReadonlyArray<{ start: number; end: number; quantity: number }>, windows: readonly Window[], capacity: number): number {
  if (pieces.length === 0 || windows.length === 0) return 0;
  const edges = new Set<number>();
  for (const piece of pieces) {
    edges.add(piece.start);
    edges.add(piece.end);
  }
  for (const window of windows) {
    edges.add(window.start);
    edges.add(window.end);
  }
  const points = [...edges].sort((a, b) => a - b);
  let minutes = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const from = points[i];
    const to = points[i + 1];
    if (!windows.some((window) => window.start <= from && to <= window.end)) continue;
    let held = 0;
    for (const piece of pieces) {
      if (piece.start <= from && to <= piece.end) held += piece.quantity;
    }
    minutes += Math.min(held, capacity) * (to - from);
  }
  return minutes;
}

function dayFrameOf(date: string, timeZone: string): DayFrame {
  const startMs = zonedTimeToUtc(date, '00:00', timeZone).getTime();
  const endMs = zonedTimeToUtc(addDays(date, 1), '00:00', timeZone).getTime();
  return { date, startMs, endMs, shifted: endMs - startMs !== DAY_MS };
}

export function utilisation(input: UtilisationInput): { weekStarts: string[]; rows: UtilisationRow[] } {
  const dates = datesBetween(input.from, input.to);
  const weekStarts = [...new Set(dates.map(mondayOf))];
  const frames = new Map(dates.map((date) => [date, dayFrameOf(date, input.timeZone)]));
  const clock = wallClockMinutes(input.timeZone);
  const firstMs = frames.get(input.from)?.startMs ?? 0;

  const rows: UtilisationRow[] = input.targets.map((target) => {
    // Held pieces by the UTC-day bucket they start in, and in every later bucket they reach,
    // so a day looks in three buckets and meets only what is near it.
    const buckets = new Map<number, HeldInterval[]>();
    for (const piece of target.held) {
      const first = Math.floor((piece.start - firstMs + DAY_MS) / DAY_MS);
      const last = Math.floor((piece.end - 1 - firstMs + DAY_MS) / DAY_MS);
      for (let key = first; key <= last; key++) {
        const list = buckets.get(key);
        if (list) list.push(piece);
        else buckets.set(key, [piece]);
      }
    }

    const total = emptyBucket();
    const weeks = new Map<string, UtilisationBucket>(weekStarts.map((start) => [start, emptyBucket()]));

    for (const date of dates) {
      const frame = frames.get(date) as DayFrame;
      const dayKey = Math.floor((frame.startMs - firstMs + DAY_MS) / DAY_MS);
      const near = new Set<HeldInterval>();
      for (const key of [dayKey - 1, dayKey, dayKey + 1]) {
        for (const piece of buckets.get(key) ?? []) {
          if (piece.start < frame.endMs && frame.startMs < piece.end) near.add(piece);
        }
      }
      const minutesOf = (instant: number): number =>
        instant <= frame.startMs ? 0 : instant >= frame.endMs ? 24 * 60 : frame.shifted ? clock(instant) : Math.round((instant - frame.startMs) / 60_000);
      const pieces = [...near].map((piece) => ({ start: minutesOf(piece.start), end: minutesOf(piece.end) || 24 * 60, quantity: piece.quantity }));

      const school = input.holidays.has(date) ? [] : schoolWindows(input.frames, isoWeekdayOf(date), target.years);
      const outside = outsideWindows(input.open, mergeWindows(school));
      const part = emptyBucket();
      part.schoolMinutes = school.reduce((sum, window) => sum + (window.end - window.start), 0) * target.capacity;
      part.outsideMinutes = outside.reduce((sum, window) => sum + (window.end - window.start), 0) * target.capacity;
      part.bookedSchoolMinutes = heldWithin(pieces, school, target.capacity);
      part.bookedOutsideMinutes = heldWithin(pieces, outside, target.capacity);
      add(total, part);
      add(weeks.get(mondayOf(date)) as UtilisationBucket, part);
    }

    return {
      kind: target.kind,
      id: target.id,
      name: target.name,
      unit: target.capacity > 1 ? ('UNIT_MINUTES' as const) : ('MINUTES' as const),
      total: finish(total),
      weeks: weekStarts.map((weekStart) => ({ weekStart, ...finish(weeks.get(weekStart) as UtilisationBucket) })),
    };
  });

  return { weekStarts, rows };
}
