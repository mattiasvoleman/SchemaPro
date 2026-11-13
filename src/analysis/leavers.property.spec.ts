import { zonedTimeToUtc } from '../common/utils/time';
import { addDays } from '../common/year-rollover';
import type { LoadDuty } from '../staffing/teacher-load';
import { awayAllPeriod, awayAt, coverStands, cutDuties, leaversOf, touches, type Leaver } from './leavers';

/**
 * The löneunderlag's boundaries, held to a count of its own (the review of #308, MEDEL-2).
 *
 * leavers.ts had 100 % line and branch coverage and still let mutants live: `last < fromDay` as `<=` (a leave of exactly one
 * day charged the day), the two edges of a cut uppdrag, which instant a return counts from. Coverage says a line ran, not that
 * its boundary was asked. So the same questions are put here to a model that shares no code with it, day by day and instant by
 * instant, over leaves and returns generated at the school's midnight, at the lessons' limits, over a daylight-saving change,
 * on the same day, and one day apart:
 *
 *   - a day is lost to an uppdrag when the person was away on it: from the school's date they left to the day BEFORE the
 *     school's date they came back (the day they came back is theirs), nothing for a leave and a return on one day;
 *   - the person is away at an instant strictly after they left and strictly before they came back;
 *   - a payroll period is touched when one of its days is a day of a leave, the day of the return included.
 *
 * The model walks every day of the year (and sweeps the periods for an instant) and is written from those three sentences, not
 * from the code. Seeds are fixed, so a failure is the same failure every run and names its seed.
 */

const ZONE = 'Europe/Stockholm';
const YEAR = { start: '2026-08-17', end: '2027-06-11' };

/** A different formatter from the one leaversOf is given (en-CA), so a mistake in one does not hide in both. */
const localDay = (at: Date): string => at.toLocaleDateString('sv-SE', { timeZone: ZONE });
const schoolDay = (at: Date): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);

function* daysBetween(from: string, to: string): Generator<string> {
  for (let day = from; day <= to; day = addDays(day, 1)) yield day;
}
const YEAR_DAYS = [...daysBetween(YEAR.start, YEAR.end)];

/** A small seeded generator (mulberry32): the same numbers for the same seed. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rand = () => number;
const pick = <T>(rand: Rand, items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
const int = (rand: Rand, from: number, to: number): number => from + Math.floor(rand() * (to - from + 1));

interface Period {
  from: Date;
  to: Date | null;
}

/** Times of day worth putting a boundary at: the day's edges, a lesson's start and end and a minute either side, noon, the afternoon. */
const TIMES = ['00:00:00', '08:59:00', '09:00:00', '09:01:00', '12:00:00', '14:30:00', '23:59:59'] as const;

function instantOn(day: string, rand: Rand): Date {
  const time = pick(rand, TIMES);
  const at = zonedTimeToUtc(day, time, ZONE);
  // The edges to the millisecond: the very last one of a day, and the one before the first.
  if (time === '23:59:59' && rand() < 0.5) return new Date(at.getTime() + 999);
  if (time === '00:00:00' && rand() < 0.3) return new Date(at.getTime() - 1);
  if (rand() < 0.15) return new Date(at.getTime() + int(rand, 0, 59) * 60_000);
  return at;
}

/**
 * Up to four leaves, in order and apart, clustered in time (gaps of 0, 1, 2, 5 or 20 days, so that leaves and returns fall on
 * the same day and on days next to each other), some meeting end to start, the last one open about a third of the time.
 */
function periodsOf(rand: Rand): Period[] {
  const count = pick(rand, [0, 1, 1, 2, 2, 3, 4]);
  const periods: Period[] = [];
  let day = YEAR_DAYS[int(rand, 0, 120)]!;
  let cursor = -Infinity;
  for (let i = 0; i < count; i += 1) {
    let from = instantOn(day, rand);
    // Meeting the last one end to start, now and then; otherwise after it.
    if (periods.length > 0 && rand() < 0.2) from = periods[periods.length - 1]!.to!;
    if (from.getTime() < cursor) from = new Date(cursor + 60_000);
    day = addDays(localDay(from), pick(rand, [0, 0, 1, 1, 1, 2, 5, 20]));
    let to = instantOn(day, rand);
    if (to.getTime() <= from.getTime()) to = new Date(from.getTime() + pick(rand, [1, 60_000, 3_600_000, 86_400_000]));
    cursor = to.getTime();
    day = addDays(localDay(to), pick(rand, [0, 1, 1, 2, 7, 30]));
    const last = i === count - 1;
    periods.push({ from, to: last && rand() < 0.35 ? null : to });
    if (last) break;
  }
  return periods;
}

const leaverOf = (periods: readonly Period[]): Leaver =>
  leaversOf(
    periods.map((period) => ({ userId: 'u', startsAt: period.from, endsAt: period.to })),
    schoolDay,
  ).get('u') ?? { userId: 'u', periods: [] };

/** The model of a day: away on it if a leave began on or before it and the person had not come back by the DAY it is. */
function awayOnDay(periods: readonly Period[], day: string): boolean {
  return periods.some((period) => localDay(period.from) <= day && (period.to === null || day < localDay(period.to)));
}

/** The model of an instant: walk the leaves in order; before the first one's start, or at it, they are there; strictly inside one, away. */
function awayAtInstant(periods: readonly Period[], at: Date): boolean {
  const time = at.getTime();
  for (const period of [...periods].sort((a, b) => a.from.getTime() - b.from.getTime())) {
    if (time <= period.from.getTime()) return false;
    if (period.to === null || time < period.to.getTime()) return true;
  }
  return false;
}

/** Days worth drawing a limit from: the days around each leave's and each return's own day, and any day of the year. */
function limitsOf(rand: Rand, periods: readonly Period[]): string[] {
  const near = periods.flatMap((period) => {
    const days = [localDay(period.from), ...(period.to ? [localDay(period.to)] : [])];
    return days.flatMap((day) => [addDays(day, -1), day, addDays(day, 1)]);
  });
  return [...near, ...near, YEAR_DAYS[int(rand, 0, YEAR_DAYS.length - 1)]!];
}

const CASES = 500;

describe('cutDuties against a count of the days', () => {
  it('every day of the year is charged once if it is the uppdrag\'s and the person was not away, and never otherwise, for every seed', () => {
    for (let seed = 1; seed <= CASES; seed += 1) {
      const rand = random(seed);
      const periods = periodsOf(rand);
      const leavers = new Map([['u', leaverOf(periods)]]);
      const limits = limitsOf(rand, periods);
      const duties: LoadDuty[] = Array.from({ length: int(rand, 1, 3) }, (_, index): LoadDuty => {
        let validFrom: string | null | undefined = rand() < 0.3 ? pick(rand, [undefined, null]) : pick(rand, limits);
        let validTo: string | null | undefined = rand() < 0.3 ? pick(rand, [undefined, null]) : pick(rand, limits);
        if (validFrom && validTo && validFrom > validTo) [validFrom, validTo] = [validTo, validFrom];
        return {
          userId: index === 0 && rand() < 0.15 ? 'someone-else' : 'u',
          minutesPerWeek: 10 * (index + 1),
          countsAsTeaching: false,
          ...(validFrom !== undefined ? { validFrom } : {}),
          ...(validTo !== undefined ? { validTo } : {}),
        };
      });

      for (const duty of duties) {
        const pieces = cutDuties([duty], leavers, YEAR.end);
        const first = duty.validFrom ?? YEAR.start;
        const last = duty.validTo ?? YEAR.end;
        for (const day of YEAR_DAYS) {
          const theirs = day >= first && day <= last;
          const expected = theirs && (duty.userId !== 'u' || !awayOnDay(periods, day)) ? 1 : 0;
          const charged = pieces.filter((piece) => day >= (piece.validFrom ?? YEAR.start) && day <= (piece.validTo ?? YEAR.end)).length;
          if (charged !== expected) {
            throw new Error(
              `seed ${seed}, ${day}: charged ${charged} times, expected ${expected}\n  uppdrag ${JSON.stringify(duty)}\n  leaves ${JSON.stringify(periods)}\n  pieces ${JSON.stringify(pieces)}`,
            );
          }
        }
        // What the pieces are: the same uppdrag, minutes and all, for somebody.
        for (const piece of pieces) expect([piece.userId, piece.minutesPerWeek, piece.countsAsTeaching]).toEqual([duty.userId, duty.minutesPerWeek, duty.countsAsTeaching]);
      }
    }
  });
});

describe('awayAt and coverStands against a sweep of the instants', () => {
  it('away strictly after they left and strictly before they came back, for every seed', () => {
    for (let seed = 1; seed <= CASES; seed += 1) {
      const rand = random(seed + 10_000);
      const periods = periodsOf(rand);
      const leaver = leaverOf(periods);
      const leavers = new Map([['u', leaver]]);
      const instants = [
        ...periods.flatMap((period) => [period.from, ...(period.to ? [period.to] : [])]).flatMap((at) => [-60_000, -1, 0, 1, 60_000].map((shift) => new Date(at.getTime() + shift))),
        ...Array.from({ length: 12 }, () => instantOn(YEAR_DAYS[int(rand, 0, YEAR_DAYS.length - 1)]!, rand)),
      ];
      for (const at of instants) {
        const expected = awayAtInstant(periods, at);
        if (awayAt(leaver, at) !== expected) {
          throw new Error(`seed ${seed}, ${at.toISOString()}: awayAt ${!expected}, expected ${expected}\n  leaves ${JSON.stringify(periods)}`);
        }
        // A cover is a lesson over at that instant: it stands exactly when the person was not away.
        expect(coverStands({ userId: 'u', endsAt: at.toISOString() }, leavers)).toBe(!expected);
        // Everybody else's stands.
        expect(coverStands({ userId: 'somebody-else', endsAt: at.toISOString() }, leavers)).toBe(true);
      }
    }
  });
});

describe('touches and awayAllPeriod against the days of the payroll period', () => {
  it('touched when a day of the period is a day of a leave, the day of the return included, for every seed', () => {
    for (let seed = 1; seed <= CASES; seed += 1) {
      const rand = random(seed + 20_000);
      const periods = periodsOf(rand);
      const leaver = leaverOf(periods);
      const limits = limitsOf(rand, periods);
      for (let round = 0; round < 8; round += 1) {
        let from = pick(rand, limits);
        let to = rand() < 0.3 ? from : pick(rand, limits);
        if (from > to) [from, to] = [to, from];
        const expected = [...daysBetween(from, to)].some((day) =>
          periods.some((period) => localDay(period.from) <= day && (period.to === null || day <= localDay(period.to))),
        );
        if (touches(leaver, from, to) !== expected) {
          throw new Error(`seed ${seed}, ${from}..${to}: touches ${!expected}, expected ${expected}\n  leaves ${JSON.stringify(periods)}`);
        }
        // When it says the whole period is inside one leave, no instant of the period is a moment the person was there: every
        // lesson that ends in it is dropped, and nothing need be asked.
        if (awayAllPeriod(leaver, from, to)) {
          const edges = [zonedTimeToUtc(from, '00:00:00', ZONE), zonedTimeToUtc(from, '12:00:00', ZONE), new Date(zonedTimeToUtc(to, '23:59:59', ZONE).getTime() + 999), zonedTimeToUtc(to, '09:00:00', ZONE)];
          for (const at of edges) {
            if (!awayAtInstant(periods, at)) throw new Error(`seed ${seed}, ${from}..${to}: awayAllPeriod, but they were there at ${at.toISOString()}\n  leaves ${JSON.stringify(periods)}`);
          }
          expect(expected).toBe(true);
        }
      }
    }
  });
});

describe('the model itself (this is not a vacuous test)', () => {
  it('finds a leave of exactly one day, one that meets the next, and a leave and a return on one day, among the seeds', () => {
    let oneDay = 0;
    let meeting = 0;
    let sameDay = 0;
    let open = 0;
    let dst = 0;
    for (let seed = 1; seed <= CASES; seed += 1) {
      const periods = periodsOf(random(seed));
      for (const [index, period] of periods.entries()) {
        if (period.to === null) open += 1;
        else {
          const lasted = addDays(localDay(period.from), 1) === localDay(period.to);
          if (lasted) oneDay += 1;
          if (localDay(period.from) === localDay(period.to)) sameDay += 1;
          if (localDay(period.from) <= '2026-10-25' && localDay(period.to) >= '2026-10-25') dst += 1;
          const next = periods[index + 1];
          if (next && next.from.getTime() === period.to.getTime()) meeting += 1;
        }
      }
    }
    expect({ oneDay, sameDay, meeting, open, dst }).toEqual({
      oneDay: expect.any(Number),
      sameDay: expect.any(Number),
      meeting: expect.any(Number),
      open: expect.any(Number),
      dst: expect.any(Number),
    });
    for (const found of [oneDay, sameDay, meeting, open, dst]) expect(found).toBeGreaterThan(20);
  });
});
