import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LessonRecurrence } from '@prisma/client';
import { runsOn, weeksCanOverlap } from '../calendar/lesson-recurrence';
import {
  MAX_PERIODS,
  periodSentence,
  lunchLocksSentence,
  weekPeriodsOfUndatedYear,
  withLockPeriodDates,
  withPeriodDates,
  yearPeriodsOf,
  type HeldWindow,
} from './year-periods';

const DAY_MS = 86_400_000;
const day = (value: string): Date => new Date(`${value}T00:00:00.000Z`);
const iso = (date: Date): string => date.toISOString().slice(0, 10);
const addDays = (value: string, days: number): string => iso(new Date(day(value).getTime() + days * DAY_MS));
const mondayOf = (value: string): string => addDays(value, 1 - (day(value).getUTCDay() || 7));

/** A small seeded generator: the same weeks on every run. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const YEAR = { startDate: '2026-08-17', endDate: '2027-06-11' };
const ALL_YEAR: HeldWindow = { startDate: null, endDate: null };

/** What the engine does with a mask and a parity: weeks.meet, written out. */
function meetInEngine(
  first: { mask: boolean[] | undefined; recurrence: LessonRecurrence },
  second: { mask: boolean[] | undefined; recurrence: LessonRecurrence },
): boolean {
  const opposed =
    first.recurrence !== 'ALL_WEEKS' && second.recurrence !== 'ALL_WEEKS' && first.recurrence !== second.recurrence;
  if (opposed) return false;
  if (!first.mask || !second.mask) return true;
  return first.mask.some((runs, period) => runs && second.mask![period]);
}

describe('MAX_PERIODS', () => {
  it('is the engine’s own bound, a läsår’s 53 weeks, and not a number of this file’s', () => {
    // The engine refuses a mask longer than its MAX_PERIODS (422), and the
    // gateway sends none past its own: the two are one number in two
    // languages, read here from the engine's schema itself.
    const schema = readFileSync(
      join(__dirname, '..', '..', 'optimization-engine/app/schemas/schedule.py'),
      'utf8',
    );
    const engine = /^MAX_PERIODS = (\d+)$/m.exec(schema);
    expect(engine).not.toBeNull();
    expect(MAX_PERIODS).toBe(Number(engine![1]));
    expect(MAX_PERIODS).toBe(53);
  });
});

describe('weekPeriodsOfUndatedYear', () => {
  it('is every week of the läsår in the one period, as many as yearPeriodsOf counts weeks', () => {
    // The review of #320, MEDEL-1: what a teacher's kept weekdays are read by in a year nothing dates.
    const one = weekPeriodsOfUndatedYear(YEAR);
    expect(one).toHaveLength(43);
    expect(new Set(one)).toEqual(new Set([0]));
    const dated = yearPeriodsOf(YEAR, [[{ startDate: null, endDate: '2026-12-18' }]])!;
    expect(dated.weekPeriods).toHaveLength(one.length);
    // A läsår that starts on a Saturday has its first, incomplete week as a week.
    expect(weekPeriodsOfUndatedYear({ startDate: '2026-08-15', endDate: '2027-06-12' })).toHaveLength(44);
  });
});

describe('yearPeriodsOf', () => {
  it('sends nothing for a school that dates no post', () => {
    expect(yearPeriodsOf(YEAR, [])).toBeNull();
    expect(yearPeriodsOf(YEAR, [[ALL_YEAR], [ALL_YEAR]])).toBeNull();
    // A window that holds the whole läsår is every week too, whatever its dates say.
    expect(yearPeriodsOf(YEAR, [[{ startDate: '2026-01-01', endDate: '2027-12-31' }]])).toBeNull();
    expect(yearPeriodsOf(YEAR, [[{ startDate: YEAR.startDate, endDate: YEAR.endDate }], [ALL_YEAR]])).toBeNull();
  });

  it('cuts the year the school this was built for has', () => {
    // Year 9: five groups 18 August to 21 December, five from 11 January to 7 June.
    // Year 7: the first halves until 17 January, the second from 18 January.
    const nineAutumn = [{ startDate: '2026-08-18', endDate: '2026-12-21' }];
    const nineSpring = [{ startDate: '2027-01-11', endDate: '2027-06-07' }];
    const sevenFirst = [{ startDate: null, endDate: '2027-01-17' }];
    const sevenSecond = [{ startDate: '2027-01-18', endDate: null }];
    const periods = yearPeriodsOf(YEAR, [nineAutumn, nineSpring, sevenFirst, sevenSecond, [ALL_YEAR]]);
    expect(periods).not.toBeNull();
    // The autumn, the weeks between the terms, the week both terms have, the spring.
    expect(periods!.weeks).toEqual([19, 2, 1, 21]);
    expect(periods!.stretches).toEqual([
      [{ from: '2026-08-17', to: '2026-12-27' }],
      [{ from: '2026-12-28', to: '2027-01-10' }],
      [{ from: '2027-01-11', to: '2027-01-17' }],
      // The last week runs to Sunday 13 June; the läsår ends on the 11th.
      [{ from: '2027-01-18', to: '2027-06-11' }],
    ]);
    expect(periods!.masks).toEqual([
      [true, false, false, false],
      [false, false, true, true],
      // The week of 11-17 January has year 9's spring groups AND year 7's autumn halves.
      [true, true, true, false],
      [false, false, false, true],
      undefined,
    ]);
  });

  describe('how many of each period’s weeks are odd (periodOddWeeks)', () => {
    // Review of #304, MEDEL-2. The engine's week is a period in a parity, so a period that has
    // weeks of one parity alone has a cell of the other that no calendar has.
    it('counts the odd ISO weeks of each period, the Saturday-start week and week 53 and week 1 included', () => {
      // The school this was built for: the autumn (weeks 34 to 52: nine odd), the two weeks between the terms
      // (weeks 53 and 1, both odd), the week the terms share (week 2, even) and the spring (weeks 3 to 23: eleven odd).
      const periods = yearPeriodsOf(YEAR, [
        [{ startDate: '2026-08-18', endDate: '2026-12-21' }],
        [{ startDate: '2027-01-11', endDate: '2027-06-07' }],
        [{ startDate: null, endDate: '2027-01-17' }],
        [{ startDate: '2027-01-18', endDate: null }],
        [ALL_YEAR],
      ]);
      expect(periods!.weeks).toEqual([19, 2, 1, 21]);
      expect(periods!.oddWeeks).toEqual([9, 2, 0, 11]);
    });

    it('reads the two first days of a läsår that starts on a Saturday as week 33, an odd week', () => {
      // A post from the first Monday leaves the Saturday and the Sunday before it as a period of their own.
      const periods = yearPeriodsOf({ startDate: '2026-08-15', endDate: '2027-06-12' }, [
        [{ startDate: '2026-08-17', endDate: null }],
      ]);
      expect(periods!.weeks).toEqual([1, 43]);
      expect(periods!.oddWeeks).toEqual([1, 22]);
    });

    it('is counted where every period has both parities too: a period of three weeks has two of one and one of the other', () => {
      // A post until 18 December: weeks 34 to 51 (nine odd), and weeks 52, 53 and 1 to 23 (thirteen odd: 53, 1, 3 … 23).
      const periods = yearPeriodsOf(YEAR, [[{ startDate: null, endDate: '2026-12-18' }]]);
      expect(periods!.weeks).toEqual([18, 25]);
      expect(periods!.oddWeeks).toEqual([9, 13]);
    });

    it('says the one parity of a period that has one alone, whatever the others have', () => {
      // One week (week 18, 3 to 9 May 2027: even) between two stretches of the same post: weeks 17 and 19 to 23
      // hold it, six weeks of which four are odd (17, 19, 21 and 23), and the one week of the other period is even.
      const periods = yearPeriodsOf({ startDate: '2027-04-26', endDate: '2027-06-11' }, [
        [{ startDate: null, endDate: '2027-04-30' }, { startDate: '2027-05-10', endDate: null }],
      ]);
      expect(periods!.weeks).toEqual([6, 1]);
      expect(periods!.oddWeeks).toEqual([4, 0]);
    });
  });

  it('reads a week Monday to Sunday: a post until Tuesday and one from Wednesday share theirs', () => {
    // 2026-10-13 is a Tuesday. weeksCanOverlap says these never meet; that week has both.
    const until = [{ startDate: null, endDate: '2026-10-13' }];
    const from = [{ startDate: '2026-10-14', endDate: null }];
    const periods = yearPeriodsOf(YEAR, [until, from])!;
    expect(periods.masks).toEqual([
      [true, true, false],
      [false, true, true],
    ]);
    expect(periods.stretches[1]).toEqual([{ from: '2026-10-12', to: '2026-10-18' }]);
    // Sunday to Monday is two weeks, and nothing is shared.
    const untilSunday = [{ startDate: null, endDate: '2026-10-18' }];
    const fromMonday = [{ startDate: '2026-10-19', endDate: null }];
    expect(yearPeriodsOf(YEAR, [untilSunday, fromMonday])!.masks).toEqual([
      [true, false],
      [false, true],
    ]);
  });

  it('joins weeks with the same entries wherever they lie', () => {
    // One course in October only: the weeks before it and the weeks after hold the same entries.
    const october = [{ startDate: '2026-10-05', endDate: '2026-10-25' }];
    const periods = yearPeriodsOf(YEAR, [october, [ALL_YEAR]])!;
    expect(periods.weeks).toEqual([40, 3]);
    expect(periods.masks).toEqual([[false, true], undefined]);
    expect(periods.stretches[0]).toEqual([
      { from: '2026-08-17', to: '2026-10-04' },
      { from: '2026-10-26', to: '2027-06-11' },
    ]);
  });

  it('holds a leader post in its own weeks and in those of the posts it holds', () => {
    const autumn = { startDate: null, endDate: '2026-12-18' };
    const spring = { startDate: '2027-01-11', endDate: null };
    const periods = yearPeriodsOf(YEAR, [[autumn, spring], [autumn], [spring]])!;
    // The weeks between the terms are neither's: the leader is not held there.
    expect(periods.masks).toEqual([
      [true, false, true],
      [true, false, false],
      [false, false, true],
    ]);
  });

  it('reads an entry outside the läsår, or with its dates the wrong way round, as every week', () => {
    const before = [{ startDate: '2025-01-01', endDate: '2025-06-01' }];
    const inverted = [{ startDate: '2027-03-01', endDate: '2026-10-01' }];
    const autumn = [{ startDate: null, endDate: '2026-12-18' }];
    expect(yearPeriodsOf(YEAR, [before, inverted])).toBeNull();
    expect(yearPeriodsOf(YEAR, [before, inverted, autumn])!.masks).toEqual([undefined, undefined, [true, false]]);
  });

  it('never has more periods than a läsår has weeks', () => {
    // A course for every single week: as many periods as weeks, and no more.
    const weekly: HeldWindow[][] = [];
    for (let monday = mondayOf(YEAR.startDate); monday <= YEAR.endDate; monday = addDays(monday, 7)) {
      weekly.push([{ startDate: monday, endDate: addDays(monday, 6) }]);
    }
    const periods = yearPeriodsOf(YEAR, weekly)!;
    expect(periods.weeks).toHaveLength(weekly.length);
    expect(weekly.length).toBeLessThanOrEqual(MAX_PERIODS);
    // A year longer than the engine reads is sent as it always was.
    const long = { startDate: '2026-01-05', endDate: '2027-06-13' };
    const many: HeldWindow[][] = [];
    for (let monday = long.startDate; monday <= long.endDate; monday = addDays(monday, 7)) {
      many.push([{ startDate: monday, endDate: addDays(monday, 6) }]);
    }
    expect(many.length).toBeGreaterThan(MAX_PERIODS);
    expect(yearPeriodsOf(long, many)).toBeNull();
    // And the bound is the engine's own: 53 periods are sent, 54 are not.
    const cut = (weeks: number) => {
      const year = { startDate: '2026-01-05', endDate: addDays('2026-01-05', 7 * weeks - 1) };
      const each: HeldWindow[][] = [];
      for (let week = 0; week < weeks; week += 1) {
        each.push([{ startDate: addDays(year.startDate, 7 * week), endDate: addDays(year.startDate, 7 * week + 6) }]);
      }
      return yearPeriodsOf(year, each);
    };
    expect(cut(MAX_PERIODS)!.weeks).toHaveLength(MAX_PERIODS);
    expect(cut(MAX_PERIODS + 1)).toBeNull();
  });

  describe('over random years and windows', () => {
    const next = random(20261111);
    const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)]!;
    const PARITIES: LessonRecurrence[] = ['ALL_WEEKS', 'ALL_WEEKS', 'ODD_WEEKS', 'EVEN_WEEKS'];

    function world() {
      const start = addDays('2026-08-10', Math.floor(next() * 14));
      const year = { startDate: start, endDate: addDays(start, 250 + Math.floor(next() * 80)) };
      const anyDay = (): string => addDays(year.startDate, Math.floor(next() * 380) - 30);
      const entries = Array.from({ length: 2 + Math.floor(next() * 7) }, () => {
        const kind = next();
        let window: HeldWindow;
        if (kind < 0.2) window = ALL_YEAR;
        else if (kind < 0.4) window = { startDate: null, endDate: anyDay() };
        else if (kind < 0.6) window = { startDate: anyDay(), endDate: null };
        else {
          // Mostly the right way round and often short: a week, a few days.
          const from = anyDay();
          window = { startDate: from, endDate: addDays(from, Math.floor(next() * (next() < 0.5 ? 9 : 200)) - 1) };
        }
        return { window, recurrence: pick(PARITIES) };
      });
      return { year, entries, periods: yearPeriodsOf(year, entries.map((entry) => [entry.window])) };
    }

    const mondays = (year: { startDate: string; endDate: string }): string[] => {
      const out: string[] = [];
      for (let monday = mondayOf(year.startDate); monday <= year.endDate; monday = addDays(monday, 7)) out.push(monday);
      return out;
    };
    /** The window as weeksCanOverlap reads one, null for the open ends. */
    const dated = (window: HeldWindow, recurrence: LessonRecurrence) => ({
      recurrence,
      startDate: window.startDate ? day(window.startDate) : null,
      endDate: window.endDate ? day(window.endDate) : null,
    });
    /** The window widened to the whole weeks of the läsår it touches; null when it touches none. */
    const widened = (window: HeldWindow, year: { startDate: string; endDate: string }): HeldWindow | null => {
      const held = mondays(year).filter(
        (monday) =>
          (window.startDate === null || window.startDate <= addDays(monday, 6)) &&
          (window.endDate === null || window.endDate >= monday),
      );
      return held.length === 0 ? null : { startDate: held[0]!, endDate: addDays(held[held.length - 1]!, 6) };
    };

    it('gives the engine weeksCanOverlap over whole weeks, never a looser reading', () => {
      const seen = { meet: 0, apart: 0, stricter: 0, dated: 0 };
      for (let round = 0; round < 1500; round += 1) {
        const { year, entries, periods } = world();
        const masks = periods ? periods.masks : entries.map(() => undefined);
        if (periods) seen.dated += 1;
        const weeks = mondays(year);
        // Read once per entry: its window over whole weeks, and the real weeks it has a date in.
        const wide = entries.map((entry) => widened(entry.window, year) ?? ALL_YEAR);
        const inRealWeek = entries.map((entry) =>
          weeks.map((monday) =>
            [0, 1, 2, 3, 4, 5, 6].some((offset) =>
              runsOn(dated(entry.window, entry.recurrence), day(addDays(monday, offset))),
            ),
          ),
        );
        for (let a = 0; a < entries.length; a += 1) {
          for (let b = a + 1; b < entries.length; b += 1) {
            const first = entries[a]!;
            const second = entries[b]!;
            const engine = meetInEngine(
              { mask: masks[a], recurrence: first.recurrence },
              { mask: masks[b], recurrence: second.recurrence },
            );
            // 1. Never looser than the grid's own clash rule on the dates as they stand.
            const grid = weeksCanOverlap(
              dated(first.window, first.recurrence),
              dated(second.window, second.recurrence),
            );
            if (grid) expect(engine).toBe(true);
            // 2. Exactly that rule on the windows widened to whole weeks of the
            //    läsår — an entry that touches none of them being every week.
            expect(engine).toBe(
              weeksCanOverlap(dated(wide[a]!, first.recurrence), dated(wide[b]!, second.recurrence)),
            );
            // 3. Never looser than a real week: one that has a date of each.
            const realWeek = weeks.some((_, week) => inRealWeek[a]![week] && inRealWeek[b]![week]);
            if (realWeek) expect(engine).toBe(true);
            seen[engine ? 'meet' : 'apart'] += 1;
            if (engine && !grid) seen.stricter += 1;
          }
        }
      }
      // Both answers, often; and the one place the engine is the stricter was among them.
      expect(seen.apart).toBeGreaterThan(2000);
      expect(seen.meet).toBeGreaterThan(2000);
      expect(seen.stricter).toBeGreaterThan(40);
      expect(seen.dated).toBeGreaterThan(1000);
    });

    it('cuts every week of the läsår into exactly one period, each with its own entries', () => {
      for (let round = 0; round < 500; round += 1) {
        const { year, entries, periods } = world();
        if (!periods) {
          // Nothing tells two weeks apart: every entry is in all of them or in none.
          for (const entry of entries) {
            const held = mondays(year).filter((monday) => widened(entry.window, { startDate: monday, endDate: monday }));
            expect([0, mondays(year).length]).toContain(held.length);
          }
          continue;
        }
        const count = periods.weeks.length;
        expect(count).toBeGreaterThanOrEqual(2);
        expect(periods.stretches).toHaveLength(count);
        expect(periods.weeks.reduce((sum, weeks) => sum + weeks, 0)).toBe(mondays(year).length);
        for (const mask of periods.masks) {
          if (!mask) continue;
          expect(mask).toHaveLength(count);
          // One representation: some period in, some period out.
          expect(mask.some(Boolean)).toBe(true);
          expect(mask.every(Boolean)).toBe(false);
        }
        // Two periods never hold the same entries: weeks that do are one period.
        const signatures = new Set(
          periods.weeks.map((_, period) => periods.masks.map((mask) => (mask ? (mask[period] ? '1' : '0') : '-')).join('')),
        );
        expect(signatures.size).toBe(count);
        // The stretches are the period's weeks: whole weeks, in order, clipped to the läsår,
        // and in every one of them each entry runs exactly as its mask says.
        let days = 0;
        periods.stretches.forEach((stretches, period) => {
          let weeks = 0;
          for (const stretch of stretches) {
            expect(stretch.from >= year.startDate && stretch.to <= year.endDate && stretch.from <= stretch.to).toBe(true);
            for (let monday = mondayOf(stretch.from); monday <= stretch.to; monday = addDays(monday, 7)) {
              weeks += 1;
              entries.forEach((entry, index) => {
                const mask = periods.masks[index];
                const inWeek = widened(entry.window, { startDate: monday, endDate: monday }) !== null;
                if (mask) expect(inWeek).toBe(mask[period]);
              });
            }
            days += (day(stretch.to).getTime() - day(stretch.from).getTime()) / DAY_MS + 1;
          }
          expect(weeks).toBe(periods.weeks[period]);
        });
        // Every day of the läsår is in exactly one stretch.
        expect(days).toBe((day(year.endDate).getTime() - day(year.startDate).getTime()) / DAY_MS + 1);
      }
    });
  });
});

describe('withPeriodDates', () => {
  const stretches = [
    [{ from: '2026-08-17', to: '2026-12-27' }],
    [
      { from: '2026-12-28', to: '2027-01-10' },
      { from: '2027-03-01', to: '2027-03-07' },
    ],
  ];

  it('adds the days of the period a refusal was counted in, beside its index', () => {
    expect(withPeriodDates({ period: 0, demandMinutes: 1500 }, stretches)).toEqual({
      period: 0,
      demandMinutes: 1500,
      periodFrom: '2026-08-17',
      periodTo: '2026-12-27',
      periodStretches: 1,
    });
    expect(withPeriodDates({ period: 1, parity: 'ODD_WEEKS' }, stretches)).toEqual({
      period: 1,
      parity: 'ODD_WEEKS',
      periodFrom: '2026-12-28',
      periodTo: '2027-01-10',
      periodStretches: 2,
    });
  });

  it('reads the stretches of every period a count names together, in the order of the year', () => {
    // The autumn, the weeks between, the spring: three periods, each one stretch.
    const year = [
      [{ from: '2026-08-17', to: '2026-12-20' }],
      [{ from: '2026-12-21', to: '2027-01-10' }],
      [{ from: '2027-01-11', to: '2027-06-11' }],
    ];
    // The autumn and the spring: two stretches, and the sentence names the first.
    expect(withPeriodDates({ period: 0, periods: '0,2', parity: 'ODD_WEEKS' }, year)).toEqual({
      period: 0, periods: '0,2', parity: 'ODD_WEEKS',
      periodFrom: '2026-08-17', periodTo: '2026-12-20', periodStretches: 2,
    });
    // The autumn and the weeks after it meet: one run of weeks, named whole.
    expect(withPeriodDates({ period: 0, periods: '0,1' }, year)).toEqual({
      period: 0, periods: '0,1', periodFrom: '2026-08-17', periodTo: '2027-01-10', periodStretches: 1,
    });
    expect(withPeriodDates({ period: 0, periods: '0,1,2' }, year)).toMatchObject({
      periodFrom: '2026-08-17', periodTo: '2027-06-11', periodStretches: 1,
    });
    // In the order of the year, whatever order the indices came in.
    expect(withPeriodDates({ period: 1, periods: '2,1' }, year)).toMatchObject({
      periodFrom: '2026-12-21', periodTo: '2027-06-11', periodStretches: 1,
    });
    // A period of two stretches beside one that fills the gap between them.
    const split = [
      [{ from: '2026-08-17', to: '2026-12-20' }, { from: '2027-01-11', to: '2027-06-11' }],
      [{ from: '2026-12-21', to: '2027-01-10' }],
    ];
    expect(withPeriodDates({ period: 0 }, split)).toMatchObject({ periodTo: '2026-12-20', periodStretches: 2 });
    expect(withPeriodDates({ period: 0, periods: '0,1' }, split)).toMatchObject({
      periodFrom: '2026-08-17', periodTo: '2027-06-11', periodStretches: 1,
    });
    // What cannot be read is left alone, and the first period's own stretches stand.
    for (const periods of ['0,7', '2', '0;2', '', 'a,b', '0,2,']) {
      expect(withPeriodDates({ period: 0, periods }, year)).toEqual({
        period: 0, periods, periodFrom: '2026-08-17', periodTo: '2026-12-20', periodStretches: 1,
      });
    }
    // A period listed twice is that period once: no stretch is counted twice, and the
    // sentence adds no other weeks (review of #301, round two, LÅG-1).
    for (const [twice, once] of [['0,0', '0'], ['0,2,0', '0,2'], ['1,0,1,0', '0,1'], ['2,2,2', '2']] as const) {
      const first = Number(once[0]);
      const dated = withPeriodDates({ period: first, periods: once }, year);
      expect(withPeriodDates({ period: first, periods: twice }, year)).toEqual({ ...dated, periods: twice });
    }
    expect(withPeriodDates({ period: 0, periods: '0,0' }, year)).toMatchObject({ periodStretches: 1 });
    expect(periodSentence(withPeriodDates({ period: 0, periods: '0,0' }, year))).toBe(
      ' Counted for the weeks from 2026-08-17 to 2026-12-20, which is when these run together.',
    );
    // And the sentence follows: the other weeks are said, with the parity.
    expect(periodSentence(withPeriodDates({ period: 0, periods: '0,2', parity: 'ODD_WEEKS' }, year))).toBe(
      ' Counted for the weeks from 2026-08-17 to 2026-12-20 and the other weeks with the same entries' +
        ' (odd weeks), which is when these run together.',
    );
  });

  describe('a period with no week of the parity counted', () => {
    // Review of #301, round two, LÅG-2. The engine counted the odd weeks of periods 29 and 30
    // ("29,30", ODD_WEEKS) and period 30 is one EVEN week: week 18, 3 to 9 May 2027. Its
    // stretch in the window made it a week wider than the week that was counted.
    const at = (held: Record<number, { from: string; to: string }[]>) =>
      Array.from({ length: 31 }, (_, index) => held[index] ?? [{ from: '2026-08-17', to: '2026-08-23' }]);
    const odd29 = { from: '2027-04-26', to: '2027-05-02' }; // week 17
    const even30 = { from: '2027-05-03', to: '2027-05-09' }; // week 18

    it('is left out of the window: the weeks counted, and no week more', () => {
      const counted = { period: 29, periods: '29,30', parity: 'ODD_WEEKS' };
      expect(withPeriodDates(counted, at({ 29: [odd29], 30: [even30] }))).toEqual({
        ...counted, periodFrom: '2027-04-26', periodTo: '2027-05-02', periodStretches: 1,
      });
      expect(periodSentence(withPeriodDates(counted, at({ 29: [odd29], 30: [even30] })))).toBe(
        ' Counted for the weeks from 2027-04-26 to 2027-05-02 (odd weeks), which is when these run together.',
      );
    });

    it('is left out the same way when it is the first of them, and the dates are the others’', () => {
      // The even weeks of the same two periods: period 29 is week 17, an odd one, and is the
      // one with none. `period` is the engine's own word and stays; the dates are week 18's.
      expect(withPeriodDates({ period: 29, periods: '29,30', parity: 'EVEN_WEEKS' }, at({ 29: [odd29], 30: [even30] }))).toEqual({
        period: 29, periods: '29,30', parity: 'EVEN_WEEKS',
        periodFrom: '2027-05-03', periodTo: '2027-05-09', periodStretches: 1,
      });
    });

    it('is kept when any stretch of it holds a week of the parity: two weeks hold both', () => {
      const two = { from: '2027-05-03', to: '2027-05-16' }; // weeks 18 and 19
      expect(withPeriodDates({ period: 29, periods: '29,30', parity: 'ODD_WEEKS' }, at({ 29: [odd29], 30: [two] }))).toMatchObject({
        periodFrom: '2027-04-26', periodTo: '2027-05-16', periodStretches: 1,
      });
      // Each stretch is asked on its own (review of #304, MEDEL-1): period 30 has week 18, an
      // even week that was not counted, and week 21, an odd one that was. Only week 21 is
      // written, beside week 17; the period's keeping its odd week does not keep its even one.
      expect(
        withPeriodDates({ period: 29, periods: '29,30', parity: 'ODD_WEEKS' }, at({
          29: [odd29], 30: [even30, { from: '2027-05-24', to: '2027-05-30' }], // …and week 21
        })),
      ).toMatchObject({ periodFrom: '2027-04-26', periodTo: '2027-05-02', periodStretches: 2 });
    });

    describe('a läsår that starts on a Saturday, as the production’s does (review of #304, MEDEL-1)', () => {
      // 15 August 2026 is a Saturday, and the läsår has 53 ISO weeks in it: week 53 starts on
      // Monday 28 December and week 1 of 2027 on 4 January. Both are odd.
      const year = { startDate: '2026-08-15', endDate: '2027-06-12' };

      it('reads two weeks in a row as the parities they are: week 53 and week 1 hold no even week', () => {
        // The autumn's post and the spring's: the two weeks between them are a period of their own.
        const periods = yearPeriodsOf(year, [
          [{ startDate: '2026-08-15', endDate: '2026-12-27' }],
          [{ startDate: '2027-01-11', endDate: '2027-06-12' }],
        ]);
        expect(periods!.stretches).toEqual([
          [{ from: '2026-08-15', to: '2026-12-27' }],
          [{ from: '2026-12-28', to: '2027-01-10' }],
          [{ from: '2027-01-11', to: '2027-06-12' }],
        ]);
        const dated = (params: Record<string, string | number>) => withPeriodDates(params, periods!.stretches);
        // The even weeks of the two periods: the spring's, and not the two that have none.
        expect(dated({ period: 1, periods: '1,2', parity: 'EVEN_WEEKS' })).toMatchObject({
          periodFrom: '2027-01-11', periodTo: '2027-06-12', periodStretches: 1,
        });
        expect(periodSentence(dated({ period: 1, periods: '1,2', parity: 'EVEN_WEEKS' }))).toBe(
          ' Counted for the weeks from 2027-01-11 to 2027-06-12 (even weeks), which is when these run together.',
        );
        // The odd weeks are the Christmas weeks and then the spring's, and they meet.
        expect(dated({ period: 1, periods: '1,2', parity: 'ODD_WEEKS' })).toMatchObject({
          periodFrom: '2026-12-28', periodTo: '2027-06-12', periodStretches: 1,
        });
        // The period alone has no even week to be named by: its dates stand as they came.
        expect(dated({ period: 1, parity: 'EVEN_WEEKS' })).toMatchObject({
          periodFrom: '2026-12-28', periodTo: '2027-01-10', periodStretches: 1,
        });
      });

      it('asks a period’s stretches one by one: a lone week of the other parity is not the first window', () => {
        // One post, held in week 34 (Monday 17 August) and from week 48 (Monday 23 November) on: the
        // period that holds it has the lone week, then the long run.
        const periods = yearPeriodsOf(year, [[
          { startDate: '2026-08-17', endDate: '2026-08-23' },
          { startDate: '2026-11-23', endDate: '2027-06-12' },
        ]]);
        expect(periods!.stretches[1]).toEqual([
          { from: '2026-08-17', to: '2026-08-23' },
          { from: '2026-11-23', to: '2027-06-12' },
        ]);
        // Week 34 is even. The odd weeks are counted in the long run, and the window is its.
        expect(withPeriodDates({ period: 1, parity: 'ODD_WEEKS' }, periods!.stretches)).toMatchObject({
          periodFrom: '2026-11-23', periodTo: '2027-06-12', periodStretches: 1,
        });
        // The even weeks are in both: the lone week first, and the run after it.
        expect(withPeriodDates({ period: 1, parity: 'EVEN_WEEKS' }, periods!.stretches)).toMatchObject({
          periodFrom: '2026-08-17', periodTo: '2026-08-23', periodStretches: 2,
        });
      });

      it('has both parities in any three weeks in a row, and in two weeks that are not both odd', () => {
        // The stretch asked, beside a period that has both parities in March (weeks 9 to 11): where the
        // stretch is dropped the window is March's, and where it is kept the window is its own.
        const asked = (parity: string, from: string, to: string) =>
          withPeriodDates({ period: 1, periods: '1,2', parity }, [
            [{ from: '2026-08-15', to: '2026-08-16' }],
            [{ from, to }],
            [{ from: '2027-03-01', to: '2027-03-21' }],
          ]);
        const kept = (from: string, to: string) => ({ periodFrom: from, periodTo: to, periodStretches: 2 });
        // Weeks 52, 53 and 1 (even, odd, odd) and 53, 1 and 2 (odd, odd, even): each has both.
        for (const [from, to] of [['2026-12-21', '2027-01-10'], ['2026-12-28', '2027-01-17']] as const) {
          for (const parity of ['ODD_WEEKS', 'EVEN_WEEKS']) {
            expect(asked(parity, from, to)).toMatchObject(kept(from, to));
          }
        }
        // Weeks 52 and 53 (even, odd) and 1 and 2 (odd, even): two weeks that differ have both.
        for (const [from, to] of [['2026-12-21', '2027-01-03'], ['2027-01-04', '2027-01-17']] as const) {
          for (const parity of ['ODD_WEEKS', 'EVEN_WEEKS']) {
            expect(asked(parity, from, to)).toMatchObject(kept(from, to));
          }
        }
        // Week 53 and week 1 are odd twice: kept for the odd weeks, and left out of the even ones.
        expect(asked('ODD_WEEKS', '2026-12-28', '2027-01-10')).toMatchObject(kept('2026-12-28', '2027-01-10'));
        expect(asked('EVEN_WEEKS', '2026-12-28', '2027-01-10')).toMatchObject({
          periodFrom: '2027-03-01', periodTo: '2027-03-21', periodStretches: 1,
        });
        // Week 1 is odd and week 2 even, one week each: each is asked on its own.
        expect(asked('EVEN_WEEKS', '2027-01-04', '2027-01-10')).toMatchObject({ periodFrom: '2027-03-01', periodStretches: 1 });
        expect(asked('ODD_WEEKS', '2027-01-11', '2027-01-17')).toMatchObject({ periodFrom: '2027-03-01', periodStretches: 1 });
      });

      it('reads a stretch from the Monday of its first day to its last day, whatever days it starts and ends on', () => {
        // Review of #304, round two, LÅG-1. The läsår's ends, and a period that begins in midweek, have
        // stretches that start and end on any day. Beside a stretch of three weeks that holds both
        // parities (weeks 18 to 20), where the dropped stretch is seen as the window being the three weeks'.
        const asked = (parity: string, from: string, to: string) =>
          withPeriodDates({ period: 1, periods: '1,2', parity }, [
            [{ from: '2026-08-15', to: '2026-08-16' }],
            [{ from, to }],
            [{ from: '2027-05-03', to: '2027-05-23' }],
          ]);
        const kept = (from: string, to: string) => ({ periodFrom: from, periodTo: to, periodStretches: 2 });
        const dropped = { periodFrom: '2027-05-03', periodTo: '2027-05-23', periodStretches: 1 };
        // Wednesday 3 March to Monday 8 March 2027: week 9 (odd) and then, on the Monday, week 10 (even).
        // Read from the day itself the second week is never reached and the even weeks lose it.
        expect(asked('ODD_WEEKS', '2027-03-03', '2027-03-08')).toMatchObject(kept('2027-03-03', '2027-03-08'));
        expect(asked('EVEN_WEEKS', '2027-03-03', '2027-03-08')).toMatchObject(kept('2027-03-03', '2027-03-08'));
        // A stretch of the one Monday, 1 March (week 9, odd): the week is there on the day it ends, and
        // a week that starts after it is not.
        expect(asked('ODD_WEEKS', '2027-03-01', '2027-03-01')).toMatchObject(kept('2027-03-01', '2027-03-01'));
        expect(asked('EVEN_WEEKS', '2027-03-01', '2027-03-01')).toMatchObject(dropped);
        // The Sunday that ends week 9, and two days inside it.
        expect(asked('ODD_WEEKS', '2027-03-07', '2027-03-07')).toMatchObject(kept('2027-03-07', '2027-03-07'));
        expect(asked('EVEN_WEEKS', '2027-03-07', '2027-03-07')).toMatchObject(dropped);
        expect(asked('ODD_WEEKS', '2027-03-03', '2027-03-04')).toMatchObject(kept('2027-03-03', '2027-03-04'));
        expect(asked('EVEN_WEEKS', '2027-03-03', '2027-03-04')).toMatchObject(dropped);
        // And the next week's Monday to Tuesday (week 10, even).
        expect(asked('EVEN_WEEKS', '2027-03-08', '2027-03-09')).toMatchObject(kept('2027-03-08', '2027-03-09'));
        expect(asked('ODD_WEEKS', '2027-03-08', '2027-03-09')).toMatchObject(dropped);
      });

      it('leaves the dates as they came when none of the stretches named holds a week of the parity', () => {
        // Week 53 and week 1 with nothing else named: there is no even week to say, and the dates are
        // the ones the engine was given (review of #304, round two, LÅG-2). With the autumn named beside
        // them the autumn is the window.
        const christmas = [[{ from: '2026-08-15', to: '2026-12-27' }], [{ from: '2026-12-28', to: '2027-01-10' }]];
        expect(withPeriodDates({ period: 1, parity: 'EVEN_WEEKS' }, christmas)).toMatchObject({
          periodFrom: '2026-12-28', periodTo: '2027-01-10', periodStretches: 1,
        });
        expect(withPeriodDates({ period: 0, periods: '0,1', parity: 'EVEN_WEEKS' }, christmas)).toMatchObject({
          periodFrom: '2026-08-15', periodTo: '2026-12-27', periodStretches: 1,
        });
        // Where no named period has the parity at all the whole of them is named.
        const noEven = [[{ from: '2026-12-28', to: '2027-01-03' }], [{ from: '2027-01-04', to: '2027-01-10' }]];
        expect(withPeriodDates({ period: 0, periods: '0,1', parity: 'EVEN_WEEKS' }, noEven)).toMatchObject({
          periodFrom: '2026-12-28', periodTo: '2027-01-10', periodStretches: 1,
        });
      });
    });

    it('reads the läsår’s first two days, a Saturday and a Sunday, as the week they are in', () => {
      // 15 and 16 August 2026 are week 33, odd, though the period is two days and not a week.
      const stretches = [
        [{ from: '2026-08-15', to: '2026-08-16' }], // week 33
        [{ from: '2026-08-17', to: '2026-08-23' }], // week 34
      ];
      expect(withPeriodDates({ period: 0, periods: '0,1', parity: 'ODD_WEEKS' }, stretches)).toMatchObject({
        periodFrom: '2026-08-15', periodTo: '2026-08-16', periodStretches: 1,
      });
      expect(withPeriodDates({ period: 0, periods: '0,1', parity: 'EVEN_WEEKS' }, stretches)).toMatchObject({
        periodFrom: '2026-08-17', periodTo: '2026-08-23', periodStretches: 1,
      });
    });

    it('reads the week number of the ISO year: week 53 and week 1 are both odd', () => {
      const stretches = [
        [{ from: '2026-12-28', to: '2027-01-03' }], // week 53 of 2026
        [{ from: '2027-01-04', to: '2027-01-10' }], // week 1 of 2027
        [{ from: '2027-01-11', to: '2027-01-17' }], // week 2
      ];
      expect(withPeriodDates({ period: 0, periods: '0,1,2', parity: 'ODD_WEEKS' }, stretches)).toMatchObject({
        periodFrom: '2026-12-28', periodTo: '2027-01-10',
      });
      expect(withPeriodDates({ period: 0, periods: '0,1,2', parity: 'EVEN_WEEKS' }, stretches)).toMatchObject({
        periodFrom: '2027-01-11', periodTo: '2027-01-17',
      });
    });

    it('leaves the dates as they came where none of the periods has a week of the parity', () => {
      // Nothing to leave them out for: the engine's words are then all there is.
      const odds = [odd29, { from: '2027-05-10', to: '2027-05-16' }]; // weeks 17 and 19
      expect(
        withPeriodDates({ period: 0, periods: '0,1', parity: 'EVEN_WEEKS' }, [[odds[0]!], [odds[1]!]]),
      ).toMatchObject({ periodFrom: '2027-04-26', periodTo: '2027-05-02', periodStretches: 2 });
      expect(withPeriodDates({ period: 0, parity: 'EVEN_WEEKS' }, [[odds[0]!]])).toMatchObject({
        periodFrom: '2027-04-26', periodTo: '2027-05-02',
      });
    });

    it('is no business of a count that names no parity, or one that is not a parity', () => {
      const cases: Record<string, string | number>[] = [
        { period: 29, periods: '29,30' },
        { period: 29, periods: '29,30', parity: 'ALL_WEEKS' },
      ];
      for (const params of cases) {
        expect(withPeriodDates(params, at({ 29: [odd29], 30: [even30] }))).toMatchObject({
          periodFrom: '2027-04-26', periodTo: '2027-05-09', periodStretches: 1,
        });
      }
    });
  });

  it('leaves alone what names no period, or one the read does not have', () => {
    const plain = { demandMinutes: 2560 };
    expect(withPeriodDates(plain, stretches)).toBe(plain);
    const unknown = { period: 7 };
    expect(withPeriodDates(unknown, stretches)).toBe(unknown);
    const noRead = { period: 0 };
    expect(withPeriodDates(noRead, undefined)).toBe(noRead);
    // A group called "0" is no index.
    const named = { period: '0' };
    expect(withPeriodDates(named, stretches)).toBe(named);
  });
});

describe('periodSentence', () => {
  it('says where in the year the count was made, and nothing without the days', () => {
    expect(periodSentence({ periodFrom: '2027-01-11', periodTo: '2027-01-17', periodStretches: 1 })).toBe(
      ' Counted for the weeks from 2027-01-11 to 2027-01-17, which is when these run together.',
    );
    expect(periodSentence({ periodFrom: '2026-12-28', periodTo: '2027-01-10', periodStretches: 2 })).toBe(
      ' Counted for the weeks from 2026-12-28 to 2027-01-10 and the other weeks with the same entries,' +
        ' which is when these run together.',
    );
    expect(periodSentence({ period: 2 })).toBe('');
    // Half a stretch is no stretch: a sentence with one end would name no weeks.
    expect(periodSentence({ period: 2, periodFrom: '2027-01-11' })).toBe('');
    expect(periodSentence({ period: 2, periodTo: '2027-01-17' })).toBe('');
  });

  it('says which weeks of the period were counted, when the engine counted the odd or the even ones only', () => {
    const week = { periodFrom: '2027-01-11', periodTo: '2027-01-17', periodStretches: 1 };
    expect(periodSentence({ ...week, parity: 'ODD_WEEKS' })).toBe(
      ' Counted for the weeks from 2027-01-11 to 2027-01-17 (odd weeks), which is when these run together.',
    );
    expect(periodSentence({ ...week, parity: 'EVEN_WEEKS' })).toBe(
      ' Counted for the weeks from 2027-01-11 to 2027-01-17 (even weeks), which is when these run together.',
    );
    // After the other stretches, as the web writes it.
    expect(periodSentence({ ...week, periodStretches: 3, parity: 'EVEN_WEEKS' })).toBe(
      ' Counted for the weeks from 2027-01-11 to 2027-01-17 and the other weeks with the same entries' +
        ' (even weeks), which is when these run together.',
    );
    // Anything else in the key is no parity: nothing is said of it.
    expect(periodSentence({ ...week, parity: 'ALL_WEEKS' })).toBe(
      ' Counted for the weeks from 2027-01-11 to 2027-01-17, which is when these run together.',
    );
  });

  describe('klassens lunch: locked lessons of several periods', () => {
    // The autumn, the weeks between, the spring: three periods, each one stretch.
    const year = [
      [{ from: '2026-08-17', to: '2026-12-20' }],
      [{ from: '2026-12-21', to: '2027-01-10' }],
      [{ from: '2027-01-11', to: '2027-06-11' }],
    ];
    const refusal = { group: '7A', minutes: 30, windowStart: '11:00', windowEnd: '12:00', day: 1 };

    it('adds the first stretch of the first two parts, the earlier of them first', () => {
      const dated = { lockFrom: '2026-08-17', lockTo: '2026-12-20', otherLockFrom: '2027-01-11', otherLockTo: '2027-06-11' };
      expect(withLockPeriodDates({ ...refusal, lockPeriods: '0;2' }, year)).toEqual({
        ...refusal, lockPeriods: '0;2', ...dated, lockWeeksElsewhere: 0,
      });
      // The parts as the engine orders them (the pair that closes the window first), the days as the year does.
      expect(withLockPeriodDates({ lockPeriods: '2;0' }, year)).toEqual({ lockPeriods: '2;0', ...dated, lockWeeksElsewhere: 0 });
    });

    it('reads the periods of one part together: the autumn is one run of weeks, however many periods cut it', () => {
      // What a school of six periods was told before the parts: two stretches of the autumn, and never the spring.
      const six = [
        [{ from: '2026-08-15', to: '2026-08-16' }],
        [{ from: '2026-08-17', to: '2026-12-20' }],
        [{ from: '2026-12-21', to: '2027-01-10' }],
        [{ from: '2027-01-11', to: '2027-01-17' }],
        [{ from: '2027-01-18', to: '2027-03-28' }],
        [{ from: '2027-03-29', to: '2027-06-11' }],
      ];
      expect(withLockPeriodDates({ lockPeriods: '0,1,2,3;4,5' }, six)).toEqual({
        lockPeriods: '0,1,2,3;4,5',
        lockFrom: '2026-08-15',
        lockTo: '2027-01-17',
        otherLockFrom: '2027-01-18',
        otherLockTo: '2027-06-11',
        lockWeeksElsewhere: 0,
      });
      // In whatever order a part's periods came, and a period named twice is one.
      expect(withLockPeriodDates({ lockPeriods: '3,1,0,2,1;5,4' }, six)).toMatchObject({
        lockFrom: '2026-08-15', lockTo: '2027-01-17', otherLockFrom: '2027-01-18', otherLockTo: '2027-06-11',
        lockWeeksElsewhere: 0,
      });
    });

    it('counts the stretches it does not write out: a part that comes back, or a third part', () => {
      // The first part is the autumn and the spring's last weeks: two runs, one written out.
      const back = [
        [{ from: '2026-08-17', to: '2026-12-20' }],
        [{ from: '2026-12-21', to: '2027-03-28' }],
        [{ from: '2027-03-29', to: '2027-06-11' }],
      ];
      expect(withLockPeriodDates({ lockPeriods: '0,2;1' }, back)).toMatchObject({
        lockFrom: '2026-08-17', lockTo: '2026-12-20', otherLockFrom: '2026-12-21', otherLockTo: '2027-03-28',
        lockWeeksElsewhere: 1,
      });
      // Three parts: the first two are named (the engine put the pair that closes the window there).
      expect(withLockPeriodDates({ lockPeriods: '0;2;1' }, year)).toMatchObject({
        lockFrom: '2026-08-17', lockTo: '2026-12-20', otherLockFrom: '2027-01-11', otherLockTo: '2027-06-11',
        lockWeeksElsewhere: 1,
      });
    });

    it('leaves alone what names no two parts the read has', () => {
      for (const params of [
        refusal,
        // One part is one period's own shortage, which the engine never sends.
        { ...refusal, lockPeriods: '0' },
        { ...refusal, lockPeriods: '0,2' },
        { ...refusal, lockPeriods: '0;7' },
        { ...refusal, lockPeriods: '0;2;' },
        { ...refusal, lockPeriods: ';0;2' },
        { ...refusal, lockPeriods: '0,;2' },
        { ...refusal, lockPeriods: 'a;b' },
        // One period in two parts: the same weeks would be written out as both.
        { ...refusal, lockPeriods: '0;0' },
        { ...refusal, lockPeriods: '0,2;2' },
        { ...refusal, lockPeriods: '0;1;0' },
        { ...refusal, lockPeriods: '' },
        { ...refusal, lockPeriods: 2 },
      ]) {
        expect(withLockPeriodDates(params, year)).toBe(params);
      }
      const named = { ...refusal, lockPeriods: '0;2' };
      expect(withLockPeriodDates(named, undefined)).toBe(named);
      // A period this part does not name may have no weeks; one it names may not.
      expect(withLockPeriodDates(named, [year[0]!, [], year[2]!])).toMatchObject({ otherLockFrom: '2027-01-11' });
      expect(withLockPeriodDates(named, [year[0]!, year[1]!, []])).toBe(named);
      expect(withLockPeriodDates({ ...refusal, lockPeriods: '0,1;2' }, [year[0]!, [], year[2]!])).toMatchObject({
        lockPeriods: '0,1;2',
      });
      expect(withLockPeriodDates({ ...refusal, lockPeriods: '0,1;2' }, [year[0]!, [], year[2]!])).not.toHaveProperty('lockFrom');
    });

    it('says the two parts of the year and that the meal is the year’s, and nothing without the dates', () => {
      expect(lunchLocksSentence(withLockPeriodDates({ ...refusal, lockPeriods: '0;2' }, year))).toBe(
        ' The locked lessons that close the lunch window between them run in different parts of the school year:' +
          ' the weeks from 2026-08-17 to 2026-12-20 and the weeks from 2027-01-11 to 2027-06-11.' +
          " A class's lunch is one time all year, so it has to keep clear of locked lessons in every part of the year.",
      );
      expect(lunchLocksSentence(withLockPeriodDates({ lockPeriods: '0;1;2' }, year))).toContain(
        'the weeks from 2026-12-21 to 2027-01-10, among others. A class',
      );
      expect(lunchLocksSentence(refusal)).toBe('');
      expect(lunchLocksSentence({ ...refusal, lockPeriods: '0;2' })).toBe('');
      // Every one of the four days, or no sentence.
      const dated = withLockPeriodDates({ lockPeriods: '0;2' }, year) as Record<string, string | number>;
      for (const key of ['lockFrom', 'lockTo', 'otherLockFrom', 'otherLockTo']) {
        expect(lunchLocksSentence({ ...dated, [key]: 20270111 })).toBe('');
      }
    });
  });
});
