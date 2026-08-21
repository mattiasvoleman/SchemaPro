import type { LessonRecurrence } from '@prisma/client';

/**
 * When a weekly template actually runs.
 *
 * One module rather than a rule per call site: publishing decides whether to
 * materialise a template on a given date, and the conflict checker decides
 * whether two templates can ever meet. Those answers must agree, or a school
 * is told a slot is free and then gets two lessons in it — or the reverse.
 */
export interface RecurrenceWindow {
  /**
   * Absent is read as ALL_WEEKS, deliberately.
   *
   * The column is NOT NULL with a default, so this only happens if a query
   * forgets to select it — and then the safe reading is the old behaviour,
   * every week. Treating it as a parity would silently drop half of a
   * school's lessons, which looks like data loss rather than a missing
   * column.
   */
  recurrence?: LessonRecurrence | null;
  /** Inclusive; null means "from the start of the academic year". */
  startDate?: Date | null;
  /** Inclusive; null means "until the year ends". */
  endDate?: Date | null;
}

/**
 * ISO-8601 week number for a UTC date.
 *
 * The algorithm is the standard one: move to the Thursday of the same ISO
 * week, then count weeks from that year's first Thursday. Thursday is what
 * decides which year a week belongs to, which is why a 31 December can be
 * week 1 and a 1 January can be week 52 — and why "the week containing
 * January 4th" is the only anchor that gets both right.
 */
export function isoWeekNumber(date: Date): number {
  const target = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const dayOfWeek = target.getUTCDay() === 0 ? 7 : target.getUTCDay();
  target.setUTCDate(target.getUTCDate() + 4 - dayOfWeek);

  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayOfWeek = firstThursday.getUTCDay() === 0 ? 7 : firstThursday.getUTCDay();
  firstThursday.setUTCDate(firstThursday.getUTCDate() + 4 - firstDayOfWeek);

  const weeks = Math.round(
    (target.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000),
  );
  return weeks + 1;
}

/** Whether a template runs on this date, given its recurrence and period. */
export function runsOn(window: RecurrenceWindow, date: Date): boolean {
  if (window.startDate && date < startOfDay(window.startDate)) return false;
  if (window.endDate && date > startOfDay(window.endDate)) return false;

  const recurrence = window.recurrence ?? 'ALL_WEEKS';
  if (recurrence === 'ALL_WEEKS') return true;
  const odd = isoWeekNumber(date) % 2 === 1;
  return recurrence === 'ODD_WEEKS' ? odd : !odd;
}

/**
 * Whether two templates can ever fall in the same week.
 *
 * Used by the conflict checker: two lessons sharing a teacher, room or group
 * in the same time slot are only a clash if some week holds both. Alternating
 * parities never meet; neither do periods that do not overlap. Returning true
 * when unsure is the safe direction — a false clash is an annoyance, a missed
 * one is two classes sent to the same room.
 */
export function weeksCanOverlap(a: RecurrenceWindow, b: RecurrenceWindow): boolean {
  const first = a.recurrence ?? 'ALL_WEEKS';
  const second = b.recurrence ?? 'ALL_WEEKS';
  const opposedParity =
    (first === 'ODD_WEEKS' && second === 'EVEN_WEEKS') ||
    (first === 'EVEN_WEEKS' && second === 'ODD_WEEKS');
  if (opposedParity) return false;

  if (a.endDate && b.startDate && startOfDay(a.endDate) < startOfDay(b.startDate)) {
    return false;
  }
  if (b.endDate && a.startDate && startOfDay(b.endDate) < startOfDay(a.startDate)) {
    return false;
  }

  return true;
}

/** Dates arrive as `@db.Date`, which Prisma hands back at midnight UTC. */
function startOfDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}
