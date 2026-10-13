import type { LoadEmployment } from "@/lib/teacher-load";
import type { YearBounds } from "@/lib/teaching-hours";

/*
 * En tjänst över läsåret: the base row and the periods that override it
 * (migration 20261022120000).
 *
 * THE MIRROR of src/staffing/employment-periods.ts, body for body, for the
 * figures the browser states before a round trip; the load fixture
 * (src/staffing/__fixtures__/teacher-load-cases.json) replays both through
 * the report. Dates are yyyy-mm-dd strings and read in UTC, so the browser's
 * own time zone cannot move a week.
 *
 * THE POST ON A DATE is one function, postOn: the period covering the day, or
 * the base row on a day no period covers. Periods of one post never overlap
 * (the EXCLUDE), so the answer is one. Every reader that asks about a date —
 * SCB on its mätdatum, SS12000's Duty, the vikarie ranking on the lesson's
 * day, the staffing proposal — asks it.
 *
 * THE TARGET APPLIES PER ISO WEEK. The load report and the staffing checks
 * count minutes per week, so a post is cut into STRETCHES of whole weeks: an
 * ISO week belongs to the post in force on its Monday — or on the läsår's
 * first day, for a year that does not start on one. A period from Sunday
 * 1 november is the post from the week of Monday 2 november; one from a
 * Wednesday is the post from the next Monday, and the week it starts in
 * keeps the figures it began with. Each stretch states the dates the school
 * typed (`from`, `to`: a period's own, the base row's between them) and the
 * window of whole weeks the arithmetic counts (`window`), which is null for
 * a stretch that holds no Monday at all — the service refuses such a period,
 * but a row PostgREST wrote can be one.
 */

/** One period of a post, as the report and the checks read it. */
export interface LoadPeriod {
  /** Från, yyyy-mm-dd inclusive. */
  validFrom: string;
  /** Till, yyyy-mm-dd inclusive; null = the läsår's last day. */
  validTo: string | null;
  employmentPercent: number;
  reductionPercent: number;
  /** Own riktmärke for the period; null = derived from the school's. */
  teachingTargetMinutesPerWeek: number | null;
}

/** The figures a period can change. */
export type PostFigures = Pick<
  LoadEmployment,
  "employmentPercent" | "reductionPercent" | "teachingTargetMinutesPerWeek"
>;

/** One stretch of a post over the läsår. */
export interface PostStretchDates {
  /** The dates the stretch states, yyyy-mm-dd inclusive, inside the läsår. */
  from: string;
  to: string;
  /** BASE: a stretch on the base row. PERIOD: one of the post's periods. */
  kind: "BASE" | "PERIOD";
  figures: PostFigures;
  /**
   * The whole weeks the figures hold for, clamped to the läsår: from the
   * first Monday in force to the Sunday of the last. Null when the stretch
   * holds no week.
   */
  window: YearBounds | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function parseDay(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function toDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(day: string, days: number): string {
  return toDay(new Date(parseDay(day).getTime() + days * DAY_MS));
}

/** The Monday of the ISO week holding `day`. */
function mondayOf(day: string): string {
  const weekday = parseDay(day).getUTCDay();
  return addDays(day, 1 - (weekday === 0 ? 7 : weekday));
}

const later = (a: string, b: string): string => (a > b ? a : b);
const earlier = (a: string, b: string): string => (a < b ? a : b);

const figuresOf = (post: PostFigures): PostFigures => ({
  employmentPercent: post.employmentPercent,
  reductionPercent: post.reductionPercent,
  teachingTargetMinutesPerWeek: post.teachingTargetMinutesPerWeek,
});

/** The post's periods by Från, each cut to the läsår; the ones outside it gone. */
function periodsInYear(
  periods: readonly LoadPeriod[] | undefined,
  year: YearBounds,
): (LoadPeriod & { from: string; to: string })[] {
  return [...(periods ?? [])]
    .map((period) => ({
      ...period,
      from: later(period.validFrom, year.startDate),
      to: earlier(period.validTo ?? year.endDate, year.endDate),
    }))
    .filter((period) => period.from <= period.to)
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
}

/**
 * The post in force on `day`: the employment with a covering period's three
 * figures, or the employment itself on a day no period covers. Everything
 * else about the post — avtalsform, signature — is the base row's.
 */
export function postOn<T extends PostFigures & { periods?: readonly LoadPeriod[] }>(
  employment: T,
  day: string,
): T {
  const period = (employment.periods ?? []).find(
    (candidate) => candidate.validFrom <= day && (candidate.validTo === null || day <= candidate.validTo),
  );
  return period ? { ...employment, ...figuresOf(period) } : employment;
}

/**
 * Whether the post changes during the läsår: some period covers a day of it.
 * A post that does not is read exactly as it always was.
 */
export function changesDuringYear(
  employment: { periods?: readonly LoadPeriod[] } | null | undefined,
  year: YearBounds,
): boolean {
  return periodsInYear(employment?.periods, year).length > 0;
}

/**
 * The post cut into stretches over the läsår, in date order: the base row's
 * between and around the periods, each period its own. Together the
 * stretches' dates cover the year, and their windows its weeks, each once.
 */
export function postStretches(
  employment: PostFigures & { periods?: readonly LoadPeriod[] },
  year: YearBounds,
): PostStretchDates[] {
  const base = figuresOf(employment);
  const stretches: Omit<PostStretchDates, "window">[] = [];
  let cursor = year.startDate;
  for (const period of periodsInYear(employment.periods, year)) {
    if (period.from > cursor) {
      stretches.push({ from: cursor, to: addDays(period.from, -1), kind: "BASE", figures: base });
    }
    stretches.push({ from: period.from, to: period.to, kind: "PERIOD", figures: figuresOf(period) });
    cursor = addDays(period.to, 1);
  }
  if (cursor <= year.endDate) {
    stretches.push({ from: cursor, to: year.endDate, kind: "BASE", figures: base });
  }

  // Each week to the stretch in force on its Monday, or on the first day.
  const windows: (YearBounds | null)[] = stretches.map(() => null);
  for (let monday = mondayOf(year.startDate); monday <= year.endDate; monday = addDays(monday, 7)) {
    const day = later(monday, year.startDate);
    const index = stretches.findIndex((stretch) => stretch.from <= day && day <= stretch.to);
    if (index === -1) continue;
    const weekEnd = earlier(addDays(monday, 6), year.endDate);
    const current = windows[index];
    windows[index] = current ? { startDate: current.startDate, endDate: weekEnd } : { startDate: day, endDate: weekEnd };
  }
  return stretches.map((stretch, index) => ({ ...stretch, window: windows[index] ?? null }));
}
