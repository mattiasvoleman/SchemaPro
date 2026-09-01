import type { GradeSpan } from "@/lib/grade-span";
import { timeToMinutes } from "@/lib/utils";

/**
 * A lunchsittning: the window one stage of the school may eat in.
 *
 * Mirrors the row in LunchServings and the engine's `LunchServing`. Clock
 * strings are HH:MM:SS as PostgREST returns them.
 */
export interface LunchServing {
  id: string;
  minGradeLevel: number;
  maxGradeLevel: number;
  /** ISO weekday 1-7, or null for every teaching day. */
  dayOfWeek: number | null;
  startTime: string;
  endTime: string;
  /** Chairs for this sitting; null means the hall's own limit. */
  seats: number | null;
}

/**
 * The sittings open to one stage on one weekday, in the order they were given.
 *
 * TWO RULES, and both are the engine's — see
 * optimization-engine/app/solver/servings.py, which owns them. Keeping a second
 * implementation here is a deliberate cost: the page's whole value is showing a
 * school what its rows ADD UP TO, and a preview computed by a different rule
 * than the solver's would be worse than no preview at all.
 *
 *   MATCHING IS OVERLAP. A group whose years touch the sitting's span may
 *   attend it, so a 6-7 group reaches both a 4-6 and a 7-9 sitting.
 *
 *   A DAY-SPECIFIC ROW REPLACES THE EVERY-DAY ROWS for that day. "Alla dagar
 *   12:20-13:00" plus "fredag 11:40-12:20" is a school saying Friday is
 *   different, not that Friday is wider.
 *
 * An empty result means no sitting speaks about this stage that day, which
 * leaves the school-wide lunch window in place — a different fact from a
 * sitting too short to eat in, which is a refusal the engine makes.
 */
export function servingsFor(
  servings: LunchServing[],
  span: GradeSpan | undefined,
  dayOfWeek: number,
): LunchServing[] {
  if (!span) return [];

  const matching = servings.filter(
    (serving) =>
      span.max >= serving.minGradeLevel && span.min <= serving.maxGradeLevel,
  );
  const today = matching.filter((serving) => serving.dayOfWeek === dayOfWeek);
  return today.length > 0
    ? today
    : matching.filter((serving) => serving.dayOfWeek === null);
}

/**
 * Whether a meal of `minutes` fits in any sitting open to this stage that day.
 *
 * The check the engine makes before it refuses, restated here so the page can
 * say it while the admin is still looking at the form rather than after a
 * generation run comes back 400.
 */
export function fitsAServing(
  servings: LunchServing[],
  span: GradeSpan | undefined,
  dayOfWeek: number,
  minutes: number,
): boolean {
  const open = servingsFor(servings, span, dayOfWeek);
  if (open.length === 0) return true;
  return open.some(
    (serving) =>
      timeToMinutes(serving.endTime) - timeToMinutes(serving.startTime) >= minutes,
  );
}
