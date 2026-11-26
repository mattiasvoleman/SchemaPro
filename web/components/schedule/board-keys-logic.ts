/**
 * What the arrow keys mean on the board, apart from React and the DOM.
 *
 * Two things, and they are not the same thing: with nothing in hand an arrow moves FOCUS from one lesson to the next
 * (so that the week can be read with a keyboard and nothing is moved by a slip), and with a lesson in hand (taken up
 * with Space) an arrow moves a MARKER, the square the lesson would be put down on. The functions below are those two
 * moves, and the length change, as plain arithmetic on minutes, so that the rules can be tested without a browser.
 */

export interface KeyLesson {
  id: string;
  dayOfWeek: number;
  startMinutes: number;
  endMinutes: number;
}

export type Arrow = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";

/** A lesson in reading order: the day first, then the time, then the end (the longer after the shorter), then its id so that the order is total. */
export function inReadingOrder<T extends KeyLesson>(lessons: readonly T[]): T[] {
  return [...lessons].sort(
    (a, b) =>
      a.dayOfWeek - b.dayOfWeek ||
      a.startMinutes - b.startMinutes ||
      a.endMinutes - b.endMinutes ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/**
 * The lesson an arrow, Home or End takes focus to, or null when there is none that way (the key then does nothing, and is
 * not an error).
 *
 *   Up, Down     the previous and the next lesson of the same day, in time order (two that run side by side are taken one
 *                after the other, the one that starts first first)
 *   Left, Right  the nearest day that has a lesson, and in it the lesson that starts closest to the one left (the
 *                earlier of two at the same distance)
 *   Home, End    the first and the last of the day
 */
export function focusAfter(
  lessons: readonly KeyLesson[],
  fromId: string,
  key: Arrow | "Home" | "End",
): string | null {
  const from = lessons.find((lesson) => lesson.id === fromId);
  if (!from) return null;
  const ordered = inReadingOrder(lessons);
  const ofDay = (day: number) => ordered.filter((lesson) => lesson.dayOfWeek === day);

  if (key === "ArrowUp" || key === "ArrowDown" || key === "Home" || key === "End") {
    const day = ofDay(from.dayOfWeek);
    const at = day.findIndex((lesson) => lesson.id === from.id);
    if (key === "Home") return day[0]?.id ?? null;
    if (key === "End") return day[day.length - 1]?.id ?? null;
    return day[key === "ArrowUp" ? at - 1 : at + 1]?.id ?? null;
  }

  const days = [...new Set(ordered.map((lesson) => lesson.dayOfWeek))].sort((a, b) => a - b);
  const next = key === "ArrowLeft" ? [...days].reverse().find((day) => day < from.dayOfWeek) : days.find((day) => day > from.dayOfWeek);
  if (next === undefined) return null;
  const closest = ofDay(next).reduce((best, lesson) =>
    Math.abs(lesson.startMinutes - from.startMinutes) < Math.abs(best.startMinutes - from.startMinutes) ? lesson : best,
  );
  return closest.id;
}

/** The square a lesson would be put down on: its day, and where it starts and ends. */
export interface Marker {
  dayOfWeek: number;
  startMinutes: number;
  endMinutes: number;
}

/** The grid's own limits, which the marker must stay inside. */
export interface Bounds {
  dayCount: number;
  dayStartMinutes: number;
  dayEndMinutes: number;
}

/** A step of the marker is a quarter of an hour; with Shift, five minutes (the step of a drag). */
export const STEP_MINUTES = 15;
export const FINE_STEP_MINUTES = 5;
/** Alt and an arrow change the length by this much. */
export const LENGTH_STEP_MINUTES = 5;
export const MIN_LENGTH_MINUTES = 15;

/**
 * The marker after an arrow: Up and Down a step earlier and later (the length is kept), Left and Right the day before and
 * the day after. Held inside the week and the hours the grid draws, so the marker never leaves the screen; at the edge it
 * stays where it is, and the caller sees that nothing changed.
 */
export function markerAfter(marker: Marker, key: Arrow, bounds: Bounds, fine = false): Marker {
  const length = marker.endMinutes - marker.startMinutes;
  let day = marker.dayOfWeek;
  let start = marker.startMinutes;
  const step = fine ? FINE_STEP_MINUTES : STEP_MINUTES;
  if (key === "ArrowUp") start -= step;
  else if (key === "ArrowDown") start += step;
  else if (key === "ArrowLeft") day -= 1;
  else day += 1;
  day = Math.min(bounds.dayCount, Math.max(1, day));
  start = Math.max(bounds.dayStartMinutes, Math.min(start, bounds.dayEndMinutes - length));
  return { dayOfWeek: day, startMinutes: start, endMinutes: start + length };
}

/**
 * The lesson with its length changed by `delta` minutes, the start kept; null when that would make it shorter than the
 * grid's shortest or run past the end of the day.
 */
export function lengthened(lesson: KeyLesson, delta: number, bounds: Bounds): Marker | null {
  const end = lesson.endMinutes + delta;
  if (end - lesson.startMinutes < MIN_LENGTH_MINUTES || end > bounds.dayEndMinutes) return null;
  return { dayOfWeek: lesson.dayOfWeek, startMinutes: lesson.startMinutes, endMinutes: end };
}

export function sameSquare(a: Marker, b: Marker): boolean {
  return a.dayOfWeek === b.dayOfWeek && a.startMinutes === b.startMinutes && a.endMinutes === b.endMinutes;
}
