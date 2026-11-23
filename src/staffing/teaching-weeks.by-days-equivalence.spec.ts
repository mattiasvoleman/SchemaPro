import { isoWeekNumber } from '../calendar/lesson-recurrence';
import { teachingWeeksByDays, type ClosedRange, type TeachingPeriod, type YearBounds } from './teaching-weeks';

/*
 * teachingWeeksByDays counts with whole days since the epoch (review of #408, L-5: the walk with a Date, an ISO string and a pass
 * over every closure per day cost 0.19 ms a call, once per requirement of a year, and the proposal, the report and the checks on a
 * write each pay it). The answer must be the old walk's to the last fifth of a week, so this spec carries that walk, as it was,
 * and replays thousands of generated cases through both: years that start on every weekday, periods that start or end inside a
 * week, outside the year or back to front, both parities, lov that overlap, run backwards or lie outside the year, lov of a span of
 * grades and every grade asked about. The shared fixture and the day-by-day oracle in teaching-weeks.contract.spec.ts say the
 * numbers are right; this one says the faster function did not move any of them.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const parseDay = (value: string): Date => new Date(`${value}T00:00:00.000Z`);
const toDay = (date: Date): string => date.toISOString().slice(0, 10);
const addDays = (date: Date, days: number): Date => new Date(date.getTime() + days * DAY_MS);
const mondayOf = (date: Date): Date => addDays(date, 1 - (date.getUTCDay() === 0 ? 7 : date.getUTCDay()));

/** The function as it was before the change: a Date, a string and a closure scan per day. */
function reference(period: TeachingPeriod, year: YearBounds, closures: ClosedRange[], gradeLevel: number | null | undefined): number {
  const from = period.startDate && period.startDate > year.startDate ? period.startDate : year.startDate;
  const to = period.endDate && period.endDate < year.endDate ? period.endDate : year.endDate;
  if (from > to) return 0;
  const recurrence = period.recurrence ?? 'ALL_WEEKS';
  const applicable = closures.filter((closure) => {
    const min = closure.minGradeLevel ?? null;
    const max = closure.maxGradeLevel ?? null;
    if (min === null && max === null) return true;
    if (gradeLevel === null || gradeLevel === undefined) return false; // as closesForGrade: no grade asked about is a school-wide question
    if (min !== null && gradeLevel < min) return false;
    if (max !== null && gradeLevel > max) return false;
    return true;
  });
  let days = 0;
  for (let monday = mondayOf(parseDay(from)); toDay(monday) <= to; monday = addDays(monday, 7)) {
    const weekStart = toDay(monday);
    const weekEnd = toDay(addDays(monday, 6));
    if (weekEnd < from || weekStart > to) continue;
    if (recurrence !== 'ALL_WEEKS' && (isoWeekNumber(monday) % 2 === 1) !== (recurrence === 'ODD_WEEKS')) continue;
    for (let offset = 0; offset < 5; offset += 1) {
      const day = toDay(addDays(monday, offset));
      if (day < from || day > to) continue;
      if (applicable.some((closure) => day >= closure.startDate && day <= closure.endDate)) continue;
      days += 1;
    }
  }
  return days / 5;
}

/** mulberry32: a seeded generator, so a failing case is the same case on every machine. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('teachingWeeksByDays is the day-by-day walk, faster', () => {
  const FIRST = Date.UTC(2026, 5, 1) / DAY_MS;
  it('gives the old walk\'s answer for 6 000 generated cases', () => {
    const next = generator(404);
    const int = (low: number, high: number) => low + Math.floor(next() * (high - low + 1));
    const dayOf = (n: number) => toDay(new Date(n * DAY_MS));
    const seen = { zero: 0, odd: 0, even: 0, graded: 0, inverted: 0, partial: 0 };
    for (let i = 0; i < 6000; i += 1) {
      const start = FIRST + int(0, 1200);
      const year: YearBounds = { startDate: dayOf(start), endDate: dayOf(start + int(150, 340)) };
      const period: TeachingPeriod = {};
      const kind = int(0, 9);
      if (kind >= 3) period.recurrence = (['ALL_WEEKS', 'ODD_WEEKS', 'EVEN_WEEKS'] as const)[int(0, 2)];
      if (kind >= 5) period.startDate = dayOf(start + int(-25, 300));
      if (kind >= 6) period.endDate = dayOf(start + int(-25, 340));
      if (kind === 9) period.startDate = null;
      const closures: ClosedRange[] = [];
      for (let k = int(0, 6); k > 0; k -= 1) {
        const first = start + int(-20, 330);
        const length = int(-2, 16);
        const closure: ClosedRange = { startDate: dayOf(first), endDate: dayOf(first + length) };
        if (int(0, 3) === 0) {
          closure.minGradeLevel = int(0, 1) === 0 ? null : int(0, 5);
          closure.maxGradeLevel = int(0, 1) === 0 ? null : int(4, 9);
        }
        closures.push(closure);
      }
      const gradeLevel = int(0, 2) === 0 ? null : int(0, 9);
      const want = reference(period, year, closures, gradeLevel);
      const got = teachingWeeksByDays(period, year, closures, gradeLevel);
      if (got !== want) {
        throw new Error(`${JSON.stringify({ year, period, closures, gradeLevel })}: got ${got}, the old walk gave ${want}`);
      }
      if (want === 0) seen.zero += 1;
      if (period.recurrence === 'ODD_WEEKS') seen.odd += 1;
      if (period.recurrence === 'EVEN_WEEKS') seen.even += 1;
      if (closures.some((c) => c.minGradeLevel !== undefined || c.maxGradeLevel !== undefined)) seen.graded += 1;
      if (closures.some((c) => c.endDate < c.startDate)) seen.inverted += 1;
      if (want * 5 !== Math.round(want * 5) || want % 1 !== 0) seen.partial += 1;
    }
    // The generator must have reached the corners it is there for.
    expect(seen.zero).toBeGreaterThan(50);
    expect(seen.odd).toBeGreaterThan(500);
    expect(seen.even).toBeGreaterThan(500);
    expect(seen.graded).toBeGreaterThan(500);
    expect(seen.inverted).toBeGreaterThan(200);
    expect(seen.partial).toBeGreaterThan(1000);
  });

  it('treats no grade asked about, undefined as well as null, as a school-wide question (the walk\'s closesForGrade; every caller passes null or a number today)', () => {
    const year: YearBounds = { startDate: '2027-08-16', endDate: '2028-06-09' };
    const schoolWide: ClosedRange = { startDate: '2027-10-25', endDate: '2027-10-29' };
    const graded: ClosedRange = { startDate: '2027-12-20', endDate: '2028-01-07', minGradeLevel: 4, maxGradeLevel: 6 };
    for (const grade of [undefined, null]) {
      expect(teachingWeeksByDays({}, year, [schoolWide, graded], grade)).toBe(teachingWeeksByDays({}, year, [schoolWide], null));
      expect(teachingWeeksByDays({}, year, [schoolWide, graded], grade)).toBe(reference({}, year, [schoolWide, graded], grade));
    }
    // ... and a grade the span holds is closed by it, so the two answers are not the same function of the closures by accident
    expect(teachingWeeksByDays({}, year, [schoolWide, graded], 5)).toBeLessThan(teachingWeeksByDays({}, year, [schoolWide, graded], undefined));
  });

  /*
   * The clock changes: the last Sunday of March and of October (Sweden 2026 to 2029), as the edge of a lov and as the edge of the
   * läsår, and a day either side of each. Days are whole days in UTC, so a Sunday with 23 or 25 hours changes nothing; a count that
   * went through local time would be the one that moved. Generated from the dates the clocks change on, then the same corners by hand
   * against numbers worked out on paper (no reference function in them).
   */
  const CLOCK_SUNDAYS = ['2026-03-29', '2026-10-25', '2027-03-28', '2027-10-31', '2028-03-26', '2028-10-29', '2029-03-25', '2029-10-28'];

  it('gives the old walk\'s answer with the läsår and the lov starting and ending on and around the clock changes', () => {
    const next = generator(2027);
    const int = (low: number, high: number) => low + Math.floor(next() * (high - low + 1));
    const near = (iso: string, spread: number) => toDay(addDays(parseDay(iso), int(-spread, spread)));
    let checked = 0;
    for (const sunday of CLOCK_SUNDAYS) {
      for (let i = 0; i < 150; i += 1) {
        // A year that begins or ends at a clock change (and so spans the other), or one that lies inside a clock-change week.
        const mode = int(0, 2);
        const year: YearBounds =
          mode === 0
            ? { startDate: near(sunday, 4), endDate: toDay(addDays(parseDay(sunday), int(100, 330))) }
            : mode === 1
              ? { startDate: toDay(addDays(parseDay(sunday), -int(100, 330))), endDate: near(sunday, 4) }
              : { startDate: near(sunday, 3), endDate: near(sunday, 12) };
        if (year.endDate < year.startDate) continue;
        const closures: ClosedRange[] = [];
        for (let k = int(0, 4); k > 0; k -= 1) {
          const other = CLOCK_SUNDAYS[int(0, CLOCK_SUNDAYS.length - 1)]!;
          const start = near(int(0, 1) === 0 ? sunday : other, 3);
          closures.push({ startDate: start, endDate: int(0, 2) === 0 ? near(other, 3) : toDay(addDays(parseDay(start), int(0, 9))) });
        }
        const period: TeachingPeriod = { recurrence: (['ALL_WEEKS', 'ODD_WEEKS', 'EVEN_WEEKS'] as const)[int(0, 2)] };
        if (int(0, 2) === 0) period.startDate = near(sunday, 6);
        if (int(0, 2) === 0) period.endDate = near(sunday, 6);
        expect(teachingWeeksByDays(period, year, closures, null)).toBe(reference(period, year, closures, null));
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('counts the clock-change weekends as the calendar does: Mon-Fri days, whole days in UTC (worked out by hand)', () => {
    const year = (startDate: string, endDate: string): YearBounds => ({ startDate, endDate });
    // Spring 2027: the clocks go forward on Sunday 28 March. Fri 26 + Mon 29 to Fri 2 April = 6 school days.
    expect(teachingWeeksByDays({}, year('2027-03-26', '2027-04-04'), [], null)).toBeCloseTo(6 / 5, 12);
    // The Sunday itself is no school day, whether a lov claims it or not.
    expect(teachingWeeksByDays({}, year('2027-03-26', '2027-04-04'), [{ startDate: '2027-03-28', endDate: '2027-03-28' }], null)).toBeCloseTo(6 / 5, 12);
    // A lov that ends on the Sunday takes the Friday and the Saturday it holds: only the Friday is a school day.
    expect(teachingWeeksByDays({}, year('2027-03-26', '2027-04-04'), [{ startDate: '2027-03-26', endDate: '2027-03-28' }], null)).toBeCloseTo(5 / 5, 12);
    // A lov that begins on the Sunday takes the Monday after: 6 - 1.
    expect(teachingWeeksByDays({}, year('2027-03-26', '2027-04-04'), [{ startDate: '2027-03-28', endDate: '2027-03-29' }], null)).toBeCloseTo(5 / 5, 12);
    // Autumn 2027: the clocks go back on Sunday 31 October. A läsår that begins on that Sunday holds Mon 1 to Fri 5 November.
    expect(teachingWeeksByDays({}, year('2027-10-31', '2027-11-07'), [], null)).toBeCloseTo(1, 12);
    // ... and one that ends on it holds Mon 25 to Fri 29 October.
    expect(teachingWeeksByDays({}, year('2027-10-25', '2027-10-31'), [], null)).toBeCloseTo(1, 12);
    // A week that holds the change and a lov of the whole week: nothing taught.
    expect(teachingWeeksByDays({}, year('2027-10-25', '2027-10-31'), [{ startDate: '2027-10-25', endDate: '2027-10-31' }], null)).toBe(0);
    // Both clock changes in one läsår: Monday 30 August 2027 to Friday 23 June 2028 is 43 whole weeks of Monday to Friday.
    expect(teachingWeeksByDays({}, year('2027-08-30', '2028-06-23'), [], null)).toBeCloseTo(43, 12);
  });

  it('counts a läsår over a new year, overlapping lov, a lov that begins before the läsår, and no lov at all', () => {
    const year: YearBounds = { startDate: '2026-12-21', endDate: '2027-01-15' }; // Monday to Friday, over the new year: 4 weeks
    expect(teachingWeeksByDays({}, year, [], null)).toBe(4);
    expect(teachingWeeksByDays({}, year, undefined, null)).toBe(4);
    // Overlapping lov: 24 December to 6 January, and 3 to 8 January. What is left is 21-23 December and 11-15 January: 3 + 5 school days (7-8 January go with the second lov, 24 December to 1 January with the first).
    const overlapping: ClosedRange[] = [
      { startDate: '2026-12-24', endDate: '2027-01-06' },
      { startDate: '2027-01-03', endDate: '2027-01-08' },
    ];
    expect(teachingWeeksByDays({}, year, overlapping, null)).toBeCloseTo((3 + 0 + 5) / 5, 12);
    // A lov that begins before the läsår and ends inside it takes only what lies inside: 14 December to 24 December leaves 21-23 as 3 days gone.
    const before: ClosedRange[] = [{ startDate: '2026-12-14', endDate: '2026-12-22' }];
    expect(teachingWeeksByDays({}, year, before, null)).toBeCloseTo((20 - 2) / 5, 12);
    // The same cases against the old walk, with the parities and a window that is part of the year.
    for (const period of [{}, { recurrence: 'ODD_WEEKS' }, { recurrence: 'EVEN_WEEKS' }, { startDate: '2026-12-30', endDate: '2027-01-04' }] as TeachingPeriod[]) {
      for (const closures of [[], overlapping, before, [...overlapping, ...before]]) {
        expect(teachingWeeksByDays(period, year, closures, null)).toBe(reference(period, year, closures, null));
      }
    }
  });

  it('reads no local time: the function names no local-time accessor', () => {
    // The suite runs under TZ=UTC. A count that went through local time (getDay, setDate, a Date built from numbers) would pass here
    // and move on the clock-change weekends in a zone with summer time, so the source is held to UTC as well: whole days since the
    // epoch, a Date only through a string that ends in Z, and the UTC accessors.
    const source = String(teachingWeeksByDays);
    expect(source).not.toMatch(/\.(getDate|getDay|getHours|getMonth|getFullYear|setDate|setHours|setMonth|getTimezoneOffset|toLocale\w*|toString|toDateString)\(/);
  });

  /*
   * The source test above reads the text of ONE function. The weeks are counted through helpers (dayNumber, parseDay, runsInWeek,
   * isoWeekNumber), and CI runs every suite under TZ=UTC, where a helper that parsed a date in local time or asked a Date for its
   * local day gives the same answer as the UTC one: the six-zone run in the PR text is a run by hand, and a helper changed to local
   * time passes CI (a mutant of dayNumber that parses `${value}T00:00:00` with no zone survives all 68 prov under TZ=UTC and fails 11
   * to 14 of them under Europe/Stockholm and America/New_York). So the call itself is held to UTC: while it runs, Date refuses the
   * local accessors and the two ways of building a local date, and the answers must still be the old walk's.
   */
  it('reads no local time while it runs, in any helper it calls (CI runs under TZ=UTC, where local and UTC readings agree)', () => {
    const year: YearBounds = { startDate: '2026-08-15', endDate: '2027-06-11' }; // begins on a Saturday
    const closures: ClosedRange[] = [
      { startDate: '2026-10-26', endDate: '2026-10-30' },
      { startDate: '2026-12-21', endDate: '2027-01-08', minGradeLevel: 4, maxGradeLevel: 6 },
      { startDate: '2027-03-28', endDate: '2027-03-29' }, // the clock change
    ];
    const cases: [TeachingPeriod, number | null][] = [
      [{}, null],
      [{ recurrence: 'ODD_WEEKS' }, 5],
      [{ recurrence: 'EVEN_WEEKS', startDate: '2026-09-02', endDate: '2027-03-30' }, 5],
      [{ startDate: '2027-03-26', endDate: '2027-04-04' }, null],
    ];
    const expected = cases.map(([period, grade]) => reference(period, year, closures, grade));

    const RealDate = Date;
    const localAccessors = ['getDate', 'getDay', 'getHours', 'getMinutes', 'getMonth', 'getFullYear', 'setDate', 'setHours', 'setMonth', 'setFullYear', 'getTimezoneOffset', 'toLocaleDateString', 'toLocaleString', 'toDateString'] as const;
    const saved = localAccessors.map((name) => [name, Object.getOwnPropertyDescriptor(RealDate.prototype, name)!] as const);
    const refuse = (what: string) => () => {
      throw new Error(`local time: ${what}`);
    };
    const Guarded = new Proxy(RealDate, {
      construct(target, args, newTarget) {
        // new Date(ms), new Date('2027-08-16') and new Date('...Z') are UTC; new Date(y, m, d) and new Date('2027-08-16T00:00:00') are local.
        if (args.length >= 2) throw new Error('local time: new Date(parts)');
        if (typeof args[0] === 'string' && /T\d\d:\d\d/.test(args[0]) && !/(Z|[+-]\d\d:?\d\d)$/.test(args[0])) throw new Error(`local time: new Date(${args[0]})`);
        return Reflect.construct(target, args, newTarget);
      },
    });
    let got: number[] = [];
    try {
      for (const [name] of saved) Object.defineProperty(RealDate.prototype, name, { value: refuse(name), configurable: true, writable: true });
      (globalThis as { Date: DateConstructor }).Date = Guarded;
      got = cases.map(([period, grade]) => teachingWeeksByDays(period, year, closures, grade));
    } finally {
      (globalThis as { Date: DateConstructor }).Date = RealDate;
      for (const [name, descriptor] of saved) Object.defineProperty(RealDate.prototype, name, descriptor);
    }
    expect(got).toEqual(expected);
  });

  it('handles the corners by hand: a window of a weekend, one day, a year that is one Saturday, no closures at all', () => {
    const year: YearBounds = { startDate: '2027-08-16', endDate: '2028-06-09' };
    for (const period of [
      { startDate: '2027-09-04', endDate: '2027-09-05' }, // a Saturday and a Sunday: no school day
      { startDate: '2027-09-06', endDate: '2027-09-06' }, // one Monday
      { startDate: '2027-09-10', endDate: '2027-09-12' }, // a Friday to a Sunday
    ] as TeachingPeriod[]) {
      expect(teachingWeeksByDays(period, year, [], null)).toBe(reference(period, year, [], null));
    }
    expect(teachingWeeksByDays({}, { startDate: '2027-08-14', endDate: '2027-08-14' }, [], null)).toBe(0);
    expect(teachingWeeksByDays({}, year, undefined, null)).toBe(reference({}, year, [], null));
  });
});
