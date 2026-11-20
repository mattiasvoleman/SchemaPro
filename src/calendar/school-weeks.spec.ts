import { runsOn } from './lesson-recurrence';
import { closedWeeksOf, meetOnlyInClosedWeeks, readClosedWeeks, type ClosedWeeks, type HeldWeeks } from './school-weeks';
import type { PublishBreak } from './publish-days';

const DAY_MS = 86_400_000;
const day = (value: string): Date => new Date(`${value}T00:00:00.000Z`);
const iso = (date: Date): string => date.toISOString().slice(0, 10);
const addDays = (value: string, days: number): string => iso(new Date(day(value).getTime() + days * DAY_MS));
const mondayOf = (value: string): string => addDays(value, 1 - (day(value).getUTCDay() || 7));

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
const lov = (startDate: string, endDate: string, min: number | null = null, max: number | null = null): PublishBreak => ({
  startDate: day(startDate),
  endDate: day(endDate),
  minGradeLevel: min,
  maxGradeLevel: max,
});
/** The jullov of the school the review of #364 was done on: 22 December to 9 January, the whole school. */
const JULLOV = lov('2026-12-22', '2027-01-09');
const closedOf = (breaks: PublishBreak[], grades: (number | null)[] = [9]): ClosedWeeks => {
  const closed = closedWeeksOf(YEAR, { breaks, grades });
  if (!closed) throw new Error('no week is closed');
  return closed;
};

describe('closedWeeksOf', () => {
  it('is the weeks of the jullov that have no weekday of school, as Mondays', () => {
    // The week of 21 December has its Monday; the weeks of 28 December and 4 January have none.
    const closed = closedOf([JULLOV]);
    expect([...closed.mondays]).toEqual(['2026-12-28', '2027-01-04']);
    expect([closed.from, closed.to]).toEqual([YEAR.startDate, YEAR.endDate]);
  });

  it('is null for a school with no break, or none that closes a week', () => {
    expect(closedWeeksOf(YEAR, undefined)).toBeNull();
    expect(closedWeeksOf(YEAR, { breaks: [], grades: [9] })).toBeNull();
    expect(closedWeeksOf(YEAR, { breaks: [lov('2026-12-28', '2027-01-01', 1, 6)], grades: [3, 9] })).toBeNull();
    expect(closedWeeksOf(YEAR, { breaks: [lov('2026-12-28', '2026-12-31')], grades: [9] })).toBeNull();
  });
});

describe('meetOnlyInClosedWeeks', () => {
  const closed = closedOf([JULLOV]);
  const held = (startDate: string | null, endDate: string | null, recurrence: HeldWeeks['recurrence'] = 'ALL_WEEKS'): HeldWeeks => ({
    startDate,
    endDate,
    recurrence,
  });

  it('says two lessons that share only the jullov are no double booking', () => {
    // Musik to 10 January and slöjd from the 4th: the overlap is the week of 4 January, which is lov.
    expect(meetOnlyInClosedWeeks(held(null, '2027-01-10'), held('2027-01-04', null), closed)).toBe(true);
    expect(meetOnlyInClosedWeeks(held('2027-01-04', null), held(null, '2027-01-10'), closed)).toBe(true);
    // Dated to the Sunday and the Monday: no overlap at all, which weeksCanOverlap says and this leaves to it.
    expect(meetOnlyInClosedWeeks(held(null, '2027-01-03'), held('2027-01-04', null), closed)).toBe(false);
  });

  it('says a clash in a week with school is one', () => {
    // The overlap holds the week of 21 December (a Monday of school) and the lov's weeks.
    expect(meetOnlyInClosedWeeks(held(null, '2027-01-10'), held('2026-12-21', null), closed)).toBe(false);
    // The weeks of the 11th are school.
    expect(meetOnlyInClosedWeeks(held(null, '2027-01-17'), held('2027-01-04', null), closed)).toBe(false);
    // Two lessons of every week of the year.
    expect(meetOnlyInClosedWeeks(held(null, null), held(null, null), closed)).toBe(false);
    // A week that is only partly lov is a week with school.
    const partly = closedOf([lov('2026-12-28', '2027-01-07')]);
    expect(meetOnlyInClosedWeeks(held('2027-01-04', '2027-01-10'), held(null, null), partly)).toBe(false);
  });

  it('reads the parity: only the weeks both lessons run in', () => {
    // The weeks of 28 December (53) and 4 January (1) are both odd. An odd lesson meets the other there; an
    // even one does not run in either, so the pair has no week to meet in and this leaves it to weeksCanOverlap.
    expect(meetOnlyInClosedWeeks(held(null, '2027-01-10', 'ODD_WEEKS'), held('2027-01-04', null), closed)).toBe(true);
    expect(meetOnlyInClosedWeeks(held(null, '2027-01-10', 'EVEN_WEEKS'), held('2027-01-04', null), closed)).toBe(false);
    // Odd lessons that share the lov week and the school week of the 11th (week 2, even) only: the odd ones
    // meet in the lov alone, the even ones in the school week.
    expect(meetOnlyInClosedWeeks(held(null, '2027-01-17', 'ODD_WEEKS'), held('2027-01-04', null, 'ODD_WEEKS'), closed)).toBe(true);
    expect(meetOnlyInClosedWeeks(held(null, '2027-01-17', 'EVEN_WEEKS'), held('2027-01-04', null, 'EVEN_WEEKS'), closed)).toBe(false);
  });

  it('answers nothing where it cannot say: no closed week, nothing known of the läsår, the overlap outside it', () => {
    expect(meetOnlyInClosedWeeks(held(null, '2027-01-10'), held('2027-01-04', null), null)).toBe(false);
    expect(meetOnlyInClosedWeeks(held(null, '2027-01-10'), held('2027-01-04', null), undefined)).toBe(false);
    // An overlap that starts before the läsår or ends after it is not read: the lessons may meet outside it.
    expect(meetOnlyInClosedWeeks(held('2026-01-01', '2027-01-10'), held('2026-01-01', '2027-01-05'), closed)).toBe(false);
    expect(meetOnlyInClosedWeeks(held('2027-01-04', '2027-08-01'), held('2027-01-01', '2027-08-01'), closed)).toBe(false);
  });

  it('is no answer for a lesson of the weekend: a week is closed Monday to Friday, and a Saturday is written', () => {
    // A höstlov of Monday to Friday closes the week of the 26th, and leaves its Saturday and Sunday.
    const hostlov = closedOf([lov('2026-10-26', '2026-10-30')]);
    const autumn = held(null, '2026-11-01');
    const spring = held('2026-10-26', null);
    for (const weekday of [1, 2, 3, 4, 5, undefined]) {
      expect(meetOnlyInClosedWeeks(autumn, spring, hostlov, weekday)).toBe(true);
    }
    for (const weekend of [6, 7]) {
      expect(meetOnlyInClosedWeeks(autumn, spring, hostlov, weekend)).toBe(false);
    }
  });

  it('agrees with a lesson-by-lesson reading of the dates, over random windows', () => {
    const next = random(20261120);
    const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)]!;
    const seen = { onlyClosed: 0, school: 0, unsaid: 0 };
    for (let round = 0; round < 3000; round += 1) {
      const start = addDays('2026-08-10', Math.floor(next() * 14));
      const year = { startDate: start, endDate: addDays(start, 250 + Math.floor(next() * 80)) };
      const breaks = Array.from({ length: 1 + Math.floor(next() * 5) }, () => {
        const from = addDays(year.startDate, Math.floor(next() * 300));
        const span = pick<[number | null, number | null]>([[null, null], [null, null], [1, 6], [9, 9]]);
        return lov(from, addDays(from, Math.floor(next() * (next() < 0.5 ? 6 : 24))), span[0], span[1]);
      });
      const grades = Array.from({ length: 1 + Math.floor(next() * 2) }, () => pick<number | null>([null, 3, 9]));
      const worldClosed = closedWeeksOf(year, { breaks, grades });
      if (!worldClosed) continue;
      const anyDay = (): string => addDays(year.startDate, Math.floor(next() * 300) - 5);
      const window = (): HeldWeeks => {
        const kind = next();
        const recurrence = pick<HeldWeeks['recurrence']>(['ALL_WEEKS', 'ALL_WEEKS', 'ODD_WEEKS', 'EVEN_WEEKS']);
        if (kind < 0.2) return { startDate: null, endDate: null, recurrence };
        if (kind < 0.45) return { startDate: null, endDate: anyDay(), recurrence };
        if (kind < 0.7) return { startDate: anyDay(), endDate: null, recurrence };
        const from = anyDay();
        return { startDate: from, endDate: addDays(from, Math.floor(next() * 40)), recurrence };
      };
      for (let pair = 0; pair < 6; pair += 1) {
        const a = window();
        const b = window();
        const said = meetOnlyInClosedWeeks(a, b, worldClosed);
        // The oracle: every date of the läsår the two both run on (runsOn), and whether each lies in a closed week.
        const asDates = (held: HeldWeeks) => ({
          recurrence: held.recurrence,
          startDate: held.startDate ? day(held.startDate) : null,
          endDate: held.endDate ? day(held.endDate) : null,
        });
        const first = asDates(a);
        const second = asDates(b);
        const bothRun: string[] = [];
        for (let date = year.startDate; date <= year.endDate; date = addDays(date, 1)) {
          if (runsOn(first, day(date)) && runsOn(second, day(date))) bothRun.push(date);
        }
        // Outside the läsår the answer is not given: both windows start before it (a null start is its first day), or
        // both end after it.
        const [aFrom, aTo, bFrom, bTo] = [a.startDate ?? null, a.endDate ?? null, b.startDate ?? null, b.endDate ?? null];
        const reachesOut =
          (aFrom !== null && bFrom !== null && (aFrom > bFrom ? aFrom : bFrom) < year.startDate) ||
          (aTo !== null && bTo !== null && (aTo < bTo ? aTo : bTo) > year.endDate);
        if (reachesOut) {
          expect(said).toBe(false);
          seen.unsaid += 1;
          continue;
        }
        const inClosed = bothRun.length > 0 && bothRun.every((date) => worldClosed.mondays.has(mondayOf(date)));
        expect(said).toBe(inClosed);
        if (said) seen.onlyClosed += 1;
        else seen.school += 1;
      }
    }
    expect(seen.onlyClosed).toBeGreaterThan(30);
    expect(seen.school).toBeGreaterThan(1000);
    expect(seen.unsaid).toBeGreaterThan(5);
  });
});

describe('readClosedWeeks', () => {
  const tx = (breaks: unknown[], groups: unknown[] = [{ gradeLevel: 9 }]) => ({
    schoolBreak: { findMany: jest.fn().mockResolvedValue(breaks) },
    academicYear: { findUnique: jest.fn().mockResolvedValue({ startDate: day(YEAR.startDate), endDate: day(YEAR.endDate) }) },
    studentGroup: { findMany: jest.fn().mockResolvedValue(groups) },
  });

  it('reads one table for a year with no break, and the year and its groups only beside one', async () => {
    const none = tx([]);
    expect(await readClosedWeeks(none as never, 'y1')).toBeNull();
    expect(none.academicYear.findUnique).not.toHaveBeenCalled();
    expect(none.studentGroup.findMany).not.toHaveBeenCalled();

    const some = tx([JULLOV]);
    const closed = await readClosedWeeks(some as never, 'y1');
    expect([...closed!.mondays]).toEqual(['2026-12-28', '2027-01-04']);
    expect(some.schoolBreak.findMany).toHaveBeenCalledWith({
      where: { academicYearId: 'y1' },
      select: { startDate: true, endDate: true, minGradeLevel: true, maxGradeLevel: true },
    });
    expect(some.studentGroup.findMany).toHaveBeenCalledWith({ where: { academicYearId: 'y1' }, select: { gradeLevel: true } });
  });

  it('asks the year’s own groups: a class of another årskurs keeps the lov’s weeks open', async () => {
    const lower = lov('2026-12-19', '2027-01-10', 7, 9);
    expect(await readClosedWeeks(tx([lower], [{ gradeLevel: 9 }]) as never, 'y1')).not.toBeNull();
    expect(await readClosedWeeks(tx([lower], [{ gradeLevel: 9 }, { gradeLevel: 3 }]) as never, 'y1')).toBeNull();
    expect(await readClosedWeeks(tx([lower], [{ gradeLevel: 9 }, { gradeLevel: null }]) as never, 'y1')).toBeNull();
  });
});
