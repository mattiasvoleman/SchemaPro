/*
 * SKOLTID: WHEN THE SCHOOL TEACHES, FROM ITS RAMTIDER AND ITS LOV.
 *
 * A frame (FrameTime) bounds the lessons of the years it names on the weekdays it
 * names: "åk 0-3 08:00-14:30 every teaching day", "åk 0-3 08:00-12:00 on
 * Friday". The frames that match a year COMPOSE by intersection (the window is
 * the latest start and the earliest end), which is how a weekday row narrows an
 * every-day row without a rule of precedence. A frame with no weekday is a
 * teaching day's, Monday to Friday.
 *
 * The school's time for a room is the UNION over the years that room may host
 * (all of them when it names none) of each year's window: while any of its years
 * is in school the room is in school time. A day with no frame for any of the
 * room's years has no school time, and neither has a whole-school lov, which
 * takes the frames off its days; a studiedag does not (staff are in the
 * building), nor does a lov for some years only.
 *
 * PURE.
 */

export interface FrameLike {
  minGradeLevel: number;
  maxGradeLevel: number;
  /** ISO weekday 1-7, or null for every teaching day (Monday to Friday). */
  dayOfWeek: number | null;
  /** Minutes since the school's midnight. */
  start: number;
  end: number;
}

export interface Window {
  start: number;
  end: number;
}

export interface BreakLike {
  kind: 'HOLIDAY' | 'STAFF_DAY';
  /** yyyy-mm-dd, inclusive. */
  startDate: string;
  endDate: string;
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
}

/** 'HH:MM' (or 'HH:MM:SS') as minutes since midnight. */
export function minutesOfClock(clock: string): number {
  const [hours, minutes] = clock.split(':');
  return Number(hours) * 60 + Number(minutes);
}

/** Minutes since midnight as 'HH:MM'. */
export function clockOfMinutes(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** Overlapping or touching windows merged, in order. */
export function mergeWindows(windows: readonly Window[]): Window[] {
  const sorted = windows.filter((window) => window.end > window.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Window[] = [];
  for (const window of sorted) {
    const last = merged[merged.length - 1];
    if (last && window.start <= last.end) last.end = Math.max(last.end, window.end);
    else merged.push({ ...window });
  }
  return merged;
}

/**
 * The windows in which the years `min`..`max` (null: all, 0-12) are in school on an ISO weekday.
 * Empty when no frame covers any of them that day.
 */
export function schoolWindows(
  frames: readonly FrameLike[],
  isoWeekday: number,
  years: { min: number | null; max: number | null } = { min: null, max: null },
): Window[] {
  const first = years.min ?? 0;
  const last = years.max ?? 12;
  const windows: Window[] = [];
  for (let year = first; year <= last; year++) {
    const matching = frames.filter(
      (frame) =>
        frame.minGradeLevel <= year &&
        year <= frame.maxGradeLevel &&
        (frame.dayOfWeek === null ? isoWeekday <= 5 : frame.dayOfWeek === isoWeekday),
    );
    if (matching.length === 0) continue;
    windows.push({
      start: Math.max(...matching.map((frame) => frame.start)),
      end: Math.min(...matching.map((frame) => frame.end)),
    });
  }
  return mergeWindows(windows);
}

/** The days in [from, to] with a lov that takes the whole school (no year named). */
export function wholeSchoolHolidays(breaks: readonly BreakLike[], from: string, to: string): Set<string> {
  const days = new Set<string>();
  for (const entry of breaks) {
    if (entry.kind !== 'HOLIDAY' || entry.minGradeLevel !== null || entry.maxGradeLevel !== null) continue;
    const start = entry.startDate > from ? entry.startDate : from;
    const end = entry.endDate < to ? entry.endDate : to;
    for (let at = Date.parse(`${start}T00:00:00.000Z`); at <= Date.parse(`${end}T00:00:00.000Z`); at += 86_400_000) {
      days.add(new Date(at).toISOString().slice(0, 10));
    }
  }
  return days;
}

/** Minutes of overlap between a window and a list of disjoint, ordered windows. */
export function overlapMinutes(span: Window, windows: readonly Window[]): number {
  let minutes = 0;
  for (const window of windows) {
    minutes += Math.max(0, Math.min(span.end, window.end) - Math.max(span.start, window.start));
  }
  return minutes;
}
