/*
 * HÅLTIMMAR, COUNTED AS THE REPORT COUNTS THEM.
 *
 * The håltimmesrapport (web/lib/gaps.ts findIdleGaps), the generator's pupil
 * objective (optimization-engine/app/solver/pupil_gaps.py pupil_idle_minutes)
 * and this module give one number for one timetable. The contract is the
 * fixture src/common/__fixtures__/pupil-gaps-cases.json, replayed by the
 * report, the engine and swap-gaps.spec.ts. This file is the engine's
 * day_idle_minutes and closed_minutes in TypeScript, nothing more; a rule
 * changed there is changed here, and the fixture says when they differ.
 *
 *   A pupil's day runs from the first lesson to the last. What lies between
 *   them and is not a lesson, a closure (a weekly rule on the class or on its
 *   years, the hours a ramtid closes) or lunch is a hole, and a hole of 15
 *   minutes or more is a håltimme. Lunch is handed out once a day, in clock
 *   order, to the holes it overlaps. A lesson on odd weeks only leaves its
 *   hour empty on the even ones: an ordinary week is half of each.
 *
 * PURE. Minutes after midnight.
 */

import type { LessonRecurrence } from '@prisma/client';

/** A hole shorter than this is the changeover between two lessons: a rast. */
export const MINIMUM_GAP_MINUTES = 15;

const DAY_MINUTES = 24 * 60;

export type Interval = readonly [start: number, end: number];

/** The school's lunch rule: the window and the minutes handed out inside it. */
export interface LunchRule {
  start: number;
  end: number;
  minutes: number;
}

/** A weekly closure the rules put on a class or on years: minutes of one weekday. */
export interface GapConstraint {
  kind: 'STUDENT_GROUP' | 'GRADE_LEVEL';
  group: string | null;
  min: number | null;
  max: number | null;
  /** ISO weekday, or null for every day. */
  day: number | null;
  start: number;
  end: number;
}

/** A ramtid: the hours a stage is taught in (frame-times.ts). */
export interface GapFrame {
  min: number;
  max: number;
  day: number | null;
  start: number;
  end: number;
}

export type GapSpan = readonly [min: number, max: number];

/** Touching intervals join (lib/gaps.ts mergeIntervals). */
export function mergeIntervals(intervals: Iterable<Interval>): Array<[number, number]> {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

function freeBetween(busy: readonly Interval[], low: number, high: number): Array<[number, number]> {
  const free: Array<[number, number]> = [];
  let cursor = low;
  for (const [start, end] of busy) {
    if (start >= high) break;
    if (start > cursor) free.push([cursor, start]);
    cursor = Math.max(cursor, end);
    if (cursor >= high) break;
  }
  if (cursor < high) free.push([cursor, high]);
  return free;
}

/**
 * One body's idle minutes on one day: the engine's day_idle_minutes.
 *
 * `lessons` are the body's own intervals, margins included; `closures` the
 * rules'. Holes are counted between the first lesson and the last.
 */
export function dayIdleMinutes(
  lessons: readonly Interval[],
  closures: readonly Interval[],
  lunch: LunchRule | null,
  minimumGap: number = MINIMUM_GAP_MINUTES,
): number {
  const taught = mergeIntervals(lessons.filter((interval) => interval[1] > interval[0]));
  if (taught.length === 0) return 0;
  const occupied = mergeIntervals([...taught, ...closures]);
  let remaining = lunch ? lunch.minutes : 0;
  let idle = 0;
  for (const [start, end] of freeBetween(occupied, taught[0]![0], taught[taught.length - 1]![1])) {
    const overlap = lunch ? Math.min(end, lunch.end) - Math.max(start, lunch.start) : 0;
    const credit = Math.min(Math.max(overlap, 0), remaining);
    remaining -= credit;
    if (end - start - credit >= minimumGap) idle += end - start - credit;
  }
  return idle;
}

/** lib/frame-times.ts frameWindow: the intersection of the frames reaching the span. */
export function frameWindow(frames: readonly GapFrame[], span: GapSpan, day: number): Interval | null {
  let start = 0;
  let end = DAY_MINUTES;
  for (const frame of frames) {
    if (frame.day !== null && frame.day !== day) continue;
    if (span[1] < frame.min || span[0] > frame.max) continue;
    start = Math.max(start, frame.start);
    end = Math.min(end, frame.end);
  }
  return end > start ? [start, end] : null;
}

/** lib/grade-span.ts spanMeetsRule: overlap, a null bound open. */
function spanMeetsRule(span: GapSpan | undefined, constraint: GapConstraint): boolean {
  if (!span) return false;
  if (constraint.min !== null && span[1] < constraint.min) return false;
  return !(constraint.max !== null && span[0] > constraint.max);
}

/**
 * The minutes of one weekday a rule closes for a body's groups, unmerged
 * (the engine's closed_minutes): weekly rows on a group or reaching its
 * years, and the complement of each group's frame window. A group with no
 * known years is reached by neither years nor frames.
 */
export function closedMinutes(
  groups: readonly string[],
  day: number,
  spans: ReadonlyMap<string, GapSpan>,
  constraints: readonly GapConstraint[],
  frames: readonly GapFrame[],
): Array<[number, number]> {
  const distinct = [...new Set(groups)];
  const closures: Array<[number, number]> = [];
  for (const constraint of constraints) {
    if (constraint.day !== null && constraint.day !== day) continue;
    const applies =
      constraint.kind === 'STUDENT_GROUP'
        ? constraint.group !== null && distinct.includes(constraint.group)
        : distinct.some((group) => spanMeetsRule(spans.get(group), constraint));
    if (applies && constraint.start < constraint.end) closures.push([constraint.start, constraint.end]);
  }
  for (const group of distinct) {
    const span = spans.get(group);
    if (!span) continue;
    const window = frameWindow(frames, span, day);
    if (window === null) {
      closures.push([0, DAY_MINUTES]);
      continue;
    }
    if (window[0] > 0) closures.push([0, window[0]]);
    if (window[1] < DAY_MINUTES) closures.push([window[1], DAY_MINUTES]);
  }
  return closures;
}

/** An interval and the weeks it runs in: null is every week. */
export interface WeekInterval {
  start: number;
  end: number;
  runs: Exclude<LessonRecurrence, 'ALL_WEEKS'> | null;
}

const meet = (first: WeekInterval['runs'], second: WeekInterval['runs']): boolean =>
  first === null || second === null || first === second;

/** Whether any of these runs on alternate weeks only (weeks.py alternates). */
export const alternates = (intervals: Iterable<Pick<WeekInterval, 'runs'>>): boolean => {
  for (const interval of intervals) if (interval.runs !== null) return true;
  return false;
};

/** The recurrence a gap reads: a dated window counts as every week, as the engine reads it. */
export const parityOf = (recurrence: LessonRecurrence): WeekInterval['runs'] =>
  recurrence === 'ALL_WEEKS' ? null : recurrence;

/**
 * One body's idle minutes over a week, in halves: each alternating week
 * counted with the lessons that run in it, an ordinary week half of each.
 * Returns twice the figure so that it adds up exactly; the caller halves it.
 *
 * `both` is the body's week as a whole: a body with one alternating lesson
 * on any day has two weeks on every day (the engine's pupil_idle_minutes).
 */
export function dayIdleHalves(
  intervals: readonly WeekInterval[],
  both: boolean,
  closures: readonly Interval[],
  lunch: LunchRule | null,
  minimumGap: number = MINIMUM_GAP_MINUTES,
): number {
  if (!both) {
    return 2 * dayIdleMinutes(intervals.map((i) => [i.start, i.end] as const), closures, lunch, minimumGap);
  }
  let halves = 0;
  for (const parity of ['ODD_WEEKS', 'EVEN_WEEKS'] as const) {
    halves += dayIdleMinutes(
      intervals.filter((i) => meet(i.runs, parity)).map((i) => [i.start, i.end] as const),
      closures,
      lunch,
      minimumGap,
    );
  }
  return halves;
}
