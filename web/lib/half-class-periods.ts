// "Dela i halvklass": the two periods a class's halves take turns over, and
// the week each half reads in them. Pure arithmetic for the dialog
// (components/timplan/term-halves-dialog.tsx); the gateway decides what is
// stored (src/resources/term-halves.service.ts periodsOf and halvesShape).
//
// THE PERIODS. The autumn and the spring split at the spring term's first
// day, as the split always was, or half a term each: the first and the second
// half of the autumn, of the spring, or the first half of each term. A term's
// halfway mark is the Monday that splits its TEACHING weeks most evenly, lov
// and studiedagar off (teachingWeeks), so höstlovet does not make one half a
// week shorter than the other. The admin can move every date after.
//
// THE WEEK. A dated post counts for its share of the year's teaching weeks
// (the timplan and the load report, standardWeekWeight), so a half that
// reads hemkunskap in a quarter of the year at the class's 1 × 30 gets a
// quarter of the class's hours. To keep each pupil's hours the halves read
// at the pace the class's minutes over their weeks need: with one subject
// over the shorter of the two periods (each half reads it in one), with two
// subjects over both (each half reads one in each, the class's line split
// between them). The proposal keeps the class's lesson length and rounds the
// count; the dialog shows the hours either way.

import { teachingWeeks, type ClosedRange, type RequirementLoad, type TeachingPeriod, type YearBounds } from "@/lib/teaching-hours";
import { longestLessonOf, weeklyMinutesOf, type LessonShape } from "@/lib/lesson-lengths";

/** One of the two periods, both days included, YYYY-MM-DD. */
export interface HalfPeriod {
  startDate: string;
  endDate: string;
}

/**
 * How the year is split: the two terms; half the autumn each; half the spring
 * each; the first half of each term; or dates the admin typed.
 */
export type PeriodPreset = "terms" | "autumnHalves" | "springHalves" | "firstHalves" | "custom";

export const PERIOD_PRESETS: readonly PeriodPreset[] = ["terms", "autumnHalves", "springHalves", "firstHalves", "custom"];

const DAY_MS = 24 * 60 * 60 * 1000;
const dayOf = (value: string) => Date.parse(`${value}T00:00:00Z`);
const isoOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (value: string, days: number) => isoOf(dayOf(value) + days * DAY_MS);

/**
 * The Monday that splits a term's teaching weeks most evenly: the first of
 * the second half. The earliest of equally even Mondays, so a term of an odd
 * number of weeks gives its extra week to the second half. Null for a term
 * with no Monday after its first day.
 */
export function termHalfway(
  term: HalfPeriod,
  year: YearBounds,
  closures: ClosedRange[],
  gradeLevel: number | null,
): string | null {
  const start = dayOf(term.startDate);
  const end = dayOf(term.endDate);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return null;
  // The first Monday after the term's first day.
  const weekday = new Date(start).getUTCDay();
  let monday = start + (((8 - weekday) % 7) || 7) * DAY_MS;
  let best: { monday: number; gap: number } | null = null;
  for (; monday <= end; monday += 7 * DAY_MS) {
    const before = teachingWeeks({ startDate: term.startDate, endDate: isoOf(monday - DAY_MS) }, year, closures, gradeLevel);
    const after = teachingWeeks({ startDate: isoOf(monday), endDate: term.endDate }, year, closures, gradeLevel);
    const gap = Math.abs(before - after);
    if (best === null || gap < best.gap - 1e-9) best = { monday, gap };
  }
  return best === null ? null : isoOf(best.monday);
}

/**
 * The two periods a preset names, from the year and the spring term's first
 * day. Null when they cannot be drawn (no spring start inside the year, or a
 * term too short to halve); "custom" keeps what the admin typed and is never
 * drawn here.
 */
export function presetPeriods(
  preset: Exclude<PeriodPreset, "custom">,
  springStart: string,
  year: YearBounds,
  closures: ClosedRange[],
  gradeLevel: number | null,
): [HalfPeriod, HalfPeriod] | null {
  const spring = dayOf(springStart);
  if (Number.isNaN(spring) || spring <= dayOf(year.startDate) || spring > dayOf(year.endDate)) return null;
  const autumn = { startDate: year.startDate, endDate: addDays(springStart, -1) };
  const springTerm = { startDate: springStart, endDate: year.endDate };
  if (preset === "terms") return [autumn, springTerm];
  const halves = (term: HalfPeriod): [HalfPeriod, HalfPeriod] | null => {
    const halfway = termHalfway(term, year, closures, gradeLevel);
    if (halfway === null) return null;
    return [
      { startDate: term.startDate, endDate: addDays(halfway, -1) },
      { startDate: halfway, endDate: term.endDate },
    ];
  };
  if (preset === "autumnHalves") return halves(autumn);
  if (preset === "springHalves") return halves(springTerm);
  const [autumnFirst, springFirst] = [halves(autumn), halves(springTerm)];
  return autumnFirst && springFirst ? [autumnFirst[0], springFirst[0]] : null;
}

/** Why two periods cannot be sent, or null: the gateway's TERM_PERIODS_INVALID, said first here. */
export type PeriodsProblem = "MISSING" | "BACKWARDS" | "OUTSIDE_YEAR" | "OVERLAP";

export function periodsProblem(periods: readonly HalfPeriod[], year: YearBounds | null): PeriodsProblem | null {
  const days = periods.map((period) => [dayOf(period.startDate), dayOf(period.endDate)] as const);
  if (days.length !== 2 || days.some(([start, end]) => Number.isNaN(start) || Number.isNaN(end))) return "MISSING";
  if (days.some(([start, end]) => end < start)) return "BACKWARDS";
  if (year && days.some(([start, end]) => start < dayOf(year.startDate) || end > dayOf(year.endDate))) {
    return "OUTSIDE_YEAR";
  }
  return days[1]![0] <= days[0]![1] ? "OVERLAP" : null;
}

/** The halves' week as the dialog edits it: a count of lessons of one length. */
export interface UniformLessons {
  count: number;
  minutes: number;
}

/**
 * The halves' week that keeps each pupil's minutes of the class's post, or
 * null when that is the class's own week (within 5 %: the terms with two
 * subjects, which split the line between the two). `subjects` is how many the
 * halves read: one in turn, or two swapped. Null too when a period has no
 * teaching week to read anything in.
 */
export function proposedLessons(
  post: LessonShape & TeachingPeriod,
  periods: readonly [HalfPeriod, HalfPeriod],
  subjects: 1 | 2,
  year: YearBounds,
  closures: ClosedRange[],
  gradeLevel: number | null,
): UniformLessons | null {
  const weekly = weeklyMinutesOf(post);
  const recurrence = post.recurrence ?? "ALL_WEEKS";
  const weeksOf = (period: HalfPeriod) => teachingWeeks({ ...period, recurrence }, year, closures, gradeLevel);
  const [first, second] = periods.map(weeksOf) as [number, number];
  const classWeeks = teachingWeeks({ recurrence }, year, closures, gradeLevel);
  const readWeeks = subjects === 1 ? Math.min(first, second) : first + second;
  if (weekly <= 0 || classWeeks <= 0 || readWeeks <= 0) return null;
  const needed = (weekly * classWeeks) / readWeeks;
  if (Math.abs(needed - weekly) <= weekly * 0.05) return null;
  const minutes = longestLessonOf(post);
  return { count: Math.min(40, Math.max(1, Math.round(needed / minutes))), minutes };
}

/** A uniform week as the timplanspost's lengths: 4 × 30 is [30, 30, 30, 30]. */
export function lengthsOf(lessons: UniformLessons): number[] {
  return Array.from({ length: lessons.count }, () => lessons.minutes);
}

/** The halves' week as a row: their own, or the class's post's when null. */
export function halvesRow(post: LessonShape, lessons: UniformLessons | null): LessonShape {
  return lessons === null
    ? post
    : { lessonsPerWeek: lessons.count, minutesPerLesson: lessons.minutes, lessonLengths: [] };
}

/** A post the split writes, as the hours arithmetic reads it. */
export type PlannedRow = RequirementLoad & { half: 0 | 1; subject: 0 | 1 };

/**
 * The posts the split writes: half h reads subject (h + period) mod 2 in
 * each period, and with one subject nothing where that is the second.
 */
export function plannedRows(
  week: LessonShape,
  recurrence: TeachingPeriod["recurrence"],
  periods: readonly [HalfPeriod, HalfPeriod],
  subjects: 1 | 2,
): PlannedRow[] {
  return ([0, 1] as const).flatMap((half) =>
    ([0, 1] as const).flatMap((period) => {
      const subject = ((half + period) % 2) as 0 | 1;
      if (subject >= subjects) return [];
      return [
        {
          half,
          subject,
          lessonsPerWeek: week.lessonsPerWeek,
          minutesPerLesson: week.minutesPerLesson,
          lessonLengths: week.lessonLengths ?? [],
          recurrence,
          startDate: periods[period]!.startDate,
          endDate: periods[period]!.endDate,
        },
      ];
    }),
  );
}
