import { zonedTimeToUtc } from '../common/utils/time';
import type { ClosedRange, YearBounds } from '../staffing/teaching-weeks';
import { closedFor } from './supervision-coverage';

/**
 * THE DAYS A PASS RUNS (Rastvakt i vardagen, 20261210090000).
 *
 * A pass is a weekly row of the rastvaktsschema (20261207090000); the
 * school's day meets it on dates. A pass runs on a date when:
 *
 *   * the date is the pass's weekday;
 *   * it lies between Från and Till, a null date read as the läsår's own
 *     bound (the year's bounds are the outer limit either way);
 *   * no lov closes the area that day: the whole school, or every årskurs of
 *     the area's span (supervision-coverage.ts closedFor, the rule the gaps
 *     read; the closures in NIOARIG, as the area's span is);
 *   * its teacher was not deactivated by then: a pass watches until the day
 *     before `inactiveFrom`, as the gaps and the load read it.
 *
 * Its time that day is the date and the pass's clock on the school's clock,
 * as instants, the way a lesson's startsAt and endsAt are.
 *
 * Read by the board (the vacancies of an absent teacher), by the cover rules
 * (a person's own passes hold their time) and by the teacher's week. PURE: no
 * clock and no database.
 */

export interface PassRule {
  /** ISO weekday 1..7. */
  dayOfWeek: number;
  /** Minutes from midnight, start before end. */
  start: number;
  end: number;
  /** Inclusive yyyy-mm-dd, or null for the läsår's own bound. */
  validFrom: string | null;
  validTo: string | null;
  /** The teacher's deactivation day (the school's date); null or absent while active. */
  inactiveFrom?: string | null;
}

export interface PassArea {
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const asDay = (value: Date) => value.toISOString().slice(0, 10);
const addDays = (day: string, days: number) => asDay(new Date(new Date(`${day}T00:00:00.000Z`).getTime() + days * DAY_MS));
const isoWeekday = (day: string) => {
  const weekday = new Date(`${day}T00:00:00.000Z`).getUTCDay();
  return weekday === 0 ? 7 : weekday;
};

/** HH:MM of minutes from midnight. */
export function clockOf(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** The dates in [from, to] the pass runs, earliest first. */
export function passDates(
  pass: PassRule,
  area: PassArea,
  year: YearBounds,
  closures: readonly ClosedRange[],
  from: string,
  to: string,
): string[] {
  const first = [from, pass.validFrom ?? year.startDate, year.startDate].reduce((a, b) => (a > b ? a : b));
  let last = [to, pass.validTo ?? year.endDate, year.endDate].reduce((a, b) => (a < b ? a : b));
  if (pass.inactiveFrom) {
    const lastWatched = addDays(pass.inactiveFrom, -1);
    if (lastWatched < last) last = lastWatched;
  }
  const dates: string[] = [];
  for (let day = addDays(first, (pass.dayOfWeek - isoWeekday(first) + 7) % 7); day <= last; day = addDays(day, 7)) {
    if (!closedFor(area, closures, day)) dates.push(day);
  }
  return dates;
}

/** Whether the pass runs on `date`. */
export function passRunsOn(
  pass: PassRule,
  area: PassArea,
  year: YearBounds,
  closures: readonly ClosedRange[],
  date: string,
): boolean {
  return passDates(pass, area, year, closures, date, date).length === 1;
}

/** The pass's time on `date`, on the school's clock, as instants. */
export function passSpan(
  pass: Pick<PassRule, 'start' | 'end'>,
  date: string,
  timezone: string,
): { startsAt: Date; endsAt: Date } {
  return {
    startsAt: zonedTimeToUtc(date, clockOf(pass.start), timezone),
    endsAt: zonedTimeToUtc(date, clockOf(pass.end), timezone),
  };
}

/** [a, b) and [c, d) share an instant; touching is free. */
export function spansMeet(a: { startsAt: Date; endsAt: Date }, b: { startsAt: Date; endsAt: Date }): boolean {
  return a.startsAt.getTime() < b.endsAt.getTime() && b.startsAt.getTime() < a.endsAt.getTime();
}
