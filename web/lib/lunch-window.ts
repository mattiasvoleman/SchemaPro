/**
 * The weeks a class's meal holds (20270209090000), as the screens read them.
 *
 * A meal says when a class eats on a weekday and, since then, in which weeks of
 * the läsår: `startDate` (a Monday) and `endDate` (a Sunday), either null for
 * the läsår's own bound. A meal without dates is the whole läsår, as every meal
 * was. This is the API's src/common/lunch-window.ts in the browser's words, and
 * the two must read a date alike: a lesson is told it is clear of a meal the
 * pupil is then served only when they do not.
 *
 * Days are 'YYYY-MM-DD' and compare as text.
 */

/** The weeks a meal holds: null or absent for the läsår's own bound. */
export interface MealWindow {
  startDate?: string | null;
  endDate?: string | null;
}

/** Whether the meal is the class's on this day. */
export function mealHoldsDay(meal: MealWindow, day: string): boolean {
  const from = meal.startDate ?? null;
  const to = meal.endDate ?? null;
  return (from === null || from <= day) && (to === null || day <= to);
}

/**
 * Whether the meal and a stretch of days share a day: what a lesson that runs
 * only in some weeks must clear. A lesson with no window meets every meal, the
 * stricter reading.
 */
export function mealMeetsWindow(meal: MealWindow, window: MealWindow | null | undefined): boolean {
  if (!window) return true;
  const from = meal.startDate ?? null;
  const to = meal.endDate ?? null;
  const windowFrom = window.startDate ?? null;
  const windowTo = window.endDate ?? null;
  return (from === null || windowTo === null || from <= windowTo) && (to === null || windowFrom === null || windowFrom <= to);
}

/** Whether some meal holds only some weeks: when a screen has to say which. */
export function anyMealDated(meals: readonly MealWindow[]): boolean {
  return meals.some((meal) => (meal.startDate ?? null) !== null || (meal.endDate ?? null) !== null);
}

/** The meals that are served on a day. */
export function mealsOnDay<M extends MealWindow>(meals: readonly M[], day: string): M[] {
  return meals.filter((meal) => mealHoldsDay(meal, day));
}

/**
 * How a dated meal is said, as the parts of a sentence: which bounds it has and
 * the days written out in the reader's language. Null for a meal of the whole
 * läsår, which the screens say nothing about.
 */
export interface MealWeeks {
  kind: "between" | "from" | "to";
  from: string;
  to: string;
}

export function mealWeeksOf(meal: MealWindow, formatDay: (day: string) => string): MealWeeks | null {
  const from = meal.startDate ?? null;
  const to = meal.endDate ?? null;
  if (from === null && to === null) return null;
  return {
    kind: from !== null && to !== null ? "between" : from !== null ? "from" : "to",
    from: from === null ? "" : formatDay(from),
    to: to === null ? "" : formatDay(to),
  };
}

/** A day of a meal's weeks as the reader writes it: "17 aug". */
export function mealDayFormatter(locale: string): (day: string) => string {
  const format = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" });
  return (day) => format.format(new Date(`${day}T00:00:00.000Z`));
}

/** Today as a day of the läsår: clamped to its first and last, for a screen that opens on "now". */
export function dayWithin(day: string, first: string | undefined, last: string | undefined): string {
  if (first !== undefined && day < first) return first;
  if (last !== undefined && day > last) return last;
  return day;
}
