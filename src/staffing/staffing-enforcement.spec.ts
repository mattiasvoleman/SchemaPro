import { ConflictException } from '@nestjs/common';
import { STAFFING_FIELDS, enforceRequirementBatch, mergeRequirement, touchesStaffing } from './staffing-enforcement';
import { judgeRequirementWrite } from './staffing-checks';
import { DEFAULT_CHECK_POLICY } from './staffing-checks';
import { buildTeacherLoadReport, loadWeightOf, type LoadInput, type LoadRequirement } from './teacher-load';

const BASE = {
  id: 'req-1',
  subjectId: 'idh',
  subjectName: 'Idrott och hälsa',
  studentGroupId: 'g-7a',
  groupName: '7A',
  gradeSpan: { min: 7, max: 7 },
};

const STORED: LoadRequirement = {
  ...BASE,
  teacherId: 'anna',
  coTeacherId: null,
  lessonsPerWeek: 2,
  minutesPerLesson: 80,
  lessonLengths: [80, 40],
  teacherLoadPercent: 100,
  coTeacherLoadPercent: 100,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
};

describe('mergeRequirement', () => {
  it('keeps the stored lengths when the patch names none', () => {
    expect(mergeRequirement(STORED, BASE, { teacherId: 'bo' })).toMatchObject({
      teacherId: 'bo',
      lessonsPerWeek: 2,
      minutesPerLesson: 80,
      lessonLengths: [80, 40],
    });
  });

  it('overlays the resolved shape the writer hands in, all three fields together', () => {
    expect(
      mergeRequirement(STORED, BASE, { lessonsPerWeek: 3, minutesPerLesson: 60, lessonLengths: [] }),
    ).toMatchObject({ lessonsPerWeek: 3, minutesPerLesson: 60, lessonLengths: [] });
  });

  it('gives a create the column’s empty list', () => {
    expect(mergeRequirement(null, BASE, {})).toMatchObject({
      lessonsPerWeek: 1,
      minutesPerLesson: 60,
      lessonLengths: [],
    });
  });
});

describe('mergeRequirement under the Faktor model (C16)', () => {
  // Slöjd at 0.7 under FACTOR: Anna carries 10 × 60 of it, target 600 at 10 %.
  const ANNA = 'anna';
  const weight = loadWeightOf('FACTOR', 0.7);
  const stored: LoadRequirement = { ...STORED, lessonLengths: [], lessonsPerWeek: 10, minutesPerLesson: 60, loadWeight: weight };
  const year: LoadInput = {
    year: { startDate: '2026-08-17', endDate: '2027-06-11' },
    policy: {
      fullTimeTeachingMinutesPerWeek: 600,
      overAllocationTolerancePercent: 10,
      fullTimeRegulatedHoursPerYear: 1360,
      workDaysPerYear: 194,
      qualificationMode: 'OFF',
      loadModel: 'FACTOR',
    },
    employments: [{ userId: ANNA, employmentPercent: 100, reductionPercent: 0, contractKind: 'FERIE', teachingTargetMinutesPerWeek: null, signature: null }],
    requirements: [stored],
    qualifications: [],
    closures: [],
    duties: [],
  };
  const checks = { ...DEFAULT_CHECK_POLICY, qualificationMode: 'OFF' as const, overAllocationMode: 'REFUSE' as const, fullTimeTeachingMinutesPerWeek: 600 };

  it('carries the weight it is handed, so the row as the write leaves it is charged × the factor', () => {
    const after = mergeRequirement(stored, { ...BASE, loadWeight: weight }, { lessonsPerWeek: 12 });
    expect(after.loadWeight).toBe(0.7);
    // Without it the row would be judged unweighted: a fresh object, no weight.
    expect(mergeRequirement(stored, BASE, { lessonsPerWeek: 12 }).loadWeight).toBeUndefined();
  });

  it('judges a PATCH that keeps the subject at the report’s own counted minutes', () => {
    // 12 × 60 × 0.7 = 504 counted: under 660, no finding; the report agrees.
    const after = mergeRequirement(stored, { ...BASE, loadWeight: weight }, { lessonsPerWeek: 12 });
    expect(judgeRequirementWrite({ input: year, policy: checks, before: stored, after, subjectName: 'Slöjd' })).toEqual([]);
    const report = buildTeacherLoadReport({ ...year, requirements: [after] });
    expect(report.teachers[0]!.countedMinutesPerWeek).toBe(504);
    // 16 × 60 × 0.7 = 672 > 660: refused, and the finding's minutes are the report's.
    const heavier = mergeRequirement(stored, { ...BASE, loadWeight: weight }, { lessonsPerWeek: 16 });
    const findings = judgeRequirementWrite({ input: year, policy: checks, before: stored, after: heavier, subjectName: 'Slöjd' });
    expect(findings.map((f) => f.params.minutes)).toEqual([672]);
    expect(buildTeacherLoadReport({ ...year, requirements: [heavier] }).teachers[0]!.countedMinutesPerWeek).toBe(672);
  });

  it('weighs a row moved to another subject at THAT subject’s factor', () => {
    // The same 16 lessons in a subject at 1.2 charge 1 152.
    const moved = mergeRequirement(stored, { ...BASE, subjectId: 'sv', loadWeight: loadWeightOf('FACTOR', 1.2) }, { lessonsPerWeek: 16 });
    const findings = judgeRequirementWrite({ input: year, policy: checks, before: stored, after: moved, subjectName: 'Svenska' });
    expect(findings.map((f) => f.params.minutes)).toEqual([1152]);
  });
});

describe('touchesStaffing', () => {
  it('counts the lengths as a staffing field: they change what a row charges', () => {
    expect(STAFFING_FIELDS).toContain('lessonLengths');
    expect(touchesStaffing({ lessonLengths: [] })).toBe(true);
    expect(touchesStaffing({ minutesBefore: 10 })).toBe(false);
  });
});

describe('enforceRequirementBatch', () => {
  const year = (): LoadInput => ({
    year: { startDate: '2026-08-17', endDate: '2027-06-11' },
    policy: null,
    employments: [
      { userId: 'anna', employmentPercent: 100, reductionPercent: 0, contractKind: 'FERIE', teachingTargetMinutesPerWeek: 280, signature: null },
    ],
    requirements: [
      { ...STORED, id: 'r1', teacherId: null, lessonLengths: [] },
      { ...STORED, id: 'r2', teacherId: null, lessonLengths: [] },
    ],
    qualifications: [{ userId: 'bo', subjectId: 'idh', minGradeLevel: 1, maxGradeLevel: 9, kind: 'BEHORIG', validFrom: null, validTo: null }],
    closures: [],
    duties: [],
  });
  const names = (id: string) => (id === 'r1' ? 'Idrott och hälsa för 7A' : 'Idrott och hälsa för 7B');
  const changes = [
    { requirementId: 'r2', teacherId: 'anna' },
    { requirementId: 'r1', teacherId: 'anna' },
  ];

  it('refuses with the code, the params plus whom and which row, and the row’s name before the sentence', () => {
    const policy = { ...DEFAULT_CHECK_POLICY, qualificationMode: 'OFF' as const, overAllocationMode: 'REFUSE' as const };
    let thrown: unknown;
    try {
      enforceRequirementBatch({ input: year(), policy, postsLocked: 1, changes, rowName: names });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConflictException);
    expect((thrown as ConflictException).getResponse()).toEqual({
      message:
        'Idrott och hälsa för 7A: Läraren skulle få 320 min/v mot riktmärket 280 min/v (gränsen är 308 min/v med 10 % tolerans).',
      code: 'STAFF_TEACHER_OVER_TARGET',
      params: { role: 'TEACHER', minutes: 320, target: 280, limit: 308, tolerance: 10, userId: 'anna', requirementId: 'r1' },
    });
  });

  it('hands back WARNs with whom and every row', () => {
    const warnings = enforceRequirementBatch({ input: year(), policy: DEFAULT_CHECK_POLICY, postsLocked: 1, changes, rowName: names });
    expect(warnings).toEqual([
      { code: 'STAFF_TEACHER_NOT_QUALIFIED', params: { role: 'TEACHER', subject: 'Idrott och hälsa', grades: '7' }, userId: 'anna', requirementIds: ['r1'] },
      { code: 'STAFF_TEACHER_NOT_QUALIFIED', params: { role: 'TEACHER', subject: 'Idrott och hälsa', grades: '7' }, userId: 'anna', requirementIds: ['r2'] },
      expect.objectContaining({ code: 'STAFF_TEACHER_OVER_TARGET', userId: 'anna', requirementIds: ['r1', 'r2'] }),
    ]);
  });

  it('asks no load question when no post was locked, and nothing when the policy asks nothing', () => {
    const refuseLoad = { ...DEFAULT_CHECK_POLICY, qualificationMode: 'OFF' as const, overAllocationMode: 'REFUSE' as const };
    expect(enforceRequirementBatch({ input: year(), policy: refuseLoad, postsLocked: 0, changes, rowName: names })).toEqual([]);
    const off = { ...DEFAULT_CHECK_POLICY, qualificationMode: 'OFF' as const, overAllocationMode: 'OFF' as const };
    expect(enforceRequirementBatch({ input: year(), policy: off, postsLocked: 1, changes, rowName: names })).toEqual([]);
  });
});
