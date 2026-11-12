import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LessonRecurrence } from '@prisma/client';
import { runsOn, weeksCanOverlap } from '../calendar/lesson-recurrence';
import { MAX_PERIODS, periodSentence, withPeriodDates, yearPeriodsOf, type HeldWindow } from './year-periods';

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
    expect(periodSentence({ periodFrom: '2026-12-28', periodTo: '2027-01-10', periodStretches: 2 })).toContain(
      '(and the other weeks with the same entries)',
    );
    expect(periodSentence({ period: 2 })).toBe('');
    // Half a stretch is no stretch: a sentence with one end would name no weeks.
    expect(periodSentence({ period: 2, periodFrom: '2027-01-11' })).toBe('');
    expect(periodSentence({ period: 2, periodTo: '2027-01-17' })).toBe('');
  });
});
