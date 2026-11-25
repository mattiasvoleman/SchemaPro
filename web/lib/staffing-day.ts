/*
 * DAYS AS THE READER'S LANGUAGE WRITES THEM, for the cards of the staffing drawer and Min tjänst (the review of #411, L-1 and L-5).
 *
 * A day on those cards was ISO text in both languages ("(2027-05-02)"), and "Satt <dag>" was `decidedAt.slice(0, 10)`: the UTC day of an
 * instant, so a decision taken at 00:30 Swedish time on the 6th of March was said to be set on the 5th. Its own file, apart from
 * lib/staffing-view.ts, which the staffing routes carry whole: only the lazy cards read these.
 *
 * Swedish keeps the ISO day, which is how the Swedish pages write a day. English says "2 May 2027".
 */

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A calendar day ("2027-05-02": the day a rektor wrote, with no time of day) as the language writes it. A calendar day has no time zone
 * to move it, so it is read as UTC midnight and written as UTC. What is not a day is returned as it came.
 */
export function formatDay(day: string, locale: string): string {
  const match = DAY.exec(day);
  if (match === null) return day;
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const at = new Date(Date.UTC(year, month - 1, date));
  // Day 30 of February rolls into March: that is not a day somebody wrote.
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== date) return day;
  return locale === "sv" ? day : new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(at);
}

/**
 * The day an instant falls on in the school's own time zone, as the language writes it: the way `formatStamp` of
 * lib/employment-history-view.ts says the day and the minute, without the minute. An instant that is not one is returned as it came; a time
 * zone that is not one is the UTC day, which is what the card said before.
 */
export function formatDayOf(instant: string, timeZone: string, locale: string): string {
  const at = new Date(instant);
  if (Number.isNaN(at.getTime())) return instant;
  let day = at.toISOString().slice(0, 10);
  try {
    const parts = new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((candidate) => candidate.type === type)?.value ?? "";
    day = `${part("year")}-${part("month")}-${part("day")}`;
  } catch {
    // A time zone Intl does not know: the UTC day above.
  }
  return formatDay(day, locale);
}
