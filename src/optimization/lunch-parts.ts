import type { AiEngineLunch } from './interfaces/ai-engine-payload.interface';
import type { PeriodStretch } from './year-periods';

/**
 * Klassens måltid per del av läsåret (20270209090000): the engine's answer as
 * the rows of LunchSittings.
 *
 * The engine plans a class's meal per PERIOD of the läsår (year-periods.ts) and
 * says which periods each meal is for, as a mask. A row of the table has the
 * weeks it holds instead — `startDate` a Monday and `endDate` a Sunday, either
 * NULL for the läsår's own bound — so a mask is written as the stretches of
 * its periods, adjacent ones joined into one row. This module is that
 * translation and nothing else: it reads no table, and every reader of the
 * rows (src/common/lunch-window.ts) is unchanged by it.
 */

/** The weeks one row of the table holds: ISO days, null for the läsår's own bound. */
export interface MealWindow {
  startDate: string | null;
  endDate: string | null;
}

/** A meal of the answer and the weeks it is written for. */
export interface DatedMeal<M extends AiEngineLunch = AiEngineLunch> {
  lunch: M;
  startDate: string | null;
  endDate: string | null;
}

/** The answer's meals cannot be written as the rows of a table: said loudly, never papered over. */
export class MealPartsError extends Error {}

const DAY_MS = 86_400_000;
const dayAfter = (day: string): string => new Date(Date.parse(`${day}T00:00:00.000Z`) + DAY_MS).toISOString().slice(0, 10);

/**
 * The weeks a mask names, as the windows of rows: one for each run of
 * neighbouring weeks, a bound that is the läsår's own written as null.
 *
 * `stretches` are the periods' weeks clipped to the läsår (YearPeriods.
 * stretches), so the earliest `from` and the latest `to` of them all are the
 * läsår's bounds. A window that reaches one is open there: a row dated to the
 * day a läsår starts would stop covering it the day the läsår is edited to
 * start sooner, and a Saturday is no Monday (the table's CHECK).
 */
export function windowsOfMask(
  mask: readonly boolean[],
  stretches: readonly (readonly PeriodStretch[])[],
): MealWindow[] {
  if (mask.length !== stretches.length) {
    throw new MealPartsError(`a meal for ${mask.length} periods in a year of ${stretches.length}`);
  }
  const every = stretches.flat();
  if (every.length === 0) throw new MealPartsError('a year without weeks');
  const first = every.reduce((low, stretch) => (stretch.from < low ? stretch.from : low), every[0]!.from);
  const last = every.reduce((high, stretch) => (stretch.to > high ? stretch.to : high), every[0]!.to);
  const held = stretches
    .flatMap((inPeriod, period) => (mask[period] ? inPeriod : []))
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  const runs: PeriodStretch[] = [];
  for (const stretch of held) {
    const previous = runs[runs.length - 1];
    if (previous !== undefined && stretch.from <= dayAfter(previous.to)) {
      runs[runs.length - 1] = { from: previous.from, to: stretch.to > previous.to ? stretch.to : previous.to };
    } else {
      runs.push({ ...stretch });
    }
  }
  return runs.map((run) => ({
    startDate: run.from === first ? null : run.from,
    endDate: run.to === last ? null : run.to,
  }));
}

/**
 * The answer's meals with the weeks each is written for.
 *
 * A meal without a mask is the whole läsår, as every meal was. Meals with a
 * mask are one class's several of one day, and are checked to be what the
 * engine says they are: on every meal of that class and day, the masks
 * disjoint and together every period. An answer that is not (an engine and a
 * gateway that disagree about the periods, a mask on a lone meal) would be
 * written as a gap or an overlap in a child's day, and is refused whole.
 */
export function datedMeals<M extends AiEngineLunch>(
  lunches: readonly M[],
  stretches: readonly (readonly PeriodStretch[])[] | null | undefined,
): DatedMeal<M>[] {
  const byDay = new Map<string, M[]>();
  for (const lunch of lunches) {
    const key = `${lunch.studentGroupId}:${lunch.dayOfWeek}`;
    byDay.set(key, [...(byDay.get(key) ?? []), lunch]);
  }
  for (const [key, meals] of byDay) {
    const masked = meals.filter((meal) => meal.periods !== undefined);
    if (masked.length === 0) {
      if (meals.length > 1) throw new MealPartsError(`${meals.length} meals of ${key} and no periods to tell them apart`);
      continue;
    }
    if (stretches == null) throw new MealPartsError(`a meal of ${key} for some periods in a year without any`);
    if (masked.length !== meals.length) throw new MealPartsError(`a meal of ${key} without periods beside one with`);
    const count = stretches.length;
    for (let period = 0; period < count; period += 1) {
      const holding = meals.filter((meal) => meal.periods![period] === true).length;
      if (holding !== 1) throw new MealPartsError(`${holding} meals of ${key} in period ${period}`);
    }
  }
  return lunches.flatMap((lunch): DatedMeal<M>[] =>
    lunch.periods === undefined
      ? [{ lunch, startDate: null, endDate: null }]
      : windowsOfMask(lunch.periods, stretches!).map((window) => ({ lunch, ...window })),
  );
}
