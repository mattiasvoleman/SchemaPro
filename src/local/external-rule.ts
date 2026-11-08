import { zonedTimeToUtc } from '../common/utils/time';

/*
 * THE RULE OF A SERIES, EXPANDED TO ITS DAYS.
 *
 * "Every Tuesday 18-20 for a term" is five facts: the weekdays, how often (every
 * week or every other), the first and last date, and the clock times. The days a
 * series stands for are made from them here and nowhere else; the preview, the
 * registration and the check of a published lesson against a series all read
 * the same list.
 *
 * Dates are the school's local calendar days (yyyy-mm-dd), the times its wall
 * clock; a day's instants are made through the school's zone, so 18:00 is 18:00
 * on both sides of a change of summer time. "Every other week" counts from the
 * ISO week (Monday to Sunday) that holds the first date, so a series that starts
 * on a Thursday has its first week's Thursday and then every second week's.
 *
 * PURE.
 */

export interface SeriesRule {
  /** ISO weekdays, 1 (Monday) to 7 (Sunday). */
  weekdays: readonly number[];
  /** 1 is every week, 2 every other week from the week of startDate. */
  intervalWeeks: number;
  /** yyyy-mm-dd, inclusive. */
  startDate: string;
  /** yyyy-mm-dd, inclusive. */
  endDate: string;
  /** HH:MM, the school's clock. */
  startTime: string;
  /** HH:MM, the school's clock, after startTime on the same day. */
  endTime: string;
}

export interface SeriesDay {
  /** yyyy-mm-dd. */
  date: string;
  startsAt: Date;
  endsAt: Date;
}

const DAY_MS = 86_400_000;

/** A date's midnight as a UTC instant: the arithmetic below never meets a local clock. */
function utcDay(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`);
}

/** 1 (Monday) to 7 (Sunday) of a yyyy-mm-dd. */
export function isoWeekdayOf(date: string): number {
  const day = new Date(utcDay(date)).getUTCDay();
  return day === 0 ? 7 : day;
}

export function addDays(date: string, days: number): string {
  return new Date(utcDay(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The Monday of the ISO week a date is in. */
export function mondayOf(date: string): string {
  return addDays(date, -(isoWeekdayOf(date) - 1));
}

/** Every date from `from` to `to`, inclusive; none when `to` is before `from`. */
export function datesBetween(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let at = utcDay(from); at <= utcDay(to); at += DAY_MS) {
    dates.push(new Date(at).toISOString().slice(0, 10));
  }
  return dates;
}

/** The dates of a rule, without their instants, in order. */
export function ruleDates(rule: SeriesRule): string[] {
  const weekdays = new Set(rule.weekdays);
  const firstMonday = utcDay(mondayOf(rule.startDate));
  const interval = Math.max(1, rule.intervalWeeks);
  const dates: string[] = [];
  for (const date of datesBetween(rule.startDate, rule.endDate)) {
    if (!weekdays.has(isoWeekdayOf(date))) continue;
    const week = Math.floor((utcDay(mondayOf(date)) - firstMonday) / (7 * DAY_MS));
    if (week % interval === 0) dates.push(date);
  }
  return dates;
}

/** The days of a rule with their instants in the school's zone. */
export function expandRule(rule: SeriesRule, timeZone: string): SeriesDay[] {
  return ruleDates(rule).map((date) => ({
    date,
    startsAt: zonedTimeToUtc(date, rule.startTime, timeZone),
    endsAt: zonedTimeToUtc(date, rule.endTime, timeZone),
  }));
}

/** "tisdagar", "måndagar och onsdagar", "måndagar, onsdagar och fredagar" — for a log line or a CSV, not for the screen. */
const WEEKDAY_NAMES = ['måndag', 'tisdag', 'onsdag', 'torsdag', 'fredag', 'lördag', 'söndag'];
export function weekdaysInWords(weekdays: readonly number[]): string {
  const names = [...weekdays].sort((a, b) => a - b).map((day) => `${WEEKDAY_NAMES[day - 1]}ar`);
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} och ${names[names.length - 1]}`;
}
