/**
 * The weeks a class's meal holds (20270209090000).
 *
 * A LunchSitting and a PublishedLunchSitting say when a class eats on a
 * weekday, and now also in WHICH WEEKS of the läsår: `startDate` and
 * `endDate`, a Monday and a Sunday, either NULL for the läsår's own bound
 * (MasterLesson dates its weeks the same way). A row without dates is what
 * every row was before: the whole läsår.
 *
 * One module, so that no reader has a reading of its own. "Which meal does
 * this class have on this date" and "which meals does this lesson stand
 * beside" are asked by the calendar, the publication, the swap board, the
 * klasslärare's schedule and the exchange file, and they must agree, or a
 * lesson is told it is clear of a meal the pupil is then served.
 *
 * Days are 'YYYY-MM-DD' and compare as text, as src/optimization/
 * year-periods.ts compares them. A `@db.Date` column is a Date at midnight
 * UTC and `windowOf` reads it so.
 */

/**
 * The weeks a row holds: ISO days, null (or absent) for the läsår's own bound.
 * Absent is read as null, so a row that never learned of dates is every week.
 */
export interface SittingWindow {
  startDate?: string | null;
  endDate?: string | null;
}

/** A row's window, from the Date columns Prisma hands back. */
export function windowOf(row: { startDate?: Date | null; endDate?: Date | null }): { startDate: string | null; endDate: string | null } {
  return {
    startDate: row.startDate ? row.startDate.toISOString().slice(0, 10) : null,
    endDate: row.endDate ? row.endDate.toISOString().slice(0, 10) : null,
  };
}

/**
 * A row's window as keys to spread into the object a reader makes of it: the
 * two days when the row has dates, and nothing for a meal of the whole läsår,
 * so a row without dates maps to the very object it always did.
 */
export function windowKeysOf(row: { startDate?: Date | null; endDate?: Date | null }): SittingWindow {
  const window = windowOf(row);
  return window.startDate === null && window.endDate === null ? {} : window;
}

/** Whether the meal is the class's on this day. */
export function sittingHoldsDay(sitting: SittingWindow, day: string): boolean {
  const from = sitting.startDate ?? null;
  const to = sitting.endDate ?? null;
  return (from === null || from <= day) && (to === null || day <= to);
}

/**
 * Whether the meal and a stretch of days share a day: what a lesson that runs
 * only in some weeks must clear. A stretch with no window (a lesson of every
 * week, a lesson of the weekly template) meets every meal, the stricter reading.
 */
export function sittingMeetsWindow(sitting: SittingWindow, window: SittingWindow | null | undefined): boolean {
  if (!window) return true;
  const from = sitting.startDate ?? null;
  const to = sitting.endDate ?? null;
  const windowFrom = window.startDate ?? null;
  const windowTo = window.endDate ?? null;
  return (from === null || windowTo === null || from <= windowTo) && (to === null || windowFrom === null || windowFrom <= to);
}
