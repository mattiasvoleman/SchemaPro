// "Dela i halvklass": the two periods a class's halves take turns over, and
// the week each half reads in them. Pure arithmetic for the dialog
// (components/timplan/term-halves-dialog.tsx); the gateway decides what is
// stored (src/resources/term-halves.service.ts periodsOf and halvesShape).
//
// THE PERIODS. The autumn and the spring split at the spring term's first
// day, as the split always was, half the läsår each, or half a term each: the
// first and the second half of the autumn, of the spring, or the first half of
// each term. A term's (or the läsår's) halfway mark is the Monday that splits
// its TEACHING weeks most evenly, lov and studiedagar off (teachingWeeks), so
// höstlovet does not make one half a week shorter than the other. The admin
// can move every date after.
//
// THE WEEK. A dated post counts for its share of the year's teaching weeks
// (the timplan and the load report, standardWeekWeight), so a half that
// reads hemkunskap in a quarter of the year at the class's 1 × 30 gets a
// quarter of the class's hours. To keep each pupil's hours the halves read
// at the pace the class's minutes on the post's line need over the weeks a
// half reads that line in (halvesRead): the shorter of the two periods when
// it reads the line in one of them — one subject in turn, or hemkunskap
// swapped with slöjd, where the slöjd is another line — and both periods when
// both subjects are the line's (textilslöjd and trä- och metallslöjd for a
// slöjd post). The proposal rounds UP, since guaranteed time is a floor; the
// dialog shows the hours either way.

import { teachingWeeks, type ClosedRange, type RequirementLoad, type TeachingPeriod, type YearBounds } from "@/lib/teaching-hours";
import { lessonCountOf, longestLessonOf, weeklyMinutesOf, type LessonShape } from "@/lib/lesson-lengths";
import { standardWeekWeight } from "@/lib/standard-week";

/** One of the two periods, both days included, YYYY-MM-DD. */
export interface HalfPeriod {
  startDate: string;
  endDate: string;
}

/**
 * How the year is split: the two terms; the läsår in two halves of as many
 * teaching weeks; half the autumn each; half the spring each; the first half
 * of each term; or dates the admin typed.
 */
export type PeriodPreset = "terms" | "yearHalves" | "autumnHalves" | "springHalves" | "firstHalves" | "custom";

export const PERIOD_PRESETS: readonly PeriodPreset[] = [
  "terms",
  "yearHalves",
  "autumnHalves",
  "springHalves",
  "firstHalves",
  "custom",
];

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
 * drawn here. "yearHalves" reads no spring start: its mark is the Monday that
 * splits the läsår's own teaching weeks most evenly, so a swap of two
 * subjects there needs only twice the class's pace when the läsår has an even
 * number of them (proposedLessons).
 */
export function presetPeriods(
  preset: Exclude<PeriodPreset, "custom">,
  springStart: string,
  year: YearBounds,
  closures: ClosedRange[],
  gradeLevel: number | null,
): [HalfPeriod, HalfPeriod] | null {
  const halves = (term: HalfPeriod): [HalfPeriod, HalfPeriod] | null => {
    const halfway = termHalfway(term, year, closures, gradeLevel);
    if (halfway === null) return null;
    return [
      { startDate: term.startDate, endDate: addDays(halfway, -1) },
      { startDate: halfway, endDate: term.endDate },
    ];
  };
  if (preset === "yearHalves") return halves(year);
  const spring = dayOf(springStart);
  if (Number.isNaN(spring) || spring <= dayOf(year.startDate) || spring > dayOf(year.endDate)) return null;
  const autumn = { startDate: year.startDate, endDate: addDays(springStart, -1) };
  const springTerm = { startDate: springStart, endDate: year.endDate };
  if (preset === "terms") return [autumn, springTerm];
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
 * How the halves read the post's line — the post's subject, or a subject with
 * its national code, as Skapa timplansposter reads the class's line:
 *
 * - `inTurn`: one subject, each half in its own period.
 * - `swapWithOther`: two subjects swapped, only one of them the line's
 *   (hemkunskap and slöjd for a hemkunskap post). Each half reads the line in
 *   one period, as in turn, and the other subject is minutes on its own line
 *   (lib/half-class-timplan.ts shows them).
 * - `swapWithinLine`: two subjects swapped that are both the line's, or
 *   neither (textilslöjd and trä- och metallslöjd for a slöjd post). Each half
 *   reads the line in both periods, so the class's pace keeps its minutes.
 */
export type HalvesRead = "inTurn" | "swapWithOther" | "swapWithinLine";

/** A subject as the line question reads it. */
type CodedSubject = { id: string; nationalCode?: string | null };

/**
 * Whether a subject is the post's line: the post's subject, or one with its
 * national code. One without a code is not: the dialog cannot tell a code
 * the Ämnen form left empty from a subject of the school's own, and reading
 * it as another line keeps each pupil's hours either way — the pace is a
 * floor (the dialog says how to get the class's pace back: the same code).
 */
export function readsPostLine(subjectId: string, postSubjectId: string, subjects: readonly CodedSubject[]): boolean {
  if (subjectId === postSubjectId) return true;
  const codeOf = (id: string) => subjects.find((subject) => subject.id === id)?.nationalCode ?? null;
  const postCode = codeOf(postSubjectId);
  return postCode !== null && codeOf(subjectId) === postCode;
}

/** How the halves read the post's line with the subjects chosen (an empty second: one subject). */
export function halvesRead(
  pair: readonly [string, string],
  postSubjectId: string,
  subjects: readonly CodedSubject[],
): HalvesRead {
  if (!pair[1]) return "inTurn";
  const [first, second] = pair.map((id) => readsPostLine(id, postSubjectId, subjects));
  return first === second ? "swapWithinLine" : "swapWithOther";
}

/** The most lessons a timplanspost holds in a week, and the longest lesson (lengthsProblem). */
const MAX_LESSONS = 40;
const MAX_MINUTES = 240;

/**
 * The halves' week that gives each pupil at least the class's post's minutes
 * on its line, or null when the class's own week already does (two subjects
 * of the line swapped over the whole year). Null too when a period has no
 * teaching week to read anything in.
 *
 * The minutes are the timplan's standardvecka minutes, as the timplan and the
 * load report weigh a post (standardWeekWeight): the class's post gives each
 * pupil its lessons × its weight (1, or 0.5 varannan vecka), and a half's
 * post its lessons × its period's share of the year's teaching weeks. So the
 * need is the class's minutes over the share a half reads the line in: the
 * shorter period's (inTurn, swapWithOther) or both periods' (swapWithinLine).
 * A varannan-vecka post's need is its half-weight over the period's odd
 * weeks, the timplan's own measure, and not the year's odd weeks over them.
 *
 * Rounded UP: guaranteed time is a floor. A half over its target shows as
 * over in the timplan; one under it is a pupil short of the law's hours. The
 * epsilon keeps an exact need from a float's last bit rounding it up a whole
 * lesson. In turn the count is rounded in the class's lesson length (5 × 30
 * for a 1 × 30 read in half the autumn). A swap pays the surplus twice — the
 * line's and the other subject's, which the class's own post in it has to
 * give back — so it takes the closer of that and the class's lesson count
 * with a longer lesson, on the 5-minute grid: 1 × 30 read in 17 of 37 weeks
 * needs 65,3 a week, 1 × 70 rather than 3 × 30. A tie keeps the class's length.
 */
export function proposedLessons(
  post: LessonShape & TeachingPeriod,
  periods: readonly [HalfPeriod, HalfPeriod],
  read: HalvesRead,
  year: YearBounds,
  closures: ClosedRange[],
  gradeLevel: number | null,
): UniformLessons | null {
  const weekly = weeklyMinutesOf(post);
  const recurrence = post.recurrence ?? "ALL_WEEKS";
  const gradeSpan = gradeLevel === null ? null : { min: gradeLevel, max: gradeLevel };
  // The class's minutes per pupil, as the timplan counts the post.
  const classMinutes = weekly * standardWeekWeight({ ...post, recurrence, gradeSpan }, year, closures);
  const weeksOf = (period: HalfPeriod) => teachingWeeks({ ...period, recurrence }, year, closures, gradeLevel);
  const [first, second] = periods.map(weeksOf) as [number, number];
  const yearWeeks = teachingWeeks({}, year, closures, gradeLevel);
  const readWeeks = read === "swapWithinLine" ? first + second : Math.min(first, second);
  if (weekly <= 0 || yearWeeks <= 0 || readWeeks <= 0) return null;
  const needed = (classMinutes * yearWeeks) / readWeeks;
  // The class's own week already gives every pupil the class's minutes (two
  // subjects of the line over the terms read it over the whole year).
  if (needed <= weekly + 1e-9) return null;
  const minutes = longestLessonOf(post);
  const inLength = { count: Math.min(MAX_LESSONS, Math.max(1, Math.ceil(needed / minutes - 1e-9))), minutes };
  if (read === "inTurn") return inLength;
  const count = Math.min(MAX_LESSONS, lessonCountOf(post));
  const longer = Math.ceil(needed / count / 5 - 1e-9) * 5;
  return longer <= MAX_MINUTES && count * longer < inLength.count * inLength.minutes
    ? { count, minutes: longer }
    : inLength;
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
