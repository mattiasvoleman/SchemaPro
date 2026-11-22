import { buildScopeReport, UNREGULATED_HOURS_INTERPRETATION, type ScopeBand, type ScopeVersion, type TeacherScope } from './assignment-scope';
import { DEFAULT_LOAD_POLICY, buildTeacherLoadReport, type LoadInput, type LoadRequirement } from './teacher-load';

/*
 * The edges of the cause for hours outside the stages (T7) that assignment-scope.spec.ts leaves open: the printed figure that
 * is exactly the edge, the rektor's own level judged on the total (and at equality), one teacher with the cause beside one
 * without, and the working time that is left after ALL the teaching. Each is a line a one-character change leaves green there.
 *
 * The year is the one that spec uses: 43 weeks, so a lesson of 60 minutes a week is 43 hours and a lesson of 7 minutes 5,0 hours.
 */
const YEAR = { startDate: '2026-08-17', endDate: '2027-06-11' };
const ANNA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const LOW: ScopeBand = {
  schoolForm: 'GRUNDSKOLA',
  gradeNumbering: 'NIOARIG',
  gradeFrom: 1,
  gradeTo: 6,
  teachingHoursLow: 550,
  teachingHoursHigh: 650,
  planningFloorPercent: 100,
  teachingSection: '3 § p. 1',
  planningSection: '4 § p. 1',
  note: null,
};
const VERSION: ScopeVersion = {
  code: 'T',
  sfs: 'SFS T',
  title: 'T',
  validFrom: '2020-01-01',
  validTo: null,
  source: 'https://example.invalid',
  bands: [LOW],
};

let seq = 0;
const row = (overrides: Partial<LoadRequirement> = {}): LoadRequirement => ({
  id: `req-${(seq += 1)}`,
  subjectId: 'ma',
  subjectName: 'Matematik',
  studentGroupId: 'g-5a',
  groupName: '5A',
  teacherId: ANNA,
  coTeacherId: null,
  lessonsPerWeek: 1,
  minutesPerLesson: 60,
  teacherLoadPercent: 100,
  coTeacherLoadPercent: 100,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  gradeSpan: { min: 4, max: 6 },
  ...overrides,
});
const inStage = (lessons: number, teacherId = ANNA) => row({ lessonsPerWeek: lessons, teacherId });
const preschool = (lessons: number, minutes = 60, teacherId = ANNA) =>
  row({ lessonsPerWeek: lessons, minutesPerLesson: minutes, teacherId, studentGroupId: 'g-f', groupName: 'F', gradeSpan: { min: 0, max: 0 } });

const scope = (requirements: LoadRequirement[], options: Parameters<typeof buildScopeReport>[3] = {}, users: string[] = [ANNA]) => {
  const full: LoadInput = {
    year: YEAR,
    policy: { ...DEFAULT_LOAD_POLICY, fullTimeTeachingMinutesPerWeek: 1080 },
    employments: users.map((userId) => ({
      userId,
      employmentPercent: 100,
      reductionPercent: 0,
      contractKind: 'FERIE' as const,
      teachingTargetMinutesPerWeek: null,
      signature: userId.slice(0, 3),
    })),
    requirements,
    qualifications: [],
    closures: [],
    duties: [],
  };
  return buildScopeReport(full, buildTeacherLoadReport(full), [VERSION], options);
};
const of = (report: ReturnType<typeof scope>, userId = ANNA): TeacherScope => report.teachers.find((teacher) => teacher.userId === userId)!;

describe('a printed figure that is exactly the edge is not over it, with förskoleklass counted in', () => {
  it('650,0 h in all is not past 650,0 h: 645 h in the stage and 7 minutes a week of förskoleklass (5,0 h)', () => {
    const anna = of(scope([inStage(15), preschool(1, 7)]));
    expect(anna.teachingHours).toBe(650);
    expect(anna.verdict).toBe('INSIDE');
    expect('overOnlyWithUnregulated' in anna).toBe(false);
  });

  it('is past it a tenth above: 8 minutes a week is 5,7 h and 650,7 h in all', () => {
    const anna = of(scope([inStage(15), preschool(1, 8)]));
    expect(anna.teachingHours).toBe(650.7);
    expect(anna.overOnlyWithUnregulated).toBe(true);
  });
});

describe('the rektor\'s own level is judged on the total', () => {
  // 12 lessons are 516 h in the stage and 2 lessons of förskoleklass 86 h: 602 h in all, under the edge of 650 h.
  const mixed = [inStage(12), preschool(2)];

  it('puts a teacher over a level of 560 that only the hours outside the stages take her past, and says no cause: she is under the edge', () => {
    const anna = of(scope(mixed, { ownLevelHours: new Map([[ANNA, 560]]) }));
    expect(anna.teachingHours).toBe(602);
    expect(anna.verdict).toBe('OVER_OWN');
    expect('overOnlyWithUnregulated' in anna).toBe(false);
  });

  it('does not put her over a level equal to her total: 602,0 h is not over 602,0 h', () => {
    expect(of(scope(mixed, { ownLevelHours: new Map([[ANNA, 602]]) })).verdict).toBe('INSIDE');
  });
});

describe('the interpretation follows the teachers, not the school', () => {
  it('is carried once when one teacher has the cause and another has not', () => {
    const report = scope([inStage(15), preschool(1), inStage(10, BO)], {}, [ANNA, BO]);
    expect(of(report, ANNA).overOnlyWithUnregulated).toBe(true);
    expect(of(report, BO).overOnlyWithUnregulated).toBeUndefined();
    expect(report.interpretations.filter((one) => one.cause === 'UNREGULATED_HOURS')).toEqual([UNREGULATED_HOURS_INTERPRETATION]);
  });
});

describe('time is time for the year\'s working time', () => {
  it('leaves what is left after ALL the teaching, förskoleklass included: 1 767 - 688 = 1 079 h', () => {
    const anna = of(scope([inStage(15), preschool(1)]));
    expect(anna.teachingHours).toBe(688);
    expect(anna.remainingHours).toBe(1079);
  });
});
