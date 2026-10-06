import fixture from './__fixtures__/teaching-weeks-cases.json';
import { runsOn } from '../calendar/lesson-recurrence';
import {
  peakPerWeekByKey,
  teachingWeeks,
  weeksInPeriod,
  type ClosedRange,
  type TeachingPeriod,
  type YearBounds,
} from './teaching-weeks';

/**
 * One week arithmetic, implemented twice, checked against one list of cases.
 *
 * web/lib/teaching-hours.ts counts a group's hours in the browser; this module
 * counts a teacher's standardvecka in the gateway. If the two disagree, the
 * rektor's timplan page and the staffing matrix show different hours for the
 * same requirement, and nobody can tell which to believe. Neither suite can see
 * the other, so both replay src/staffing/__fixtures__/teaching-weeks-cases.json
 * — the web in teaching-hours.contract.test.ts. Fix the code, not the fixture,
 * and add a case for both sides at once.
 *
 * The second block pins the port to the gateway's own `runsOn`, day by day:
 * a week counts exactly when some day of the year in it is a day the
 * publisher would materialise a lesson on. That is the oracle the web suite
 * uses too, transcribed there; here it is the real function.
 */

interface FixtureCase {
  name: string;
  period: TeachingPeriod;
  closures: ClosedRange[];
  gradeLevel: number | null;
  weeksInPeriod: number;
  teachingWeeks: number;
}

const { year, cases } = fixture as { year: YearBounds; cases: FixtureCase[] };

describe('teaching weeks agree with the shared fixture', () => {
  it('has cases to replay', () => {
    expect(cases.length).toBeGreaterThan(15);
    expect(cases.some((entry) => entry.teachingWeeks !== entry.weeksInPeriod)).toBe(true);
    expect(cases.some((entry) => entry.weeksInPeriod === 0)).toBe(true);
  });

  it.each(cases.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    expect(weeksInPeriod(entry.period, year)).toBe(entry.weeksInPeriod);
    expect(teachingWeeks(entry.period, year, entry.closures, entry.gradeLevel)).toBeCloseTo(
      entry.teachingWeeks,
      10,
    );
  });
});

describe('weeksInPeriod agrees with runsOn counted day by day', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const asDate = (value: string | null | undefined) =>
    value ? new Date(`${value}T00:00:00.000Z`) : null;

  /** The Thursday of the ISO week, a week identity two ISO years cannot share. */
  const thursdayOf = (date: Date): string => {
    const weekday = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
    return new Date(date.getTime() + (4 - weekday) * DAY_MS).toISOString().slice(0, 10);
  };

  const weeksByCountingDays = (period: TeachingPeriod): number => {
    const window = {
      recurrence: period.recurrence ?? null,
      startDate: asDate(period.startDate),
      endDate: asDate(period.endDate),
    };
    const weeks = new Set<string>();
    const end = new Date(`${year.endDate}T00:00:00.000Z`).getTime();
    for (let t = new Date(`${year.startDate}T00:00:00.000Z`).getTime(); t <= end; t += DAY_MS) {
      const day = new Date(t);
      if (runsOn(window, day)) weeks.add(thursdayOf(day));
    }
    return weeks.size;
  };

  it.each(cases.map((entry) => [entry.name, entry.period] as const))(
    '%s',
    (_name, period) => {
      expect(weeksInPeriod(period, year)).toBe(weeksByCountingDays(period));
    },
  );
});

describe('peakPerWeekByKey', () => {
  const minutes = (item: { lessonsPerWeek: number; minutesPerLesson: number }) =>
    item.lessonsPerWeek * item.minutesPerLesson;

  it('never adds opposite parities, does add the same parity', () => {
    const peaks = peakPerWeekByKey(
      [
        { key: 'anna', recurrence: 'ODD_WEEKS' as const, lessonsPerWeek: 2, minutesPerLesson: 60 },
        { key: 'anna', recurrence: 'EVEN_WEEKS' as const, lessonsPerWeek: 3, minutesPerLesson: 60 },
        { key: 'bo', recurrence: 'ODD_WEEKS' as const, lessonsPerWeek: 2, minutesPerLesson: 60 },
        { key: 'bo', recurrence: 'ODD_WEEKS' as const, lessonsPerWeek: 3, minutesPerLesson: 60 },
      ],
      year,
      (item) => item.key,
      minutes,
    );
    expect(peaks.get('anna')).toBe(180);
    expect(peaks.get('bo')).toBe(300);
  });

  it('finds the week a term course and a year course collide in', () => {
    const peaks = peakPerWeekByKey(
      [
        { key: 'anna', lessonsPerWeek: 10, minutesPerLesson: 60 },
        { key: 'anna', lessonsPerWeek: 4, minutesPerLesson: 60, startDate: '2026-09-01', endDate: '2026-12-18' },
        { key: 'anna', lessonsPerWeek: 4, minutesPerLesson: 60, startDate: '2027-01-11' },
      ],
      year,
      (item) => item.key,
      minutes,
    );
    // The two term courses never share a week, so the peak is one of them plus
    // the year course, not both.
    expect(peaks.get('anna')).toBe(840);
  });

  it('answers 0 for a key whose only requirement misses the year', () => {
    const peaks = peakPerWeekByKey(
      [{ key: 'anna', lessonsPerWeek: 2, minutesPerLesson: 60, startDate: '2027-08-01' }],
      year,
      (item) => item.key,
      minutes,
    );
    expect(peaks.get('anna')).toBe(0);
  });
});
