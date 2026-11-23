import * as weekArithmetic from './teaching-weeks';
import { scopeOfTeacher, type ScopeVersion } from './assignment-scope';
import type { LoadInput, LoadRequirement } from './teacher-load';

/*
 * What a write asks of the ordinance's arithmetic is asked of every row of the teacher, before and after, and of every row of a
 * requirements file: a day-by-day walk of the year per row. The rows are the same objects from one judgement to the next, so a row's
 * school-day weeks are asked once while nothing they depend on has changed (review of #404, H-1: 1 000 rows of a file cost 10 s).
 */
const ANNA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const YEAR = { startDate: '2026-08-17', endDate: '2027-06-11' };
const version: ScopeVersion = {
  code: 'SFS2026:1487',
  sfs: 'SFS 2026:1487',
  title: 'Förordning',
  validFrom: '2020-01-01',
  validTo: null,
  source: 'https://example.invalid/sfs',
  bands: [
    { schoolForm: 'GRUNDSKOLA', gradeNumbering: 'NIOARIG', gradeFrom: 7, gradeTo: 9, teachingHoursLow: 500, teachingHoursHigh: 600, planningFloorPercent: 110, teachingSection: '3 § p. 2', planningSection: '4 §', note: null },
  ],
};
const row = (id: string, extra: Partial<LoadRequirement> = {}): LoadRequirement => ({
  id,
  subjectId: id,
  subjectName: id,
  studentGroupId: `g-${id}`,
  groupName: id,
  teacherId: ANNA,
  coTeacherId: null,
  lessonsPerWeek: 1,
  minutesPerLesson: 60,
  teacherLoadPercent: 100,
  coTeacherLoadPercent: 100,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  gradeSpan: { min: 7, max: 7 },
  ...extra,
});
const input = (requirements: LoadRequirement[], extra: Partial<LoadInput> = {}): LoadInput => ({
  year: YEAR,
  policy: null,
  employments: [{ userId: ANNA, employmentPercent: 100, reductionPercent: 0, contractKind: 'FERIE', teachingTargetMinutesPerWeek: null, signature: null }],
  requirements,
  qualifications: [],
  closures: [],
  duties: [],
  ...extra,
});

describe('the school-day weeks of a row, asked once while nothing they depend on changes', () => {
  let spy: jest.SpyInstance;
  beforeEach(() => {
    spy = jest.spyOn(weekArithmetic, 'teachingWeeksByDays');
  });
  afterEach(() => {
    spy.mockRestore();
  });

  it('asks 25 rows once and the 26th once, however many times the teacher is asked: before and after a write cost one row, not 51', () => {
    const rows = Array.from({ length: 25 }, (_, i) => row(`r${i}`));
    const base = input(rows);
    const before = scopeOfTeacher(base, [version], ANNA)!;
    expect(spy).toHaveBeenCalledTimes(25);
    const written = row('new', { lessonsPerWeek: 2 });
    const after = scopeOfTeacher({ ...base, requirements: [...rows, written] }, [version], ANNA)!;
    expect(spy).toHaveBeenCalledTimes(26);
    scopeOfTeacher({ ...base, requirements: [...rows, written] }, [version], ANNA);
    expect(spy).toHaveBeenCalledTimes(26);
    // the same hours as the arithmetic gives: 25 lessons of 60 minutes over 43 weeks, and the row of two more
    expect([before.teachingHours, after.teachingHours]).toEqual([1075, 1161]);
  });

  it('asks again of a row whose recurrence or dates have changed in place', () => {
    const only = row('r', { lessonsPerWeek: 10 });
    const base = input([only]);
    const hours = () => scopeOfTeacher(base, [version], ANNA)!.teachingHours;
    expect(hours()).toBe(430);
    only.endDate = '2026-12-18';
    const untilDecember = hours();
    expect(untilDecember).toBeLessThan(430);
    expect(untilDecember).toBeGreaterThan(0);
    only.startDate = '2026-10-05';
    expect(hours()).toBeLessThan(untilDecember);
    only.startDate = null;
    only.endDate = null;
    expect(hours()).toBe(430);
    only.recurrence = 'ODD_WEEKS';
    expect(hours()).toBeLessThan(260);
    only.recurrence = 'ALL_WEEKS';
    expect(hours()).toBe(430);
  });

  it('asks again of the same row when the year, the closures or the year it teaches are not what they were', () => {
    const only = row('r', { lessonsPerWeek: 10 });
    const shared = [{ startDate: '2026-10-26', endDate: '2026-10-30' }];
    const hours = (over: Partial<LoadInput>) => scopeOfTeacher(input([only], { closures: shared, ...over }), [version], ANNA)!.teachingHours;
    const closedOneWeek = hours({});
    expect(closedOneWeek).toBeLessThan(430);
    // another year, the same closures array
    expect(hours({ year: { startDate: '2026-08-17', endDate: '2027-01-15' } })).toBeLessThan(closedOneWeek);
    expect(hours({})).toBe(closedOneWeek);
    // another array of the same length, closing more
    expect(hours({ closures: [{ startDate: '2026-10-26', endDate: '2026-11-06' }] })).toBeLessThan(closedOneWeek);
    expect(hours({})).toBe(closedOneWeek);
    // the same array grown in place
    shared.push({ startDate: '2026-11-02', endDate: '2026-11-06' });
    expect(hours({})).toBeLessThan(closedOneWeek);
    shared.pop();
    // a closure of one year of pupils: the row is closed while it teaches that year and not when it teaches another
    const gradeClosure = [{ startDate: '2026-10-26', endDate: '2026-11-06', minGradeLevel: 7, maxGradeLevel: 7 }];
    const closedForSeven = hours({ closures: gradeClosure });
    expect(closedForSeven).toBeLessThan(430);
    only.gradeSpan = { min: 1, max: 1 };
    expect(hours({ closures: gradeClosure })).toBe(430);
    only.gradeSpan = { min: 7, max: 7 };
    expect(hours({ closures: gradeClosure })).toBe(closedForSeven);
  });
});
