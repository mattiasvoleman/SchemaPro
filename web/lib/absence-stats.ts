/**
 * Frånvarostatistik över tid, the web's side of the views (the tab of
 * /admin/reports, and the mentor's page /teacher/absence-stats).
 *
 * The gateway (src/absence-stats/) counts every minute, in the database, by
 * the definition Frånvarobevakningen and the attendance report count by, and
 * hands the web finished minutes and percents. Nothing here counts absence:
 * this file types the answers, picks the period a read covers, groups months
 * under their läsår and scales a chart. absence-stats.test.ts reads the
 * gateway's file and fails when the bounds or the codes drift.
 *
 * A month with no figure is `figures: null` (fewer than MIN_GROUP pupils had a
 * mark): it is said as such and never drawn or written as 0. The same holds
 * for a pupil's month with no mark, which is "ingen registrering", not "ingen
 * frånvaro". Free of React and of imports, so a test can read it as it is.
 */

/** The smallest group a figure rests on (the gateway's MIN_GROUP and the database's CHECK). */
export const MIN_GROUP = 5;

/** The longest period one read covers, in days (the database refuses a longer one with a 400). */
export const MAX_PERIOD_DAYS = 1200;

/** The code of the 403 the huvudman's läsare gets for a pupil. */
export const NO_PUPILS_FOR_THE_READER = "ABSENCE_STATS_NO_PUPILS_FOR_THE_READER";

// ---------------------------------------------------------------------------
// The gateway's views (src/absence-stats/absence-stats.service.ts, absence-stats.ts)
// ---------------------------------------------------------------------------

/** The minutes of each kind and what they come to as a share of the recorded minutes (one decimal, percent). */
export interface Figures {
  recordedMinutes: number;
  validMinutes: number;
  absentMinutes: number;
  lateMinutes: number;
  lateCount: number;
  /** ABSENT + LATE: ogiltig frånvaro, as the report and the watch add it. */
  invalidMinutes: number;
  validPct: number | null;
  invalidPct: number | null;
  totalPct: number | null;
}

/** Held lessons and the share of them with a saved register. */
export interface Reporting {
  held: number;
  reported: number;
  ratePct: number | null;
}

export interface WindowView {
  /** The first day of the first month of the three läsår shown. */
  firstMonth: string;
  /** The school's today; the figures run to yesterday. */
  today: string;
  year: { name: string; from: string; to: string } | null;
  minGroup: number;
}

export interface SeriesMonthView {
  /** The month's first day. */
  month: string;
  /** The last day counted: the month's last, or yesterday for the month that is going on. */
  throughDay: string;
  /** The month is not over: its figures are of the days so far. */
  partial: boolean;
  /** The classes the row is of; empty for the school. */
  classNames: string[];
  pupils: number;
  pupilsRegistered: number;
  /** Null when fewer than MIN_GROUP pupils had a mark. */
  figures: Figures | null;
  reporting: Reporting;
  previousYear: { month: string; figures: Figures | null; reporting: Reporting } | null;
}

export interface SchoolStatsView {
  window: WindowView;
  series: SeriesMonthView[];
}

export interface ClassSummaryView {
  classId: string;
  className: string;
  yearName: string | null;
  monthsCounted: number;
  pupils: number;
  pupilsRegistered: number;
  figures: Figures | null;
  reporting: Reporting;
}

export interface Period {
  from: string;
  to: string;
}

export interface ClassesView {
  window: WindowView;
  period: Period;
  classes: ClassSummaryView[];
}

export interface PatternCell {
  /** The ISO weekday 1..7, the pass's start time HH:MM, or the subject's id. */
  key: string;
  /** The subject's name; the key for the others. */
  label: string;
  figures: Figures;
}

export interface PatternsView {
  /** The pupils with a registered mark behind the pattern: 1 for a pupil. */
  groupSize: number;
  /** A class with fewer than MIN_GROUP pupils with a mark in the period: no pattern is given. */
  suppressed: boolean;
  weekdays: PatternCell[];
  slots: PatternCell[];
  subjects: PatternCell[];
}

export interface ClassStatsView {
  window: WindowView;
  classId: string;
  series: SeriesMonthView[];
  period: Period;
  patterns: PatternsView;
}

export interface ClassPupilView {
  studentId: string;
  firstName: string;
  lastName: string;
  figures: Figures;
}

export interface ClassPupilsView {
  window: WindowView;
  classId: string;
  period: Period;
  pupils: ClassPupilView[];
  /** Pupils with a protected identity left out and counted: a number for an administrator, null for a mentor. */
  heldOut: number | null;
}

export interface PupilMonthView {
  month: string;
  /** Null for a month with no registered mark: nothing was reported, which is not the same as no absence. */
  figures: Figures | null;
  lessons: number;
  previousYear: { month: string; figures: Figures | null } | null;
}

export interface PupilStatsView {
  window: WindowView;
  student: { id: string; firstName: string; lastName: string; classId: string | null; className: string | null; isProtected: boolean };
  /** The first and last day of the pupil's marks still stored; null when none is. */
  marksFrom: string | null;
  marksTo: string | null;
  months: PupilMonthView[];
  total: Figures | null;
  classSeries: SeriesMonthView[] | null;
  period: Period;
  patterns: PatternsView;
}

// ---------------------------------------------------------------------------
// Dates: the school's calendar days, never instants
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

const dayOf = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
const asIso = (date: Date): string => date.toISOString().slice(0, 10);

export const addDays = (iso: string, days: number): string => asIso(new Date(dayOf(iso).getTime() + days * DAY_MS));

/** The first day of the month holding `iso`. */
export const monthStart = (iso: string): string => `${iso.slice(0, 7)}-01`;

/** The first day of the month `delta` months from the one holding `iso`. */
export function shiftMonth(iso: string, delta: number): string {
  const [year, month] = iso.split("-").map(Number) as [number, number];
  return asIso(new Date(Date.UTC(year, month - 1 + delta, 1)));
}

/** The last day of the month holding `iso`. */
export const monthEnd = (iso: string): string => addDays(shiftMonth(iso, 1), -1);

/** Whether the month (its first day) is still going on when the figures run to yesterday. */
export function isGoingOn(month: string, today: string): boolean {
  const yesterday = addDays(today, -1);
  return monthStart(yesterday) === month && yesterday < monthEnd(month);
}

// ---------------------------------------------------------------------------
// The period a read covers
// ---------------------------------------------------------------------------

/**
 * What the reader may choose to look at. YEAR is the gateway's own default
 * (the läsår so far) and is asked for with no dates at all.
 */
export const PERIOD_CHOICES = ["YEAR", "PREVIOUS", "LAST_90", "ALL"] as const;
export type PeriodChoice = (typeof PERIOD_CHOICES)[number];

/** The period a choice reads, or null for the gateway's default. */
export function periodOfChoice(choice: PeriodChoice, window: WindowView): Period | null {
  const yesterday = addDays(window.today, -1);
  switch (choice) {
    case "YEAR":
      return null;
    case "PREVIOUS": {
      if (!window.year) return null;
      return { from: shiftMonth(window.year.from, -12), to: monthEnd(shiftMonth(window.year.to, -12)) };
    }
    case "LAST_90":
      return { from: addDays(yesterday, -89), to: yesterday };
    case "ALL":
      return { from: window.firstMonth, to: yesterday };
  }
}

/** The choices that mean something now: the previous läsår only when the window reaches back to it. */
export function availableChoices(window: WindowView): PeriodChoice[] {
  return PERIOD_CHOICES.filter((choice) => {
    if (choice !== "PREVIOUS") return true;
    return window.year !== null && shiftMonth(window.year.from, -12) >= window.firstMonth;
  });
}

/** `?from=…&to=…`, or nothing for the gateway's default. */
export const periodQuery = (period: Period | null): string => (period ? `?from=${period.from}&to=${period.to}` : "");

// ---------------------------------------------------------------------------
// Months under their läsår, and a chart's scale
// ---------------------------------------------------------------------------

/** A läsår runs August to July: the year its August falls in. */
export function schoolYearStart(month: string): number {
  const year = Number(month.slice(0, 4));
  return Number(month.slice(5, 7)) >= 8 ? year : year - 1;
}

/** "2025/26". */
export const schoolYearName = (start: number): string => `${start}/${String((start + 1) % 100).padStart(2, "0")}`;

export interface YearGroup<T> {
  start: number;
  name: string;
  rows: T[];
}

/** The rows grouped by läsår, oldest first, each keeping the order it came in. */
export function groupByYear<T extends { month: string }>(rows: readonly T[]): Array<YearGroup<T>> {
  const groups = new Map<number, T[]>();
  for (const row of rows) {
    const start = schoolYearStart(row.month);
    groups.set(start, [...(groups.get(start) ?? []), row]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([start, grouped]) => ({ start, name: schoolYearName(start), rows: grouped }));
}

/** One bar of the month chart: shares of the recorded minutes, null where there is no figure. */
export interface ChartPoint {
  month: string;
  validPct: number | null;
  invalidPct: number | null;
  /** The same month a year before: valid and invalid together. */
  previousPct: number | null;
  partial: boolean;
}

const CEILINGS = [5, 10, 20, 25, 50, 100] as const;

/** The top of the chart's axis: the smallest round number the tallest bar fits under. */
export function chartCeiling(points: readonly ChartPoint[]): number {
  let tallest = 0;
  for (const point of points) {
    tallest = Math.max(tallest, (point.validPct ?? 0) + (point.invalidPct ?? 0), point.previousPct ?? 0);
  }
  return CEILINGS.find((ceiling) => ceiling >= tallest) ?? 100;
}

export function pointsOfSeries(series: readonly SeriesMonthView[]): ChartPoint[] {
  return series.map((month) => ({
    month: month.month,
    validPct: month.figures?.validPct ?? null,
    invalidPct: month.figures?.invalidPct ?? null,
    previousPct: month.previousYear?.figures?.totalPct ?? null,
    partial: month.partial,
  }));
}

export function pointsOfPupil(months: readonly PupilMonthView[], today: string): ChartPoint[] {
  return months.map((month) => ({
    month: month.month,
    validPct: month.figures?.validPct ?? null,
    invalidPct: month.figures?.invalidPct ?? null,
    previousPct: month.previousYear?.figures?.totalPct ?? null,
    partial: isGoingOn(month.month, today),
  }));
}
