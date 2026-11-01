/**
 * What the approved loans of a borrowed room cover (Delade lokaler och
 * lärare): one rule for the generator, the publish check and the room
 * bookings, so that none of them lets a lesson stand where another refuses
 * it.
 *
 * A time on a date is covered when the union of the approved loans that run
 * on that date, on that weekday, holds it: two loans side by side (10–11 and
 * 11–12) cover 10:30–11:30 together. A weekly lesson is covered when every
 * date it runs is; a lov is no date it runs, so an autumn loan and a spring
 * loan of the same window cover a lesson that runs all year, the jullov
 * between them left out. The callers say which dates count: the generator
 * leaves out the days every årskurs is off, the publish check the days the
 * lesson's group is. A booking is no weekly lesson: it is on its own dates,
 * lov or not, and each of them must be covered.
 *
 * Dates are the school's wall clock ('YYYY-MM-DD'), times minutes after
 * midnight, a span [start, end).
 *
 * PURE.
 */

export type Span = readonly [number, number];

export interface CoverLoan {
  dayOfWeek: number;
  /** Minutes after midnight. */
  start: number;
  end: number;
  /** 'YYYY-MM-DD', inclusive. */
  startDate: string;
  endDate: string;
}

export const minutesOfClock = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

export const addDays = (day: string, days: number): string => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const weekdayOf = (day: string): number => {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return weekday === 0 ? 7 : weekday;
};

/** The spans sorted and merged, those that overlap or touch made one. */
export function mergeSpans(spans: readonly Span[]): Span[] {
  const sorted = spans.filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

/** Whether merged spans hold all of [start, end). */
export function coversSpan(merged: readonly Span[], start: number, end: number): boolean {
  return merged.some(([from, to]) => from <= start && end <= to);
}

/** The time two sets of merged spans both hold. */
export function intersectSpans(a: readonly Span[], b: readonly Span[]): Span[] {
  const out: Span[] = [];
  for (const [aStart, aEnd] of a) {
    for (const [bStart, bEnd] of b) {
      const start = Math.max(aStart, bStart);
      const end = Math.min(aEnd, bEnd);
      if (end > start) out.push([start, end]);
    }
  }
  return mergeSpans(out);
}

/** What the loans cover on one date: the union of those on its weekday that run that day. */
export function coverOn(loans: readonly CoverLoan[], date: string, weekday: number): Span[] {
  return mergeSpans(
    loans
      .filter((loan) => loan.dayOfWeek === weekday && loan.startDate <= date && date <= loan.endDate)
      .map((loan) => [loan.start, loan.end] as const),
  );
}

/** The dates of a weekday in [from, to], those `runs` keeps. */
export function datesOf(weekday: number, from: string, to: string, runs: (date: string) => boolean = () => true): string[] {
  const dates: string[] = [];
  for (let day = addDays(from, (weekday - weekdayOf(from) + 7) % 7); day <= to; day = addDays(day, 7)) {
    if (runs(day)) dates.push(day);
  }
  return dates;
}

/**
 * The time the loans cover on every date of the weekday in [from, to] that
 * `counts` keeps (the generator's plan holds a lesson every school week of
 * the year): the intersection, over the dates, of each date's union.
 * Nothing when no such date falls in the period.
 */
export function coveredOnEveryDate(
  loans: readonly CoverLoan[],
  weekday: number,
  from: string,
  to: string,
  counts: (date: string) => boolean = () => true,
): Span[] {
  const dates = datesOf(weekday, from, to, counts);
  if (dates.length === 0) return [];
  let open: Span[] = coverOn(loans, dates[0]!, weekday);
  for (const date of dates.slice(1)) {
    if (open.length === 0) break;
    open = intersectSpans(open, coverOn(loans, date, weekday));
  }
  return open;
}

/** Whether [start, end) on the weekday is covered on every date in [from, to] the lesson runs. */
export function coveredEveryRun(
  loans: readonly CoverLoan[],
  weekday: number,
  start: number,
  end: number,
  from: string,
  to: string,
  runs: (date: string) => boolean = () => true,
): boolean {
  return datesOf(weekday, from, to, runs).every((date) => coversSpan(coverOn(loans, date, weekday), start, end));
}
