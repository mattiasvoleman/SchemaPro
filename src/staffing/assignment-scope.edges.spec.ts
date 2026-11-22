import {
  buildScopeReport,
  type ScopeBand,
  type ScopeVersion,
  type TeacherScope,
} from './assignment-scope';
import {
  DEFAULT_LOAD_POLICY,
  buildTeacherLoadReport,
  type LoadInput,
  type LoadRequirement,
} from './teacher-load';

/*
 * The edges of assignment-scope.ts that assignment-scope.spec.ts leaves open: the exact equality at which the year's working
 * time just holds the planning floor, a row that runs no week, two bands that tie on the upper edge, one interpretation shared
 * by two bands, and the order of the teachers. Each is a line a one-character change leaves green in the other spec.
 *
 * The year here is 40 weeks (Monday 2026-08-17 to Friday 2027-05-21), so that a lesson of 60 minutes a week is 40 hours and the
 * figures come out in whole hours without a decimal to hide behind.
 */
const YEAR = { startDate: '2026-08-17', endDate: '2027-05-21' };
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
const HIGH: ScopeBand = {
  ...LOW,
  gradeFrom: 7,
  gradeTo: 9,
  teachingHoursLow: 500,
  teachingHoursHigh: 600,
  planningFloorPercent: 110,
  teachingSection: '3 § p. 2',
  planningSection: '4 § p. 1 och 5 § p. 1',
};
const version = (bands: ScopeBand[]): ScopeVersion => ({
  code: 'T',
  sfs: 'SFS T',
  title: 'T',
  validFrom: '2020-01-01',
  validTo: null,
  source: 'https://example.invalid',
  bands,
});

const employment = (userId: string, overrides: Partial<LoadInput['employments'][number]> = {}): LoadInput['employments'][number] => ({
  userId,
  employmentPercent: 100,
  reductionPercent: 0,
  contractKind: 'FERIE',
  teachingTargetMinutesPerWeek: null,
  signature: userId.slice(0, 3),
  ...overrides,
});

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

const scope = (input: Partial<LoadInput>, versions: ScopeVersion[] = [version([LOW, HIGH])]) => {
  const full: LoadInput = {
    year: YEAR,
    policy: { ...DEFAULT_LOAD_POLICY, fullTimeTeachingMinutesPerWeek: 1080 },
    employments: [employment(ANNA)],
    requirements: [row({ lessonsPerWeek: 22 })],
    qualifications: [],
    closures: [],
    duties: [],
    ...input,
  };
  return buildScopeReport(full, buildTeacherLoadReport(full), versions);
};
const of = (report: ReturnType<typeof scope>, userId = ANNA): TeacherScope => report.teachers.find((teacher) => teacher.userId === userId)!;

describe('the planning floor against the year\'s working time: exactly equal still holds', () => {
  // 22 lessons × 60 min × 40 weeks = 880 h of teaching and a floor of 880 h. A ferietjänst of 1 767 h less 880 h of teaching
  // leaves 887 h; an uppdrag of 10.5 minutes a week over the 40 weeks is 7 h, so the year leaves exactly 880 h for a floor of 880 h.
  const duty = (minutesPerWeek: number) => [{ userId: ANNA, minutesPerWeek, countsAsTeaching: false }];

  it('holds when what is left is exactly the floor (a year that has no more room is not a certain no)', () => {
    const anna = of(scope({ duties: duty(10.5) }));
    expect(anna.teachingHours).toBe(880);
    expect(anna.planningFloorHours).toBe(880);
    expect(anna.remainingHours).toBe(880);
    expect(anna.planningFits).toBe(true);
  });

  it('is a certain no one tenth of an hour below it, and a yes one tenth above', () => {
    // 10.5 min/week × 40 = 7.0 h; 10.65 × 40 / 60 = 7.1 h; 10.35 × 40 / 60 = 6.9 h.
    expect(of(scope({ duties: duty(10.65) })).planningFits).toBe(false);
    expect(of(scope({ duties: duty(10.35) })).planningFits).toBe(true);
  });
});

describe('a row that runs no week', () => {
  it('adds nothing, not even a stage with no hours: a dated row inside a lov week', () => {
    const lov = { startDate: '2026-10-26', endDate: '2026-10-30' };
    const anna = of(scope({
      requirements: [row({ lessonsPerWeek: 10 }), row({ lessonsPerWeek: 4, gradeSpan: { min: 8, max: 8 }, subjectId: 'no', startDate: '2026-10-26', endDate: '2026-10-30' })],
      closures: [lov],
    }));
    // 10 lessons × 39 school weeks (the lov takes one of the 40); the dated row of åk 8 is that lov week from Monday to Friday, so it runs no day.
    expect(anna.teachingHours).toBe(390);
    expect(anna.stages.map((stage) => [stage.gradeFrom, stage.gradeTo, stage.hours])).toEqual([[1, 6, 390]]);
    expect(anna.planningFloorHours).toBe(390);
  });
});

describe('two bands that tie on the upper edge', () => {
  const tied = version([
    { ...LOW, gradeFrom: 1, gradeTo: 4, teachingHoursHigh: 600, planningFloorPercent: 100 },
    { ...LOW, gradeFrom: 5, gradeTo: 9, teachingHoursHigh: 600, planningFloorPercent: 120 },
  ]);

  it('reads a group over both in the one with the higher planning floor', () => {
    const anna = of(scope({ requirements: [row({ lessonsPerWeek: 10, gradeSpan: { min: 4, max: 5 } })] }, [tied]));
    expect(anna.stages).toHaveLength(1);
    expect(anna.stages[0]).toMatchObject({ gradeFrom: 5, gradeTo: 9, planningFloorPercent: 120 });
    expect(anna.planningFloorHours).toBe(480);
  });
});

describe('what the report says about its own reading', () => {
  it('names an interpretation once, however many bands rest on it', () => {
    const note = 'Tolkning: ett skäl.';
    const report = scope({}, [version([{ ...LOW, note }, { ...HIGH, note }])]);
    expect(report.interpretations).toEqual([{ section: '4 § p. 1', note }]);
  });

  it('lists the teachers in the order of their ids, whatever order the rows came in', () => {
    const report = scope({
      employments: [employment(BO), employment(ANNA)],
      requirements: [row({ teacherId: BO, lessonsPerWeek: 3 }), row({ teacherId: ANNA, lessonsPerWeek: 5 })],
    });
    expect(report.teachers.map((teacher) => teacher.userId)).toEqual([ANNA, BO]);
  });
});
