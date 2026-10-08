// How many weeks a teaching requirement actually runs, and what that is in hours.
//
// A requirement carries a recurrence and an optional period of its own
// (schema.prisma: TeachingRequirement.recurrence / startDate / endDate). Two
// numbers fall out of that pair and the academic year around it: how much
// teaching the requirement is worth over the year, and how many lessons a week
// the busiest week has to hold. The first is what a rektor checks against the
// timplan; the second is what tells you a term-limited course and a
// year-long one collide in September even though neither alone is heavy.
//
// The whole module is arithmetic over ISO week numbers. No React, no fetches —
// the same reason lib/gaps.ts stays a plain module: the page that shows these
// numbers is not the only thing that will want them.
//
// WHAT THE WEEK COUNTS SEE, AND WHAT THEY STILL DO NOT
//
// 1. Lov and studiedagar ARE modelled now. This header used to say the
//    opposite, and said it flatly: no closure table, nothing anywhere in the
//    app that knew a week was a lov, so every figure counted calendar weeks and
//    read roughly 8-10 weeks high across a Swedish läsår. SchoolBreak in
//    schema.prisma closed that hole — an inclusive date range with a kind
//    (HOLIDAY | STAFF_DAY) and an optional grade span. teachingWeeks and
//    annualMinutes accept those ranges as `closures` and weight every week by
//    the share of its Mon-Fri days that survives them.
//
//    `closures` is optional and omitting it reproduces the old calendar-week
//    figure exactly. That is what lets existing callers keep compiling, and it
//    is also the trap: a caller that forgets to pass the year's breaks gets the
//    overestimate back with no complaint. This module has no database and
//    cannot fetch them itself — loading them is the caller's job.
//
//    IT IS AN ESTIMATE AT REQUIREMENT LEVEL, structurally, not for want of
//    care. A requirement has no weekday: "3 lektioner i veckan" says how much,
//    never on which days — the weekday belongs to the placed Lesson — so
//    nothing here can know whether the studiedag fell on one of this
//    requirement's lesson days or on a day it never used. A week holding one
//    studiedag is charged four fifths of its lessons, which is right averaged
//    over a term and wrong for the single week anybody points at. Do not quote
//    these hours as delivered teaching time; they answer "does the timplan look
//    covered", nothing finer.
//
// 2. weeksInPeriod stays WHOLE CALENDAR weeks, deliberately, and is not the
//    function that subtracts lov. It feeds peakLessonsPerWeek, where the
//    question is whether a week's lessons fit in the grid at all — a lov week
//    holds no lessons and must not be allowed to drag the busiest week down.
//    Fractions belong to the annual total; the peak is a yes/no about capacity.
//
// 3. Partly covered edge weeks. A period starting on a Wednesday still counts
//    that whole WEEK, in teachingWeeks too — trimming the week was rejected
//    because it would make the no-closure path stop agreeing with
//    weeksInPeriod, and every existing caller and test reads that path.
//
//    The CLOSURES in such a week are trimmed to the period even so, and the two
//    halves are not the same decision. Counting a lov on the Monday of a week
//    the period only joins on Wednesday made that week weigh 3/5 instead of 1,
//    which is an error pointing DOWN — the direction this file says it never
//    goes — and it also let a lov sitting entirely outside a term's period
//    subtract from it. So the week is generous and the lov is exact, and what
//    is left over still errs upward.
//
// What is left over errs upward, which is the honest direction for a planning
// figure: nobody is harmed by budgeting for a week that turns out to be a lov,
// and the opposite error hides an under-taught subject.

import { isMixed, weeklyMinutesOf } from "@/lib/lesson-lengths";
import type { LessonRecurrence } from "@/lib/types";
import { addDays, isoWeek, startOfIsoWeek, toDateString } from "@/lib/utils";

/**
 * Named as the API this module promises, aliased to the app's own union so
 * there is exactly one place the three values are written down. Widening
 * LessonRecurrence later must widen this too, and the compiler will say so.
 */
export type Recurrence = LessonRecurrence;

export interface TeachingPeriod {
  /**
   * Absent or null is read as ALL_WEEKS, matching RecurrenceWindow in
   * src/calendar/lesson-recurrence.ts. The column is NOT NULL with a default,
   * so a missing value means a query forgot to select it — and then "every
   * week" is the reading that looks like a bug rather than like data loss.
   */
  recurrence?: Recurrence | null;
  /** Inclusive ISO yyyy-mm-dd; null means "from the start of the year". */
  startDate?: string | null;
  /** Inclusive ISO yyyy-mm-dd; null means "until the year ends". */
  endDate?: string | null;
}

/** The academic year the period is measured inside. Both bounds inclusive. */
export interface YearBounds {
  startDate: string;
  endDate: string;
}

/**
 * A stretch of days nobody is taught — one SchoolBreak row, narrowed.
 *
 * Structural rather than an import of the Prisma type on purpose: this module
 * is deliberately free of the client (the whole file is arithmetic, see the
 * header), and a caller assembling ranges from an import file or a preview form
 * has no rows to hand yet. The field names match the columns so a query result
 * passes straight in.
 *
 * HOLIDAY and STAFF_DAY are not distinguished here. Both mean the same thing to
 * an hours count — no lessons that day — and the kind exists for the UI to
 * label with, not for this to branch on.
 */
export interface ClosedRange {
  /** Inclusive ISO yyyy-mm-dd, matching SchoolBreak.startDate (@db.Date). */
  startDate: string;
  /** Inclusive too: a one-day studiedag has startDate === endDate. */
  endDate: string;
  /**
   * Both null (or absent) means the whole school is closed. A span closes the
   * range only for the grades inside it — a studiedag for lågstadiet leaves
   * year 9 teaching.
   */
  minGradeLevel?: number | null;
  maxGradeLevel?: number | null;
}

export interface RequirementLoad extends TeachingPeriod {
  lessonsPerWeek: number;
  minutesPerLesson: number;
  /**
   * Lektionslängder, longest first; empty or absent on a uniform row. On a
   * split row lessonsPerWeek is still the count (what the peaks below sum)
   * and minutesPerLesson the longest, so only the minutes read the list.
   */
  lessonLengths?: readonly number[];
}

/**
 * Seven, not five — a week here is the whole ISO week, Monday to Sunday.
 *
 * This was Monday..Friday, on the reasoning that "a weekend-only period teaches
 * nothing". That reasoning is not true of this app: Lesson.dayOfWeek accepts
 * 1-7 (schema.prisma), the week grid renders whatever days a school configures,
 * and the canonical runsOn in src/calendar/lesson-recurrence.ts asks only about
 * the DATE — it has no weekday branch at all. So a Saturday lesson is a lesson
 * the publisher will materialise, and a count that skipped its week charged
 * nothing for teaching that really happens.
 *
 * It also silently lost whole weeks at a period's edges: a course starting
 * Sunday 2027-01-10 runs in week 1 by runsOn, but with a Mon-Fri window week 1
 * ended on the 8th and the week vanished — 22 weeks reported where the day-by-
 * day truth is 23.
 *
 * Trimming to a school's actual teaching days was the other candidate and was
 * rejected: nothing in this module knows which days a given school uses (there
 * is no such column), so any such trim would be this file guessing on the
 * school's behalf — the same class of invented rule as the holiday fudge the
 * file header refuses. Seven agrees with runsOn for every school; five agreed
 * with none of them exactly.
 */
const DAYS_IN_WEEK = 7;

/**
 * Five, and the disagreement with DAYS_IN_WEEK above is not an oversight.
 *
 * The two constants answer different questions. Seven decides whether a week
 * EXISTS for a period at all, and it has to be seven because a lesson may sit on
 * any of Lesson.dayOfWeek 1-7 and runsOn never looks at the weekday — skipping a
 * week because its only covered days were a weekend charges nothing for teaching
 * that really happens.
 *
 * This one is a denominator: given that the week exists, how much of a
 * TEACHING week is left after the closures. A studiedag takes a fifth of that
 * week's teaching, not a seventh — the Saturday it did not fall on was never
 * carrying a normal share of the lessons to begin with. Dividing by seven here
 * would quietly under-deduct every lov by 2/7, which is most of the error the
 * closure model was added to remove.
 *
 * A school that really does teach on Saturdays is charged slightly too little
 * for a lov by this. There is no column saying which days a school uses (see
 * DAYS_IN_WEEK), so the alternative is this file inventing the school's week,
 * and Mon-Fri is the one every Swedish grundskola's timplan is written against.
 */
const TEACHING_DAYS_IN_WEEK = 5;

/**
 * The period's own bounds, narrowed to the year and normalised.
 *
 * `null` means nothing is left — the period lies wholly outside the year, or
 * the year itself is inverted.
 */
interface TaughtWindow {
  from: string;
  to: string;
  recurrence: Recurrence;
}

function clampToYear(period: TeachingPeriod, year: YearBounds): TaughtWindow | null {
  // Dates are yyyy-mm-dd, so a string comparison is a date comparison — the
  // same shortcut buildIcs in lib/ics.ts takes when it narrows a lesson's
  // window. A period narrows the year, never widens it.
  const from =
    period.startDate && period.startDate > year.startDate
      ? period.startDate
      : year.startDate;
  const to =
    period.endDate && period.endDate < year.endDate ? period.endDate : year.endDate;

  if (from > to) return null;
  return { from, to, recurrence: period.recurrence ?? "ALL_WEEKS" };
}

/** Local midnight from yyyy-mm-dd — the convention lib/ics.ts parses with. */
function parseDay(value: string): Date {
  return new Date(`${value}T00:00:00`);
}

/**
 * Whether a week's ISO number matches the parity.
 *
 * The same branch as runsOn in src/calendar/lesson-recurrence.ts: "varannan
 * vecka" is the parity of the ISO WEEK NUMBER, never a count of weeks from the
 * start of term. The distinction is invisible most of the year and then decides
 * everything at the new year, because an ISO year with 53 weeks puts week 53
 * next to week 1 — two odd weeks running. 2026/27 is such a year. Counting from
 * term start would silently swap every odd and even lesson after that seam.
 */
function runsInWeek(recurrence: Recurrence, monday: Date): boolean {
  if (recurrence === "ALL_WEEKS") return true;
  const odd = isoWeek(monday) % 2 === 1;
  return recurrence === "ODD_WEEKS" ? odd : !odd;
}

/**
 * The Monday of every ISO week that [from, to] touches at all.
 *
 * Walking Mondays rather than days is what makes a week its own identity: two
 * different ISO years can both hold a "week 34", so a count keyed on the week
 * NUMBER would fuse them. Keyed on the Monday, each week is visited once and
 * the year boundary needs no special case.
 */
function mondaysBetween(from: string, to: string): Date[] {
  const first = startOfIsoWeek(parseDay(from));
  // An unparseable bound yields an Invalid Date, whose toDateString is
  // "NaN-NaN-NaN"; that sorts above any real date so the loop would end at
  // once anyway, but returning early says why instead of looking like a
  // coincidence.
  if (Number.isNaN(first.getTime())) return [];

  const mondays: Date[] = [];
  for (let monday = first; toDateString(monday) <= to; monday = addDays(monday, 7)) {
    mondays.push(monday);
  }
  return mondays;
}

/** Whether the window puts teaching into the ISO week starting on `monday`. */
function teachesInWeek(window: TaughtWindow, monday: Date): boolean {
  const weekStart = toDateString(monday);
  const weekEnd = toDateString(addDays(monday, DAYS_IN_WEEK - 1)); // Sunday
  // Plain interval intersection over the whole week. weeksInPeriod's own walk
  // starts at the Monday of `from`, so this can only reject there for a
  // recurrence mismatch; the date test earns its keep in peakLessonsPerWeek,
  // which walks every Monday of the YEAR past windows narrower than it.
  if (weekEnd < window.from || weekStart > window.to) return false;
  return runsInWeek(window.recurrence, monday);
}

/**
 * How many weeks of the year the period is taught in.
 *
 * A week counts when the period covers ANY of its seven days and the
 * recurrence parity matches — the same weeks runsOn in
 * src/calendar/lesson-recurrence.ts says yes to, since it reads dates and never
 * weekdays (see DAYS_IN_WEEK). A partly covered edge week therefore counts as a
 * whole one: a course running 2026-09-02 (a Wednesday) to the end of term is
 * charged for all of week 36, including the Monday and Tuesday before it
 * started. That overestimates, marginally and always upward. Counting the week
 * as 3/5 was tried on paper and thrown out — it turns this figure into a
 * decimal nobody can reconcile against a printed timetable, and this is the
 * figure peakLessonsPerWeek counts with.
 *
 * The count is CALENDAR weeks, and stays that way now that closures exist: lov
 * and studiedagar are counted as taught here. That is not an oversight to be
 * fixed in passing — subtracting them would blunt the peak, whose whole job is
 * to ask whether a week's lessons fit. teachingWeeks is where the lov come off.
 *
 * A period outside the year, or the wrong way round, gives 0.
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
 * Whether a closure reaches a given grade.
 *
 * A missing or null `gradeLevel` is NOT inside any span. The caller who cannot
 * say which grade it is asking about is asking a school-wide question, and a
 * lågstadiet studiedag is not a school-wide fact; counting it would understate
 * teaching for every grade it never touched. School-wide closures still apply,
 * because those are true whatever the grade is.
 *
 * A half-filled span (one bound null) cannot come out of the database — the
 * check constraint on SchoolBreaks makes the pair all-or-nothing — but the
 * interface allows one, so it is read as open-ended on the missing side rather
 * than thrown away. Silently dropping a range that says "årskurs 7 och uppåt"
 * would be the worse failure of the two.
 */
function closesForGrade(closure: ClosedRange, gradeLevel?: number | null): boolean {
  const min = closure.minGradeLevel ?? null;
  const max = closure.maxGradeLevel ?? null;
  if (min === null && max === null) return true;

  // Explicit null/undefined test, not a falsy one: årskurs 0 is förskoleklass,
  // a real grade this app stores, and `!gradeLevel` would exclude it from every
  // span that covers it.
  if (gradeLevel === null || gradeLevel === undefined) return false;
  if (min !== null && gradeLevel < min) return false;
  if (max !== null && gradeLevel > max) return false;
  return true;
}

/**
 * How many of the week's Mon-Fri days at least one closure covers.
 *
 * `some` per day rather than summing each range's length is what makes
 * overlapping lov safe: a day two ranges both claim — a studiedag entered
 * separately and then swallowed by an extended höstlov — is closed once, and a
 * week can never lose more than five days. Summing lengths let a school with
 * duplicated imports drive teachingWeeks negative.
 *
 * Days outside the academic year need no special case. The walk only ever asks
 * about weeks the period itself touches, so the part of a lov that sticks out
 * past the year is asked about only for the days it shares with a week in play.
 */
/**
 * Mon-Fri days of this week that are both INSIDE the window and closed.
 *
 * The window test is not decoration. Without it a lov on the Monday of a week
 * whose period only starts on the Wednesday subtracted two days the period does
 * not contain, so the week weighed 3/5 instead of 1 — an error pointing DOWN,
 * in a function whose whole contract is that it errs upward. The same shape
 * subtracted a lov sitting entirely before a spring-term requirement.
 *
 * A partly covered edge week still counts as a WHOLE week, which is the
 * deliberate upward error documented at the top of this file. Only the closures
 * are trimmed to the window, never the week itself — trimming the week too
 * would make the no-closure path stop agreeing with weeksInPeriod, and every
 * caller that has not learned about lov reads that path.
 */
function closedTeachingDays(
  monday: Date,
  closures: ClosedRange[],
  window: TaughtWindow,
): number {
  let closed = 0;
  for (let offset = 0; offset < TEACHING_DAYS_IN_WEEK; offset += 1) {
    const day = toDateString(addDays(monday, offset));
    if (day < window.from || day > window.to) continue;
    // A range the wrong way round (endDate < startDate) covers nothing here,
    // which is the same reading clampToYear gives an inverted period.
    if (closures.some((closure) => day >= closure.startDate && day <= closure.endDate)) {
      closed += 1;
    }
  }
  return closed;
}

/**
 * The weeks of the period, WEIGHTED by how much of each is actually taught.
 *
 * Same weeks weeksInPeriod finds, but a week no longer counts as a flat 1: it
 * counts as the share of its five Mon-Fri days that no closure covers. An
 * ordinary week is 1, a week with one studiedag is 0.8, a full lov week is 0.
 * Omit `closures` and every week weighs 1, so the result is weeksInPeriod's own
 * integer — that identity is deliberate and pinned by a test, because every
 * caller that has not learned about lov yet goes down this path.
 *
 * `gradeLevel` is the grade being asked about. A closure with no grade span
 * applies to it whatever it is; a closure with one applies only if the grade
 * falls inside. Null or omitted means "no particular grade", which no span
 * reaches (see closesForGrade).
 *
 * THIS IS AN ESTIMATE AND THE IMPRECISION CANNOT BE ENGINEERED AWAY. A
 * requirement carries lessonsPerWeek, not weekdays — the weekday only comes into
 * existence when a Lesson is placed — so this cannot know whether the studiedag
 * fell on a day this requirement was taught or on one it never used. Weighting
 * by the fraction of the week is right in aggregate over a term and wrong for
 * any single week. Two things were rejected here: reading the placed lessons
 * (they do not exist yet when a rektor checks a timplan, which is the whole
 * point of the check), and rounding weeks to whole numbers (it would move the
 * error from a fifth of a week to a whole one, in an unpredictable direction).
 *
 * Fractions are summed as whole days and divided once at the end. Adding 0.8 to
 * a running total forty times leaves the answer a few ulps off a number a test
 * or a UI would write literally; 172/5 does not.
 */
export function teachingWeeks(
  period: TeachingPeriod,
  year: YearBounds,
  closures?: ClosedRange[],
  gradeLevel?: number | null,
): number {
  const window = clampToYear(period, year);
  if (!window) return 0;

  // Filtered once, before the walk: the grade question has the same answer in
  // every week, and asking it per day would be O(weeks x 5 x closures).
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

  // Short-circuited so the common no-closure call returns the exact integer
  // weeksInPeriod would, rather than something that merely rounds to it.
  if (applicable.length === 0) return weeks;
  return taughtDays / TEACHING_DAYS_IN_WEEK;
}

/**
 * Non-finite and negative loads read as zero.
 *
 * A requirement arriving mid-edit with an empty number field parses to NaN, and
 * NaN survives every multiplication below to surface as "NaN h" in a table
 * cell. Zero is the reading a half-filled form deserves.
 */
function load(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Total teaching minutes the requirement is worth across the academic year.
 *
 * weeks x lessons per week x minutes per lesson, where the weeks are
 * teachingWeeks' weighted ones — hand it the year's lov and studiedagar and the
 * figure stops counting them. Without `closures` it is the calendar-week
 * overestimate it always was, unchanged to the minute.
 *
 * A split row (1 × 80 + 1 × 40) is worth its lessons' minutes a week,
 * lib/lesson-lengths.ts weeklyMinutesOf, never count × longest. A uniform row
 * keeps the multiplication in the order it always had, so its figure does
 * not move by an ulp.
 *
 * It counts weeks and not placed lessons by design, so it answers the timplan
 * question ("is this subject planned for enough hours") before a single lesson
 * has been scheduled. It is therefore planned time, never delivered time, and
 * an estimate even as planned time — see teachingWeeks for exactly which part
 * of it is a guess.
 */
export function annualMinutes(
  req: RequirementLoad,
  year: YearBounds,
  closures?: ClosedRange[],
  gradeLevel?: number | null,
): number {
  const weeks = teachingWeeks(req, year, closures, gradeLevel);
  if (isMixed(req)) return weeks * weeklyMinutesOf(req);
  return weeks * load(req.lessonsPerWeek) * load(req.minutesPerLesson);
}

/**
 * Lessons the WHOLE SCHOOL teaches in its single busiest week of the year.
 *
 * Read that scope literally. Every requirement handed in is summed, whoever it
 * belongs to: RequirementLoad carries no studentGroupId, no teacher and no
 * room, so this function could not group by anything even if it wanted to. It
 * is a school-wide aggregate and nothing narrower.
 *
 * This docstring used to end "the number exists precisely to be checked against
 * how many slots a week has", which is exactly what the number CANNOT do: a
 * week has some number of slots per group, and forty lessons spread over ten
 * classes fits a week that four lessons in one class does not. The figure that
 * answers the slot question per group is peakLessonsPerWeekByKey below; this
 * one answers "how much teaching does this school's heaviest week carry", which
 * is a staffing and premises figure, not a timetable-feasibility one.
 *
 * What it is still right about: it is not the sum of lessonsPerWeek.
 * Alternating requirements never share a week and term-limited ones may not
 * overlap at all, so a flat sum reports a load no week actually carries. Every
 * week of the year is asked, because the busiest is rarely the first or the
 * last — an ODD_WEEKS course ending in December and an EVEN_WEEKS one starting
 * in November peak in the one week neither's own dates make obvious.
 *
 * No requirements, or a year with no weeks in it, gives 0.
 */
export function peakLessonsPerWeek(reqs: RequirementLoad[], year: YearBounds): number {
  // Clamped once rather than per week: peak is O(weeks x reqs) already, and a
  // requirement's window does not change as the walk moves through the year.
  const windows = reqs.map((req) => ({
    window: clampToYear(req, year),
    lessons: load(req.lessonsPerWeek),
  }));

  let peak = 0;
  for (const monday of mondaysBetween(year.startDate, year.endDate)) {
    let week = 0;
    for (const { window, lessons } of windows) {
      if (window && teachesInWeek(window, monday)) week += lessons;
    }
    if (week > peak) peak = week;
  }
  return peak;
}

/**
 * The same peak, but one per group — or per teacher, or per room.
 *
 * Added rather than folded into peakLessonsPerWeek because that signature is
 * already called from admin/requirements/page.tsx and the school-wide figure it
 * shows is a real figure; this is the missing companion, not a correction of
 * it. A per-group peak is what you check against how many slots a class's week
 * holds, which is the question the school-wide number was wrongly documented as
 * answering.
 *
 * The caller supplies `keyOf` instead of this module naming a field, because
 * RequirementLoad has no grouping column and adding studentGroupId to it would
 * bake one grouping in — the page wants group, a teacher-load view wants
 * teacher, and a room audit wants room. Generic over T so the callback sees the
 * caller's own richer record, not the narrowed interface.
 *
 * Each key gets ITS OWN busiest week. Summing this map does not give
 * peakLessonsPerWeek and must not be expected to: two groups can peak in
 * different weeks, so the parts add up to more than the whole. Ask the
 * school-wide function for the school-wide number.
 *
 * Every key present in `reqs` appears in the result, 0 included, so a caller
 * rendering a row per group gets a number for a group whose requirements all
 * fall outside the year rather than a hole.
 */
/**
 * The busiest week per key, summing an arbitrary load — minutes, here — over
 * the items taught in each ISO week of the year.
 *
 * The generic sibling of peakLessonsPerWeekByKey, and a mirror of
 * src/staffing/teaching-weeks.ts `peakPerWeekByKey` rather than a refactoring
 * of its neighbour: the staffing report sums MINUTES per teacher, where the
 * timplan page sums LESSONS per group, and the two differ in what they count
 * and in nothing else. Kept as its own function so the lessons version keeps
 * its NaN-to-zero reading of a half-typed form (`load()` above) while this one
 * stays byte-for-byte the gateway's arithmetic, which the teacher-load contract
 * test replays against it.
 *
 * Every key present appears, 0 included. Parities never add; non-overlapping
 * terms never add; the same parity and overlapping terms do. Lov are NOT
 * subtracted: the peak asks whether a week fits, and a lov week holds nothing
 * to fit.
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

export function peakLessonsPerWeekByKey<T extends RequirementLoad>(
  reqs: T[],
  year: YearBounds,
  keyOf: (req: T) => string,
): Map<string, number> {
  const windows = reqs.map((req) => ({
    key: keyOf(req),
    window: clampToYear(req, year),
    lessons: load(req.lessonsPerWeek),
  }));

  // Seeded up front so a key whose every requirement misses the year still
  // shows up; the walk below only ever raises these.
  const peaks = new Map<string, number>();
  for (const { key } of windows) if (!peaks.has(key)) peaks.set(key, 0);

  for (const monday of mondaysBetween(year.startDate, year.endDate)) {
    // Reallocated per week rather than cleared: a week touches only the keys
    // taught in it, and clearing a Map costs the same as making one this size.
    const week = new Map<string, number>();
    for (const { key, window, lessons } of windows) {
      if (window && teachesInWeek(window, monday)) {
        week.set(key, (week.get(key) ?? 0) + lessons);
      }
    }
    for (const [key, lessons] of week) {
      if (lessons > (peaks.get(key) ?? 0)) peaks.set(key, lessons);
    }
  }
  return peaks;
}

/**
 * Minutes as Swedish hours: "58 h", "58,5 h".
 *
 * Decimal comma, at most one decimal, and a whole number of hours drops the
 * decimal entirely rather than showing "58,0 h" — a timplan is quoted in whole
 * hours far more often than not, and the trailing zero reads as false
 * precision on a figure that is an estimate at requirement level however
 * carefully the lov are subtracted (see teachingWeeks).
 *
 * Formatted by hand rather than through toLocaleString("sv-SE"): sv-SE groups
 * thousands with a non-breaking space, which is correct typography and a
 * menace in a CSV cell or a snapshot diff, and Node's output for it depends on
 * which ICU the runtime was built with. No group separator is emitted at all,
 * so "1200 h" stays one greppable token.
 *
 * A non-finite input gives "0 h"; nothing sensible can be printed for it and a
 * table cell is the wrong place to learn about a NaN.
 */
export function formatHours(minutes: number): string {
  if (!Number.isFinite(minutes)) return "0 h";

  // Rounded on tenths of an hour, not on minutes: 58.04 h is 58 h, and 58,04
  // would be a precision this number does not have.
  const hours = Math.round((minutes / 60) * 10) / 10;
  if (Number.isInteger(hours)) return `${hours} h`;
  return `${hours.toFixed(1).replace(".", ",")} h`;
}
