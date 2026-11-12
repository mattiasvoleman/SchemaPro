/**
 * Terminer: the periods a läsår is cut into for the engine.
 *
 * The engine has no dates. It plans one week for everything that runs every
 * week, and it is told which entries do not: a timplanspost that runs until
 * December and one that runs from January never share a week, so they may
 * share an hour, a teacher, a room and the pupils. Only the gateway has the
 * dates, so the gateway reads them here and sends what they amount to — for
 * each entry of the payload, the PERIODS of the year it runs in
 * (AnonymousRequirement.periods, AnonymousFixedLesson.periods).
 *
 * A PERIOD IS A SET OF REAL ISO WEEKS IN WHICH THE SAME ENTRIES RUN. Every
 * week of the läsår is read once: which of the entries have a date in it. Weeks
 * with the same entries are one period, whether or not they lie beside each
 * other, and an entry's mask says which periods hold it. Nothing is rounded
 * and nothing is joined: a läsår has at most 53 weeks, so it has at most 53
 * periods, and the engine keeps every one apart where a rule needs it
 * (optimization-engine/app/solver/weeks.py has which rows may join weeks and
 * which may not — that choice needs the real weeks, which is why it is made
 * there and not here).
 *
 * THE PARITY IS NOT READ HERE. It stays where it was, `recurrence`, and the
 * engine's weeks are each period in each parity. Two entries then meet in the
 * engine exactly when their windows touch a common ISO week AND their parities
 * are not opposed — weeksCanOverlap (src/calendar/lesson-recurrence.ts) with
 * each window widened to whole weeks. That is never looser than weeksCanOverlap
 * itself, which is what the grid flags a clash by, and never looser than "some
 * real week holds both" (runsOn), which is what the week rules — a teacher's
 * days, the rest between two days — are counted by. It is stricter than the
 * first only for two windows that share a week without sharing a date: a post
 * that ends on a Tuesday and one that starts on the Wednesday. That week has
 * both, and the night between them is one night.
 *
 * A WEEK IS MONDAY TO SUNDAY, and the läsår's weeks run from the week of its
 * first day to the week of its last. A null date is the läsår's own bound, as
 * everywhere (runsOn). An entry whose window touches no week of the läsår is
 * read as running in all of them — what the engine held for every dated entry
 * before it knew periods, and the stricter reading.
 */
import type { YearSpan } from '../common/teacher-day';

const DAY_MS = 86_400_000;

/** The most periods a payload may carry: the engine's MAX_PERIODS, a läsår's weeks. */
export const MAX_PERIODS = 53;

/** When an entry is held: a window of days, 'YYYY-MM-DD', null for the läsår's own bound. */
export interface HeldWindow {
  startDate: string | null;
  endDate: string | null;
}

/** A run of whole weeks of one period, as days of the läsår: for a sentence that names it. */
export interface PeriodStretch {
  from: string;
  to: string;
}

export interface YearPeriods {
  /** How many real weeks each period is: the payload's `periodWeeks`. */
  weeks: number[];
  /** Each period's weeks as stretches of days, in order, clipped to the läsår. */
  stretches: PeriodStretch[][];
  /**
   * The period of each week of the läsår, from the week of its first day:
   * for what is read week by week and sent period by period (a teacher's
   * kept weekdays, src/common/teacher-day.ts).
   */
  weekPeriods: number[];
  /**
   * Each entry's mask, by its position in what was read; undefined for an
   * entry that runs in every period, which is sent without the key.
   */
  masks: (boolean[] | undefined)[];
}

const parseDay = (value: string): Date => new Date(`${value}T00:00:00.000Z`);
const dayOf = (date: Date): string => date.toISOString().slice(0, 10);
const addDays = (date: Date, days: number): Date => new Date(date.getTime() + days * DAY_MS);
const mondayOf = (date: Date): Date => addDays(date, 1 - (date.getUTCDay() || 7));

/** The läsår's weeks, each as its Monday and its Sunday. */
function weeksOfYear(year: YearSpan): { monday: string; sunday: string }[] {
  const weeks: { monday: string; sunday: string }[] = [];
  const last = parseDay(year.endDate).getTime();
  for (let monday = mondayOf(parseDay(year.startDate)); monday.getTime() <= last; monday = addDays(monday, 7)) {
    weeks.push({ monday: dayOf(monday), sunday: dayOf(addDays(monday, 6)) });
  }
  return weeks;
}

/** Whether some window has a day in the week: ISO days compare as text. */
const touches = (windows: readonly HeldWindow[], week: { monday: string; sunday: string }): boolean =>
  windows.some(
    (window) =>
      (window.startDate === null || window.startDate <= week.sunday) &&
      (window.endDate === null || window.endDate >= week.monday),
  );

/**
 * The läsår cut into periods by the entries' windows, and each entry's mask.
 *
 * `entries` are the windows each entry of the payload is held in — one for a
 * post or a lock, several for a post that holds other posts' weeks too (a
 * leader post of two blocks on the same times: same-times.ts).
 *
 * Null when the entries do not tell two weeks apart, which is every school
 * until one dates a post: nothing is then sent, and the payload is the one it
 * was. Null as well for a läsår that would need more periods than the engine
 * reads (MAX_PERIODS) — no real läsår does, and such a year is sent as it
 * always was, every entry every week.
 */
export function yearPeriodsOf(year: YearSpan, entries: readonly (readonly HeldWindow[])[]): YearPeriods | null {
  const weeks = weeksOfYear(year);
  const runs = entries.map((windows) => weeks.map((week) => touches(windows, week)));
  // An entry in every week, or in none of them, tells no two weeks apart.
  const dated = runs.map((inWeek) => inWeek.some(Boolean) && !inWeek.every(Boolean));
  if (!dated.some(Boolean)) return null;

  const periodOf = new Map<string, number>();
  const firstWeek: number[] = [];
  const weeksIn: number[][] = [];
  const weekPeriods: number[] = [];
  weeks.forEach((_, week) => {
    const signature = runs.map((inWeek, entry) => (dated[entry] && inWeek[week] ? '1' : '0')).join('');
    let period = periodOf.get(signature);
    if (period === undefined) {
      period = firstWeek.length;
      periodOf.set(signature, period);
      firstWeek.push(week);
      weeksIn.push([]);
    }
    weeksIn[period]!.push(week);
    weekPeriods.push(period);
  });
  // At least two by now: a dated entry runs in some week and not in another.
  if (firstWeek.length > MAX_PERIODS) return null;

  const clip = (day: string, low: string, high: string): string => (day < low ? low : day > high ? high : day);
  return {
    weeks: weeksIn.map((held) => held.length),
    stretches: weeksIn.map((held) => {
      const stretches: PeriodStretch[] = [];
      let from = held[0]!;
      held.forEach((week, index) => {
        if (held[index + 1] === week + 1) return;
        stretches.push({
          from: clip(weeks[from]!.monday, year.startDate, year.endDate),
          to: clip(weeks[week]!.sunday, year.startDate, year.endDate),
        });
        from = held[index + 1] ?? week;
      });
      return stretches;
    }),
    weekPeriods,
    // The same in every week of a period, by what a period is: read in its first.
    masks: runs.map((inWeek, entry) => (dated[entry] ? firstWeek.map((week) => inWeek[week]!) : undefined)),
  };
}

/**
 * A refusal's params with its period turned into dates.
 *
 * The engine names a period by its index (`period`, counted from 0), which is
 * all it has. The stretch of days is added beside it — `periodFrom` and
 * `periodTo`, the first stretch of the weeks, and `periodStretches`, how many
 * stretches they are — for the sentence that says where in the year the count
 * was made. Params without a period, or naming one the read does not have, are
 * returned as they came.
 *
 * WEEKS OF SEVERAL PERIODS. A count the engine made in weeks that lie in more
 * than one period — the odd weeks of the autumn and of the spring, where only
 * the even weeks have posts of their own — says all of them, `periods`, their
 * indices with commas between ("0,1"), beside the first (`period`). Their
 * stretches are then read together: in the order of the year, and two that
 * meet (the autumn ends on the Sunday the spring starts after) are one
 * stretch, so the sentence names the whole run of weeks and not the half of
 * it the first index stands for. A `periods` that cannot be read is left
 * alone and the first period's stretches stand, as before.
 */
export function withPeriodDates<P extends Record<string, string | number>>(
  params: P,
  stretches: readonly (readonly PeriodStretch[])[] | undefined,
): P | (P & { periodFrom: string; periodTo: string; periodStretches: number }) {
  const period = params.period;
  if (typeof period !== 'number' || !stretches) return params;
  const own = stretches[period];
  if (!own || own.length === 0) return params;
  const listed =
    typeof params.periods === 'string' && /^\d+(,\d+)*$/.test(params.periods)
      ? params.periods.split(',').map(Number)
      : [period];
  const readable = listed.includes(period) && listed.every((index) => (stretches[index]?.length ?? 0) > 0);
  const joined = joinedStretches((readable ? listed : [period]).flatMap((index) => stretches[index]!));
  return { ...params, periodFrom: joined[0]!.from, periodTo: joined[0]!.to, periodStretches: joined.length };
}

/**
 * The English for where a refusal was counted, for a reader with no catalogue:
 * appended to the engine's own.
 *
 * The web's sentence, word for word (generate.countedInPeriod in
 * web/messages/en.json; catalogue-sentences.spec.ts holds the two together),
 * with the days as the API writes them: the stretch, that the period has other
 * weeks too, and — for a count made in the odd or the even weeks only, which
 * the engine says as `parity` — which of them.
 */
export function periodSentence(params: Record<string, string | number>): string {
  if (typeof params.periodFrom !== 'string' || typeof params.periodTo !== 'string') return '';
  const more = typeof params.periodStretches === 'number' && params.periodStretches > 1;
  const parity =
    params.parity === 'ODD_WEEKS' ? ' (odd weeks)' : params.parity === 'EVEN_WEEKS' ? ' (even weeks)' : '';
  return (
    ` Counted for the weeks from ${params.periodFrom} to ${params.periodTo}` +
    `${more ? ' and the other weeks with the same entries' : ''}${parity}, which is when these run together.`
  );
}

/**
 * KLASSENS LUNCH: a refusal's params with the parts of the year its locks run
 * in turned into dates.
 *
 * A class's meal is one hour all year, so locked lessons of two terms that
 * close its lunch window between them refuse the year though each term has a
 * gap. The engine says which periods' locks they are — `lockPeriods`, and
 * only when no one period's locks close the window alone
 * (scheduler_solver._lunch_lock_periods). The periods come in PARTS: those
 * whose locks take the same starts of the window have commas between them,
 * and the parts semicolons ("0,1,2,3;4,5"), because a läsår has more periods
 * than terms and the autumn's lock is in several of them. The first two
 * parts are two that close the window between them, where two do.
 *
 * Here the first stretch of weeks of each of those two parts is added, flat
 * like every value a sentence carries: `lockFrom` and `lockTo`,
 * `otherLockFrom` and `otherLockTo`, the earlier of the two first. A part's
 * periods are read together — their stretches in the order of the year, and
 * two that meet are one — so the autumn is one run of weeks however many
 * periods the school's other posts cut it into. `lockWeeksElsewhere` counts
 * the stretches not written out: a part that comes back later in the year, or
 * a third part.
 *
 * Params without the key, with fewer than two parts, or naming a period the
 * read does not have, are returned as they came: the refusal then says what
 * it always said.
 */
export function withLockPeriodDates<P extends Record<string, string | number>>(
  params: P,
  stretches: readonly (readonly PeriodStretch[])[] | undefined,
):
  | P
  | (P & { lockFrom: string; lockTo: string; otherLockFrom: string; otherLockTo: string; lockWeeksElsewhere: number }) {
  const listed = params.lockPeriods;
  if (typeof listed !== 'string' || !/^\d+(,\d+)*(;\d+(,\d+)*)+$/.test(listed) || !stretches) return params;
  const parts = listed.split(';').map((part) => [...new Set(part.split(',').map(Number))]);
  if (parts.flat().some((index) => (stretches[index]?.length ?? 0) === 0)) return params;
  const runs = parts.map((part) => joinedStretches(part.flatMap((index) => stretches[index]!)));
  const [first, second] = [runs[0]![0]!, runs[1]![0]!].sort(byFrom);
  return {
    ...params,
    lockFrom: first!.from,
    lockTo: first!.to,
    otherLockFrom: second!.from,
    otherLockTo: second!.to,
    lockWeeksElsewhere: runs.reduce((count, run) => count + run.length, 0) - 2,
  };
}

const byFrom = (a: PeriodStretch, b: PeriodStretch): number => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0);

/** Stretches in the order of the year, two that meet (one ends the day before the next starts) made one. */
function joinedStretches(stretches: readonly PeriodStretch[]): PeriodStretch[] {
  const joined: PeriodStretch[] = [];
  for (const stretch of [...stretches].sort(byFrom)) {
    const last = joined[joined.length - 1];
    if (last !== undefined && dayOf(addDays(parseDay(last.to), 1)) === stretch.from) {
      joined[joined.length - 1] = { from: last.from, to: stretch.to };
    } else {
      joined.push({ from: stretch.from, to: stretch.to });
    }
  }
  return joined;
}

/**
 * The English for it, for a reader with no catalogue: appended to the
 * engine's own sentence. The web's, word for word (generate.lunchLocksInPeriods
 * in web/messages/en.json; catalogue-sentences.spec.ts holds the two
 * together), with the days as the API writes them. Nothing for params
 * without the dates.
 */
export function lunchLocksSentence(params: Record<string, string | number>): string {
  const { lockFrom, lockTo, otherLockFrom, otherLockTo } = params;
  if (
    typeof lockFrom !== 'string' ||
    typeof lockTo !== 'string' ||
    typeof otherLockFrom !== 'string' ||
    typeof otherLockTo !== 'string'
  ) {
    return '';
  }
  const more = typeof params.lockWeeksElsewhere === 'number' && params.lockWeeksElsewhere > 0;
  return (
    ` The locked lessons that close the lunch window between them run in different parts of the school year:` +
    ` the weeks from ${lockFrom} to ${lockTo} and the weeks from ${otherLockFrom} to ${otherLockTo}` +
    `${more ? ', among others' : ''}.` +
    ` A class's lunch is one time all year, so it has to keep clear of locked lessons in every part of the year.`
  );
}
