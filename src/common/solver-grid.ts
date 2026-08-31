/**
 * The solver's time grid, as the API understands it.
 *
 * These three numbers are the optimization engine's `SLOT_MINUTES`,
 * `SCHEDULE_DAY_START_MINUTES` and `SCHEDULE_DAY_END_MINUTES`, which are
 * settings there and constants here. That is a duplication, and it is the kind
 * that bites quietly: nothing makes the two agree, and when they drift the
 * symptom appears in the solver, one service away from the value that caused
 * it.
 *
 * It has already bitten once. `minutesPerLesson` was validated as an integer
 * between 15 and 240 and never checked against the grid, so a timplan could
 * hold a 40-minute lesson — an ordinary length in a Swedish school — that the
 * engine could not express. The app accepted it, and the failure surfaced only
 * when somebody pressed "generera", as an unhandled ValueError and a 500. The
 * lunch settings were checked against the grid all along; teaching
 * requirements never were.
 *
 * Kept as constants rather than read from the engine at runtime because the API
 * must be able to refuse a bad value while typing it, without a round trip to a
 * service that may be down — which is precisely the situation the check exists
 * to keep out of. If the grid ever becomes a per-school setting, this is the
 * one place that has to learn about it.
 */

/**
 * Five minutes, matching the engine's default.
 *
 * Fifteen cannot express a 40- or 50-minute lesson. Five divides 60 (which the
 * engine requires of this value) and admits every length a school actually
 * uses. Measured before the change, at 400 students on a 90-second budget: both
 * grids placed the same 576 lessons and produced a valid timetable.
 */
export const SLOT_MINUTES = 5;

export const DAY_START_MINUTES = 8 * 60;
export const DAY_END_MINUTES = 18 * 60;

/** "08:00" or "08:00:00" as minutes past midnight. */
export function minutesOf(time: string): number {
  const [hours = '0', minutes = '0'] = time.split(':');
  return Number(hours) * 60 + Number(minutes);
}

/**
 * Whether a lesson length can be laid on the grid at all.
 *
 * The engine turns minutes into whole slots and refuses a remainder, so this is
 * the same question its `TimeGrid.minutes_to_slots` asks — asked early enough
 * that the answer can name the field the administrator is looking at.
 */
export function fitsTheGrid(minutes: number): boolean {
  return Number.isInteger(minutes) && minutes > 0 && minutes % SLOT_MINUTES === 0;
}
