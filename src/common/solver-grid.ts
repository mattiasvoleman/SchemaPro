import { BadRequestException } from '@nestjs/common';

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
 *
 * A THIRD COPY LIVES IN THE DATABASE. app.lesson_lengths_are_canonical
 * (migration 20261008090000), the CHECK on TeachingRequirements.lessonLengths,
 * hardcodes `x % 5 = 0` and 15..240, because a PostgREST writer reaches the
 * column without meeting this file. Moving the grid moves all three: the
 * engine's setting, SLOT_MINUTES here (and LESSON_GRID_MINUTES in
 * lesson-lengths.ts on both sides, which the shared fixture pins), and that
 * function, in a migration.
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
 * The seconds `minutesOf` is blind to, refused before it is asked anything.
 *
 * Every clock DTO in this app admits HH:MM:SS — `/^\d{2}:\d{2}(:\d{2})?$/` —
 * on purpose: that is the shape PostgREST returns, so a row read out of the
 * database round-trips through its own endpoint. `parseTimeString` then carries
 * those seconds into the TIME(0) column. `minutesOf` does not see them: it
 * splits on ':' and reads two fields. So every window measured with it is
 * measured to the minute while the value stored is exact to the second, and the
 * two disagree by up to 59 seconds per edge.
 *
 * ON TWO TABLES THAT DISAGREEMENT REACHES A CHECK. LunchSettings_window_fits_break
 * and TeacherWorkRules_lunch_window_fits_break measure the same window with
 * EXTRACT(EPOCH …), so `11:00:30`-`11:30` is thirty whole minutes here and 1770
 * seconds against a required 1800 there. A CHECK violation is none of the codes
 * `rethrowPrismaError` maps, so that one came back as a bare 500 where every
 * other refusal on those routes is a 400 naming the field. Everywhere else the
 * table carries only `"endTime" > "startTime"`, which can never refuse what a
 * whole-minute compare accepted — if minutesOf(end) > minutesOf(start) then the
 * end's HH:MM is strictly greater, and seconds under sixty cannot bridge a whole
 * minute. There the cost is smaller and quieter: a boundary stored off the
 * solver's own grid, read back on every run.
 *
 * REFUSED RATHER THAN COUNTED, on both, because a schedule laid in five-minute
 * slots has nothing to do with a second — making the arithmetic seconds-aware
 * would teach the app to measure a precision it can never place. Zero seconds
 * stay acceptable, because `:00` is what PostgREST writes out and the web sends
 * back, and these endpoints answer in HH:MM, so it is the only seconds a client
 * has any way to produce.
 *
 * THE SENTENCE IS NOT DECIDED HERE, only the question. These routes do not
 * speak one language: the lunch settings and the teacher work rules answer in
 * Swedish because an admin reads them in a form, and the frame times, sittings,
 * rasts, meals and constraints answer in English naming the wire field, as
 * every other refusal on those five does. A single shared message would have
 * put two languages on one route's error surface. So the detector is shared and
 * the wording belongs to the caller; `assertWholeMinutes` below is the wording
 * those five happen to agree on.
 */
export function carriesSeconds(time: string): boolean {
  const [, , seconds = '0'] = time.split(':');
  return Number(seconds) !== 0;
}

/**
 * `carriesSeconds` with the sentence the five English routes share — the frame
 * times, lunch servings, rasts, lunch sittings and availability constraints,
 * whose every other refusal is an English clause naming the DTO field. The two
 * Swedish routes throw their own.
 *
 * @param field the wire field, named as the rest of that route's messages name it.
 */
export function assertWholeMinutes(field: string, time: string): void {
  if (carriesSeconds(time)) {
    throw new BadRequestException(
      `${field} must be whole minutes; seconds cannot be placed on the solver's ${SLOT_MINUTES}-minute grid.`,
    );
  }
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
