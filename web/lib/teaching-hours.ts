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
// TWO THINGS THIS DELIBERATELY DOES NOT MODEL
//
// 1. Holidays. There is no SchoolClosure table, no term-break model, nothing
//    anywhere in the app that knows a week is a lov. So every number here
//    counts CALENDAR weeks inside the period, not actual teaching weeks. A
//    Swedish läsår loses roughly 8-10 weeks to höstlov, jullov, sportlov,
//    påsklov and studiedagar, so annualMinutes reads high by about that
//    fraction. Wording in the UI has to say "kalenderveckor"; the fix is a
//    closure model, not a fudge factor invented here.
// 2. Partly covered edge weeks. A period starting on a Wednesday still counts
//    that whole week (see weeksInPeriod). Also an overestimate, but a much
//    smaller one, and the alternative — counting fifths of a week — produces
//    fractional weeks that no one can check against a timetable by eye.
//
// Both overestimate in the same direction, which is the honest direction for a
// planning figure: nobody is harmed by budgeting for a week that turns out to
// be a lov, and the opposite error hides an under-taught subject.

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

export interface RequirementLoad extends TeachingPeriod {
  lessonsPerWeek: number;
  minutesPerLesson: number;
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
 * as 3/5 was tried on paper and thrown out — it turns every figure downstream
 * into a decimal nobody can reconcile against a printed timetable, to correct
 * an error far smaller than the holidays this module cannot see at all (see the
 * file header).
 *
 * The count is CALENDAR weeks. There is no closure model in the app, so lov and
 * studiedagar are all counted as taught.
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
 * weeks x lessons per week x minutes per lesson. Same caveat as weeksInPeriod:
 * these are calendar weeks, so the figure is an upper bound on real teaching
 * time, not the delivered time.
 */
export function annualMinutes(req: RequirementLoad, year: YearBounds): number {
  return (
    weeksInPeriod(req, year) * load(req.lessonsPerWeek) * load(req.minutesPerLesson)
  );
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
 * precision on a figure that already cannot see holidays.
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
