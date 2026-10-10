import type { Locale } from './translate';

/**
 * Dates and times in the reader's language, without Intl.
 *
 * Hermes' Intl support depends on how the engine was built, and
 * toLocaleTimeString's hour cycle follows the device's region rather than the
 * app's language: a Swedish reader on an American-region phone got "8:05 AM".
 * Jest runs on Node's full ICU and would pass whatever the device does, so
 * these are hand-written tables and arithmetic instead — the same output on
 * every engine, and testable for what a phone will actually show.
 *
 *   * times are 24-hour, zero-padded, on the DEVICE's clock for an instant
 *     ("08:05"): an ISO instant from the database is a moment, and the phone
 *     shows it where the phone is — as the screens always have;
 *   * a server date "YYYY-MM-DD" is split into its components and never passed
 *     to new Date('YYYY-MM-DD'), which parses as UTC midnight and is the
 *     previous day anywhere west of Greenwich.
 */

const WEEKDAYS: Record<Locale, readonly string[]> = {
  // Sunday first, as Date#getDay counts.
  sv: ['söndag', 'måndag', 'tisdag', 'onsdag', 'torsdag', 'fredag', 'lördag'],
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
};

const WEEKDAYS_SHORT: Record<Locale, readonly string[]> = {
  sv: ['sön', 'mån', 'tis', 'ons', 'tors', 'fre', 'lör'],
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
};

const MONTHS: Record<Locale, readonly string[]> = {
  sv: ['januari', 'februari', 'mars', 'april', 'maj', 'juni', 'juli', 'augusti', 'september', 'oktober', 'november', 'december'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
};

const MONTHS_SHORT: Record<Locale, readonly string[]> = {
  sv: ['jan', 'feb', 'mars', 'apr', 'maj', 'juni', 'juli', 'aug', 'sep', 'okt', 'nov', 'dec'],
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
};

const pad2 = (value: number): string => (value < 10 ? `0${value}` : String(value));

/** The components of a "YYYY-MM-DD" (any trailing time is ignored). */
export function dateParts(date: string): { year: number; month: number; day: number } {
  const [year, month, day] = date.slice(0, 10).split('-').map(Number) as [number, number, number];
  return { year, month, day };
}

/** Sunday-first weekday of a calendar date, by its components. */
function weekdayIndex(date: string): number {
  const { year, month, day } = dateParts(date);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** "08:05" — an instant on the device's clock, 24-hour. */
export function formatTime(iso: string): string {
  const at = new Date(iso);
  return `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
}

/** "08:00–08:45". */
export function formatTimeRange(startIso: string, endIso: string): string {
  return `${formatTime(startIso)}–${formatTime(endIso)}`;
}

/** "tisdag 13 oktober" / "Tuesday 13 October" — a calendar date, no zone involved. */
export function formatDayHeading(date: string, locale: Locale): string {
  const { month, day } = dateParts(date);
  return `${WEEKDAYS[locale][weekdayIndex(date)]} ${day} ${MONTHS[locale][month - 1]}`;
}

/** "13 okt" / "13 Oct" — a calendar date, short. */
export function formatShortDate(date: string, locale: Locale): string {
  const { month, day } = dateParts(date);
  return `${day} ${MONTHS_SHORT[locale][month - 1]}`;
}

/** "tis 13 okt 08:00" / "Tue 13 Oct 08:00" — an instant on the device's clock. */
export function formatDateTime(iso: string, locale: Locale): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return `${WEEKDAYS_SHORT[locale][at.getDay()]} ${at.getDate()} ${MONTHS_SHORT[locale][at.getMonth()]} ${formatTime(iso)}`;
}

/** "tis 13 okt" — the device's calendar day of an instant. */
export function formatDayOfInstant(iso: string, locale: Locale): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return `${WEEKDAYS_SHORT[locale][at.getDay()]} ${at.getDate()} ${MONTHS_SHORT[locale][at.getMonth()]}`;
}

/** The device's calendar date of an instant, "YYYY-MM-DD" — for "today" on the phone. */
export function localDate(at: Date = new Date()): string {
  return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`;
}

/** A calendar date shifted by whole days, by its components. */
export function shiftDate(date: string, days: number): string {
  const { year, month, day } = dateParts(date);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}
