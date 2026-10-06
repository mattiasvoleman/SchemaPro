import type { LessonRecurrence } from '@prisma/client';
import { isoWeekNumber } from '../calendar/lesson-recurrence';

/*
 * How many weeks a requirement is taught in, and how heavy its busiest week is.
 *
 * A PORT OF web/lib/teaching-hours.ts, not a second opinion on it. The web has
 * carried this arithmetic since the timplan page learned to show hours per
 * year: ISO-week identity, "varannan vecka" read off the ISO week number and
 * never counted from term start, lov and studiedagar subtracted as fifths of a
 * Mon-Fri week, a partly covered edge week charged whole. The staffing report
 * needs the same numbers in the gateway — the SS12000 duties export and the
 * SCB CSV will read them from here, and a teacher's standardvecka must agree
 * with the group's hours a rektor already sees — so the module is written out
 * again on this side of the boundary rather than imported across it (the two
 * packages share no build), and the two copies replay one fixture:
 * src/staffing/__fixtures__/teaching-weeks-cases.json, asserted by
 * teaching-weeks.contract.spec.ts here and teaching-hours.contract.test.ts in
 * the web. A case is added for both sides at once.
 *
 * TWO DIFFERENCES FROM THE WEB COPY, BOTH DELIBERATE AND NEITHER CHANGING AN
 * ANSWER. Dates are handled in UTC throughout — the gateway stores a @db.Date
 * as midnight UTC and runs its suites under TZ=UTC, while the browser lives in
 * local time — and the ISO week number comes from the one function this
 * package already treats as canonical, src/calendar/lesson-recurrence.ts, so
 * that a week the publisher materialises a lesson in is a week this module
 * counts. The web copy carries its own Jan-1 formulation and pins the
 * agreement with an oracle test; the fixture pins it from this side.
 *
 * What the numbers mean and do not mean is argued at length in the web file's
 * header and is not repeated here beyond the one sentence that matters for a
 * load report: these are PLANNED weeks at requirement level. A requirement
 * carries lessonsPerWeek and no weekday, so a studiedag is charged as a fifth
 * of the week whichever day it fell on — right over a term, wrong for the
 * single week anybody points at.
 */

export type Recurrence = LessonRecurrence;

export interface TeachingPeriod {
  /** Absent or null reads as ALL_WEEKS, matching RecurrenceWindow. */
  recurrence?: Recurrence | null;
  /** Inclusive yyyy-mm-dd; null means "from the start of the year". */
  startDate?: string | null;
  /** Inclusive yyyy-mm-dd; null means "until the year ends". */
  endDate?: string | null;
}

/** The academic year the period is measured inside. Both bounds inclusive. */
export interface YearBounds {
  startDate: string;
  endDate: string;
}

/** One SchoolBreak row, narrowed to what an hours count needs. */
export interface ClosedRange {
  startDate: string;
  endDate: string;
  /** Both null (or absent): the whole school. A span closes only its grades. */
  minGradeLevel?: number | null;
  maxGradeLevel?: number | null;
}

/**
 * Seven: a week exists for a period when the period covers ANY of its days,
 * because Lesson.dayOfWeek runs 1-7 and runsOn never looks at the weekday.
 */
const DAYS_IN_WEEK = 7;

/**
 * Five: the denominator a closure is measured against. A studiedag takes a
 * fifth of a teaching week, not a seventh — the Saturday it did not fall on
 * never carried a share of the lessons.
 */
const TEACHING_DAYS_IN_WEEK = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

interface TaughtWindow {
  from: string;
  to: string;
  recurrence: Recurrence;
}

/** yyyy-mm-dd as midnight UTC — the instant a @db.Date column holds. */
function parseDay(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** Midnight UTC back to yyyy-mm-dd. */
function toDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/** The Monday of the ISO week holding `date`, at midnight UTC. */
function mondayOf(date: Date): Date {
  const weekday = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
  return addDays(date, 1 - weekday);
}

/**
 * The period's own bounds, narrowed to the year. Strings compare as dates
 * because they are yyyy-mm-dd. Null when nothing is left.
 */
function clampToYear(period: TeachingPeriod, year: YearBounds): TaughtWindow | null {
  const from =
    period.startDate && period.startDate > year.startDate
      ? period.startDate
      : year.startDate;
  const to =
    period.endDate && period.endDate < year.endDate ? period.endDate : year.endDate;
  if (from > to) return null;
  return { from, to, recurrence: period.recurrence ?? 'ALL_WEEKS' };
}

/** The parity branch of runsOn, on the ISO week number of the week's Monday. */
function runsInWeek(recurrence: Recurrence, monday: Date): boolean {
  if (recurrence === 'ALL_WEEKS') return true;
  const odd = isoWeekNumber(monday) % 2 === 1;
  return recurrence === 'ODD_WEEKS' ? odd : !odd;
}

/** The Monday of every ISO week that [from, to] touches at all. */
function mondaysBetween(from: string, to: string): Date[] {
  const first = mondayOf(parseDay(from));
  if (Number.isNaN(first.getTime())) return [];
  const mondays: Date[] = [];
  for (let monday = first; toDay(monday) <= to; monday = addDays(monday, 7)) {
    mondays.push(monday);
  }
  return mondays;
}

/** Whether the window puts teaching into the ISO week starting on `monday`. */
function teachesInWeek(window: TaughtWindow, monday: Date): boolean {
  const weekStart = toDay(monday);
  const weekEnd = toDay(addDays(monday, DAYS_IN_WEEK - 1));
  if (weekEnd < window.from || weekStart > window.to) return false;
  return runsInWeek(window.recurrence, monday);
}

/**
 * How many calendar weeks of the year the period is taught in. Lov count as
 * taught here on purpose: this is the figure the peak is measured with, and a
 * lov week must not drag the busiest week down.
 */
export function weeksInPeriod(period: TeachingPeriod, year: YearBounds): number {
  const window = clampToYear(period, year);
  if (!window) return 0;
  let weeks = 0;
  for (const monday of mondaysBetween(window.from, window.to)) {
    if (teachesInWeek(window, monday)) weeks += 1;
  }
  return weeks;
}

/**
 * Whether a closure reaches a grade. No grade asked about means a school-wide
 * question, which a grade-spanned closure does not answer; årskurs 0 is a real
 * grade, so the test is on null, never on falsiness.
 */
function closesForGrade(closure: ClosedRange, gradeLevel?: number | null): boolean {
  const min = closure.minGradeLevel ?? null;
  const max = closure.maxGradeLevel ?? null;
  if (min === null && max === null) return true;
  if (gradeLevel === null || gradeLevel === undefined) return false;
  if (min !== null && gradeLevel < min) return false;
  if (max !== null && gradeLevel > max) return false;
  return true;
}

/**
 * Mon-Fri days of the week that are inside the window AND closed. `some` per
 * day, so two lov claiming one day close it once and a week never loses more
 * than five; trimmed to the window, so a lov on a Monday the period has not
 * started on yet subtracts nothing.
 */
function closedTeachingDays(
  monday: Date,
  closures: ClosedRange[],
  window: TaughtWindow,
): number {
  let closed = 0;
  for (let offset = 0; offset < TEACHING_DAYS_IN_WEEK; offset += 1) {
    const day = toDay(addDays(monday, offset));
    if (day < window.from || day > window.to) continue;
    if (closures.some((closure) => day >= closure.startDate && day <= closure.endDate)) {
      closed += 1;
    }
  }
  return closed;
}

/**
 * The weeks of the period, weighted by how much of each is taught: 1 for an
 * ordinary week, 0.8 with one studiedag, 0 for a full lov week. Without
 * closures it is weeksInPeriod's own integer, exactly — the short-circuit at
 * the end is what makes that an identity rather than a rounding.
 */
export function teachingWeeks(
  period: TeachingPeriod,
  year: YearBounds,
  closures?: ClosedRange[],
  gradeLevel?: number | null,
): number {
  const window = clampToYear(period, year);
  if (!window) return 0;

  const applicable = (closures ?? []).filter((closure) =>
    closesForGrade(closure, gradeLevel),
  );

  let taughtDays = 0;
  let weeks = 0;
  for (const monday of mondaysBetween(window.from, window.to)) {
    if (!teachesInWeek(window, monday)) continue;
    weeks += 1;
    taughtDays += TEACHING_DAYS_IN_WEEK - closedTeachingDays(monday, applicable, window);
  }

  if (applicable.length === 0) return weeks;
  return taughtDays / TEACHING_DAYS_IN_WEEK;
}

/**
 * The busiest week per key — per teacher, here — summing `loadOf` over the
 * items taught in each ISO week of the year. Every key present appears, 0
 * included. Parities never add; non-overlapping terms never add; the same
 * parity and overlapping terms do. Lov are NOT subtracted: the peak asks
 * whether a week fits, and a lov week holds nothing to fit.
 */
export function peakPerWeekByKey<T extends TeachingPeriod>(
  items: T[],
  year: YearBounds,
  keyOf: (item: T) => string,
  loadOf: (item: T) => number,
): Map<string, number> {
  const windows = items.map((item) => ({
    key: keyOf(item),
    window: clampToYear(item, year),
    load: loadOf(item),
  }));

  const peaks = new Map<string, number>();
  for (const { key } of windows) if (!peaks.has(key)) peaks.set(key, 0);

  for (const monday of mondaysBetween(year.startDate, year.endDate)) {
    const week = new Map<string, number>();
    for (const { key, window, load } of windows) {
      if (window && teachesInWeek(window, monday)) {
        week.set(key, (week.get(key) ?? 0) + load);
      }
    }
    for (const [key, load] of week) {
      if (load > (peaks.get(key) ?? 0)) peaks.set(key, load);
    }
  }
  return peaks;
}
