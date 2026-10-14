/**
 * Dates for the fixtures: the current week, seen from its Wednesday.
 *
 * The pages ask for "this week" with the real clock, and the Next.js
 * server's clock cannot be frozen from a spec. So the fixtures move with the
 * calendar: the läsår is the one around today and the lessons are this
 * week's. Inside the week they stand still: the fixture school's today is
 * the week's Wednesday at 10:00 (NOW), whatever day the suite runs, and the
 * signed-in specs freeze the browser's clock there (e2e/signed-in.ts). So a
 * page that shows "today" — the cover board, a guardian's day, the lessons
 * held so far — says the same on a Monday run as on a Saturday one, and an
 * accessibility-tree baseline holds all week. Only what the Next.js server
 * renders itself with "today" (the counts on /admin) still follows the real
 * day.
 */

const STOCKHOLM = "Europe/Stockholm";

/** YYYY-MM-DD of an instant, in Stockholm. */
export function stockholmDate(instant: Date): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: STOCKHOLM }).format(instant);
}

export function addDays(date: string, days: number): string {
  const instant = new Date(`${date}T12:00:00Z`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}

/** 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: string): number {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

/** Monday of the week `date` falls in. */
export const mondayOf = (date: string) => addDays(date, 1 - isoWeekday(date));

export const THIS_MONDAY = mondayOf(stockholmDate(new Date()));

/** The fixture school's today: this week's Wednesday. */
export const TODAY = addDays(THIS_MONDAY, 2);

/** The weekday `dayOfWeek` (1–5) of this week. */
export const thisWeek = (dayOfWeek: number) => addDays(THIS_MONDAY, dayOfWeek - 1);

/** "08:10" or "08:10:00" on a Stockholm date, as the UTC instant PostgREST sends for a timestamptz. */
export function stockholmInstant(date: string, time: string): string {
  const [hours, minutes] = time.split(":").map(Number);
  // Guess UTC, then correct by Stockholm's offset at that instant (CET/CEST).
  const guess = new Date(`${date}T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00Z`);
  const offset = new Intl.DateTimeFormat("en-US", { timeZone: STOCKHOLM, timeZoneName: "shortOffset" })
    .formatToParts(guess)
    .find((part) => part.type === "timeZoneName")!.value; // "GMT+2"
  const hoursAhead = Number(offset.replace("GMT", "") || 0);
  return new Date(guess.getTime() - hoursAhead * 3_600_000).toISOString();
}

/** The fixture school's now, 10:00 on its today, as an ISO instant. */
export const NOW = stockholmInstant(TODAY, "10:00");

/** The läsår around today: mid-August to mid-June. */
const autumnYear = Number(TODAY.slice(0, 4)) - (Number(TODAY.slice(5, 7)) < 7 ? 1 : 0);
export const YEAR_START = `${autumnYear}-08-17`;
export const YEAR_END = `${autumnYear + 1}-06-11`;
export const YEAR_NAME = `${autumnYear}/${String(autumnYear + 1).slice(2)}`;
export const NEXT_YEAR_START = `${autumnYear + 1}-08-16`;
export const NEXT_YEAR_END = `${autumnYear + 2}-06-10`;
export const NEXT_YEAR_NAME = `${autumnYear + 1}/${String(autumnYear + 2).slice(2)}`;
export const AUTUMN_YEAR = autumnYear;
