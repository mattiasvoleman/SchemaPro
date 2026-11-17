import type { RunsWindow } from "@/lib/placement-weeks";

/*
 * Förlägg i veckan, what a card says of the weeks it runs (D2): "udda · HT", "t.o.m. 30 okt.". THE ONLY PART OF THE WEEKS THAT
 * IS DRAWN WITH THE PAGE (every card has a mark), so it is a module of its own, and everything else about weeks
 * (lib/placement-weeks.ts, the picker, the week's narrowing) is fetched after the page is up (the route has bytes for this
 * and no more; memory bundle-gate-measurement). Type imports only from there.
 *
 * Dates are `YYYY-MM-DD` strings read as UTC days. Pure.
 */

/** The words a card's note is written from: the page's translator of `placementWeek.note`. */
export type NoteLookup = (key: string, values?: Record<string, string>) => string;

/** A day as a school writes it on a card: "18 dec". The year is left out; the year the page shows is the läsår. */
export function shortDay(day: string, locale: string): string {
  return new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "sv-SE", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${day.slice(0, 10)}T00:00:00.000Z`));
}

/**
 * What a card says of the dates its lesson runs: "HT" for a post that is the autumn's whole (from the year's start, to a day in
 * December), "VT" for the spring's (from a day in January, to the year's end), else the dates themselves: "t.o.m. 18 dec",
 * "fr.o.m. 11 jan", "17 aug–18 dec". HT and VT are said only for the clean cases; every other window says its dates, which are
 * always true.
 */
export function windowNote(window: Pick<RunsWindow, "startDate" | "endDate">, year: { startDate: string; endDate: string }, locale: string, t: NoteLookup): string | null {
  const start = window.startDate?.slice(0, 10) ?? null;
  const end = window.endDate?.slice(0, 10) ?? null;
  if (start === null && end === null) return null;
  const first = Number(year.startDate.slice(0, 4));
  const yearStart = year.startDate.slice(0, 10);
  const yearEnd = year.endDate.slice(0, 10);
  if ((start === null || start <= yearStart) && end !== null && end >= `${first}-12-01` && end <= `${first}-12-31`) return t("HT");
  if (start !== null && start >= `${first + 1}-01-01` && start <= `${first + 1}-01-31` && (end === null || end >= yearEnd)) return t("VT");
  if (start !== null && end !== null) return t("range", { from: shortDay(start, locale), to: shortDay(end, locale) });
  if (end !== null) return t("until", { date: shortDay(end, locale) });
  return t("from", { date: shortDay(start!, locale) });
}

/** What a card says of its weeks: the parity and the dates, "udda · HT"; null for a lesson that runs every week of the year. */
export function weekNote(lesson: RunsWindow, year: { startDate: string; endDate: string } | null, locale: string, t: NoteLookup): string | null {
  const parts = [
    lesson.recurrence === "ODD_WEEKS" ? t("odd") : lesson.recurrence === "EVEN_WEEKS" ? t("even") : null,
    year ? windowNote(lesson, year, locale, t) : lesson.startDate || lesson.endDate ? t("period") : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}
