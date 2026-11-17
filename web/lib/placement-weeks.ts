import type { PlacementRecurrence } from "@/lib/requirement-placements";

/*
 * Förlägg i veckan, the weeks: which weeks a läsår has and which of them a lesson
 * runs in (D2). What a card SAYS of its weeks is lib/placement-week-note.ts; both are fetched
 * after the page is up (lib/placement-week-tools.ts).
 *
 * THE SAME PARITY AS THE SERVER'S. An odd-weeks lesson runs the weeks whose ISO 8601
 * week number is odd (src/calendar/lesson-recurrence.ts runsOn). An ISO year of 53
 * weeks therefore has TWO ODD WEEKS IN A ROW at its end (week 53, then week 1 of the
 * next year), and a week picker that counted odd and even in turn from the year's
 * start would be wrong for the whole spring of such a year. The week number is the
 * thing counted here, never the place in the list.
 *
 * A LÄSÅR DOES NOT START ON A MONDAY. Production's läsår starts on a Saturday
 * (2026-08-15): its first Monday-to-Friday week is the next one, and the week that
 * holds the Saturday has no school day in the year at all. A week is a week of the
 * year when one of ITS FIVE SCHOOL DAYS is inside the year, so a year that starts
 * on a Wednesday has its first week (with two days that count) and one that starts on
 * a Saturday does not (memory: periods-are-not-terms).
 *
 * Dates are `YYYY-MM-DD` strings and are read as UTC days, so no clock and no zone
 * can move a week. Pure.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** The days of a school week: Monday to Friday. */
export const SCHOOL_DAYS = 5;

const asMs = (day: string): number => Date.parse(`${day.slice(0, 10)}T00:00:00.000Z`);
const asDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The day `count` days after (or before, when negative) `day`. */
export const addDays = (day: string, count: number): string => asDay(asMs(day) + count * DAY_MS);

/** The Monday of the week that holds `day`. */
export function mondayOf(day: string): string {
  const weekday = new Date(asMs(day)).getUTCDay();
  return addDays(day, -((weekday + 6) % 7));
}

/**
 * The ISO 8601 week number of a day: the number of the week whose Thursday it is
 * (the same arithmetic as the server's isoWeekNumber, written out here so that it
 * can be read next to it).
 */
export function isoWeekOf(day: string): number {
  const thursday = asMs(mondayOf(day)) + 3 * DAY_MS;
  const year = new Date(thursday).getUTCFullYear();
  const firstThursday = asMs(mondayOf(`${year}-01-04`)) + 3 * DAY_MS;
  return Math.round((thursday - firstThursday) / (7 * DAY_MS)) + 1;
}

/** The parity of the week that holds `day`: what an odd-weeks lesson and an even-weeks lesson are told apart by. */
export const parityOfDay = (day: string): "ODD_WEEKS" | "EVEN_WEEKS" => (isoWeekOf(day) % 2 === 1 ? "ODD_WEEKS" : "EVEN_WEEKS");

/** The school's terms as a school says them: HT is the autumn (July to December by the week's Thursday), VT the spring. */
export type Term = "HT" | "VT";

/** One week of a läsår. `monday` names it: it is the week's identity everywhere on the page. */
export interface YearWeek {
  monday: string;
  /** The week's Friday: its last school day. */
  friday: string;
  /** The ISO week number. */
  week: number;
  parity: "ODD_WEEKS" | "EVEN_WEEKS";
  term: Term;
}

/** The term of a week, decided by its Thursday as the week number is (a week that holds New Year's Day belongs to the year its Thursday does). */
export const termOfWeek = (monday: string): Term => (Number(addDays(monday, 3).slice(5, 7)) >= 7 ? "HT" : "VT");

/** What a week is made of, from its Monday. */
export const yearWeekOf = (monday: string): YearWeek => ({
  monday,
  friday: addDays(monday, SCHOOL_DAYS - 1),
  week: isoWeekOf(monday),
  parity: parityOfDay(monday),
  term: termOfWeek(monday),
});

/**
 * The weeks of a läsår, in order: every week one of whose school days (Monday to Friday) is inside it. A year of
 * 2026-08-15 to 2027-06-11 starts on the Monday 2026-08-17 and ends on the week of 2027-06-07.
 */
export function weeksOfYear(startDate: string, endDate: string): YearWeek[] {
  const start = startDate.slice(0, 10);
  const end = endDate.slice(0, 10);
  const weeks: YearWeek[] = [];
  // A year is not longer than a few hundred weeks; the bound keeps a bad date (a year that ends before it starts, or in 9999) from looping.
  for (let monday = mondayOf(start); monday <= end && weeks.length < 120; monday = addDays(monday, 7)) {
    const week = yearWeekOf(monday);
    if (week.friday >= start) weeks.push(week);
  }
  return weeks;
}

/** What decides whether a lesson runs a day: its weeks and its dates. */
export interface RunsWindow {
  recurrence: PlacementRecurrence;
  startDate: string | null;
  endDate: string | null;
}

/**
 * Whether a lesson on `dayOfWeek` runs in the week that starts on `monday`: its own day of that week must be inside its dates
 * (a window that ends on a Tuesday does not hold the Thursday of that week) and the week must be one of its parity. This is the
 * server's runsOn for the day, which is what publishing materialises.
 */
export function runsInWeek(window: RunsWindow, dayOfWeek: number, monday: string): boolean {
  const day = addDays(monday, dayOfWeek - 1);
  if (window.startDate && day < window.startDate.slice(0, 10)) return false;
  if (window.endDate && day > window.endDate.slice(0, 10)) return false;
  if (window.recurrence === "ALL_WEEKS") return true;
  return parityOfDay(monday) === window.recurrence;
}

/**
 * The week of the given parity nearest to the one picked: the next one if it has that parity (it does, except across the end of an
 * ISO year of 53 weeks), else the one before, else the nearest either side. Null when the year has none (a year of one week).
 */
export function nearestWeekOf(weeks: readonly YearWeek[], monday: string, parity: "ODD_WEEKS" | "EVEN_WEEKS"): YearWeek | null {
  const at = weeks.findIndex((week) => week.monday === monday);
  if (at === -1) return null;
  for (let distance = 1; distance < weeks.length; distance++) {
    for (const index of [at + distance, at - distance]) {
      const week = weeks[index];
      if (week && week.parity === parity) return week;
    }
  }
  return null;
}

/** The days of a week for the grid's headers (local midnight, as the grid compares them with today's date). */
export function datesOfWeek(monday: string): Date[] {
  return Array.from({ length: SCHOOL_DAYS }, (_, index) => {
    const [year, month, day] = addDays(monday, index).split("-").map(Number);
    return new Date(year!, month! - 1, day!);
  });
}
