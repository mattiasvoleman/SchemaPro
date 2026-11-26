import { buildScopeReport, type ScopeBand, type ScopeVersion, type TeacherScope } from './assignment-scope';
import { DEFAULT_LOAD_POLICY, buildTeacherLoadReport, type LoadInput, type LoadRequirement } from './teacher-load';

/*
 * R1b: what the report says so that a card can say it right (the choices R1 left open: #387 L-2 and L-8, #397 L-1 and L-4, #399 L-5).
 *
 *   - an interpretation carries the stages it belongs to, so a card shows it to the teacher it concerns (L-2, L-4);
 *   - the hours with no band are told apart: förskoleklass (årskurs 0) is one thing, a year the lydelse has no band for another (L-5);
 *   - a year that begins before the ordinance says from when it applies (L-8, L-1).
 *
 * The year is 40 weeks (Monday 2026-08-17 to Friday 2027-05-21), so that 60 minutes a week is 40 hours.
 */
const YEAR = { startDate: '2026-08-17', endDate: '2027-05-21' };
const ANNA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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
  note: 'Tolkning: 5 § ...',
};
const version = (bands: ScopeBand[], overrides: Partial<ScopeVersion> = {}): ScopeVersion => ({
  code: 'T',
  sfs: 'SFS T',
  title: 'T',
  validFrom: '2020-01-01',
  validTo: null,
  source: 'https://example.invalid',
  bands,
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
    employments: [{ userId: ANNA, employmentPercent: 100, reductionPercent: 0, contractKind: 'FERIE', teachingTargetMinutesPerWeek: null, signature: 'ANN' }],
    requirements: [row({ lessonsPerWeek: 10 })],
    qualifications: [],
    closures: [],
    duties: [],
    ...input,
  };
  return buildScopeReport(full, buildTeacherLoadReport(full), versions);
};
const anna = (report: ReturnType<typeof scope>): TeacherScope => report.teachers.find((teacher) => teacher.userId === ANNA)!;

describe('an interpretation carries the stage it belongs to (#387 L-2, #397 L-4)', () => {
  it("names the årskurs span of the band whose note it is, so that a card of a teacher in årskurs 1-6 can leave it out", () => {
    const report = scope({});
    expect(report.interpretations).toEqual([{ section: '4 § p. 1 och 5 § p. 1', note: 'Tolkning: 5 § ...', grades: [{ from: 7, to: 9 }] }]);
  });

  it('names every stage that rests on one note, in the order of the bands', () => {
    const note = 'Tolkning: ett skäl.';
    const report = scope({}, [version([{ ...LOW, note }, { ...HIGH, note }])]);
    expect(report.interpretations.map((one) => one.grades)).toEqual([[{ from: 1, to: 6 }, { from: 7, to: 9 }]]);
  });

  it('has no interpretation for bands without a note, and names the interpretation of hours outside the stages by its cause and not by a stage', () => {
    const none = scope({}, [version([LOW, { ...HIGH, note: null }])]);
    expect(none.interpretations).toEqual([]);
    // 400 hours in the stage, under the edge of 650; 1 600 in förskoleklass, which takes the total over it and no OVER_MAX with it (T7).
    const outside = scope({ requirements: [row({ lessonsPerWeek: 10 }), row({ lessonsPerWeek: 40, gradeSpan: { min: 0, max: 0 }, subjectId: 'fk' })] });
    expect(anna(outside).overOnlyWithUnregulated).toBe(true);
    const cause = outside.interpretations.find((one) => one.cause === 'UNREGULATED_HOURS');
    expect(cause).toBeDefined();
    expect(cause).not.toHaveProperty('grades');
  });
});

describe('förskoleklass is told apart from a year no band covers (#399 L-5)', () => {
  it('counts the hours of a group of årskurs 0 as förskoleklass, in the unregulated total', () => {
    const teacher = anna(scope({ requirements: [row({ lessonsPerWeek: 10 }), row({ lessonsPerWeek: 5, gradeSpan: { min: 0, max: 0 }, subjectId: 'fk' })] }));
    expect(teacher.unregulatedHours).toBe(200);
    expect(teacher.preschoolHours).toBe(200);
  });

  it('counts the hours of a year the lydelse has no band for as unregulated and NOT as förskoleklass (a lydelse with fewer bands: R2)', () => {
    // Only årskurs 7-9 has a band; the teacher teaches årskurs 4-6 (no band) and one lesson in förskoleklass.
    const teacher = anna(
      scope({ requirements: [row({ lessonsPerWeek: 10, gradeSpan: { min: 4, max: 6 } }), row({ lessonsPerWeek: 5, gradeSpan: { min: 0, max: 0 }, subjectId: 'fk' }), row({ lessonsPerWeek: 3, gradeSpan: { min: 8, max: 8 }, subjectId: 'no' })] }, [version([HIGH])]),
    );
    expect(teacher.unregulatedHours).toBe(600);
    expect(teacher.preschoolHours).toBe(200);
    expect(teacher.stages.map((stage) => stage.hours)).toEqual([120]);
  });

  it('says nothing of förskoleklass when there are no hours outside the stages: the field is absent, and a report of such a school is the report it was', () => {
    expect(anna(scope({}))).not.toHaveProperty('preschoolHours');
  });

  it('keeps a mixed span (årskurs 0-3) in a band: it is not förskoleklass and not unregulated', () => {
    const teacher = anna(scope({ requirements: [row({ lessonsPerWeek: 10, gradeSpan: { min: 0, max: 3 } })] }));
    expect(teacher.unregulatedHours).toBe(0);
    expect(teacher).not.toHaveProperty('preschoolHours');
    expect(teacher.stages.map((stage) => stage.hours)).toEqual([400]);
  });

  it('is zero when every unregulated hour is a year no band covers, and present all the same, so that a card knows the split was made', () => {
    const teacher = anna(scope({ requirements: [row({ lessonsPerWeek: 10, gradeSpan: { min: 4, max: 6 } })] }, [version([HIGH])]));
    expect(teacher.unregulatedHours).toBe(400);
    expect(teacher.preschoolHours).toBe(0);
  });
});

describe('a year that begins before the ordinance says from when it applies (#387 L-8, #397 L-1)', () => {
  const later = version([LOW, HIGH], { code: 'later', sfs: 'SFS 2026:1487', validFrom: '2027-07-01' });

  it('names the first lydelse that holds after the year starts, for a year before every lydelse', () => {
    const report = scope({}, [later]);
    expect(report.version).toBeNull();
    expect(report.yearReason).toBe('NOT_IN_FORCE');
    expect(report.upcoming).toEqual({ sfs: 'SFS 2026:1487', validFrom: '2027-07-01' });
  });

  it('names the earliest of several later lydelser', () => {
    const report = scope({}, [version([LOW], { sfs: 'SFS B', validFrom: '2029-07-01' }), later]);
    expect(report.upcoming).toEqual({ sfs: 'SFS 2026:1487', validFrom: '2027-07-01' });
  });

  it('is absent for a year the ordinance reaches, and for a year with no lydelse at all, not null', () => {
    expect(scope({})).not.toHaveProperty('upcoming');
    const none = scope({}, []);
    expect(none.yearReason).toBe('NOT_IN_FORCE');
    expect(none).not.toHaveProperty('upcoming');
  });
});
