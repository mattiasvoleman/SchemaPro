import { ConflictException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { createTxMock, type TxMock } from '../../test/utils/prisma-mock';
import type { GradeNumbering } from '../common/grade-numbering';
import {
  STAFFING_FIELDS,
  enforceRequirementBatch,
  lessonQualificationFindings,
  mergeRequirement,
  readCheckPolicy,
  touchesStaffing,
} from './staffing-enforcement';
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

describe('readCheckPolicy', () => {
  // Roller i skolan: the policy carries whether its reader may see when a
  // post changes during the year, and the findings' wording follows it.
  const txWith = (row: object | null) =>
    ({ staffingPolicy: { findUnique: jest.fn().mockResolvedValue(row) } }) as unknown as PrismaClient;

  it("carries the reader's showsPeriods, with the school's row and with the table's defaults", async () => {
    const row = {
      qualificationMode: 'REFUSE',
      overAllocationMode: 'WARN',
      overAllocationTolerancePercent: 5,
      fullTimeTeachingMinutesPerWeek: 1000,
      unstaffedGeneration: 'ALLOW',
    };
    await expect(readCheckPolicy(txWith(row), 'school', false)).resolves.toEqual({ ...row, showsPeriods: false });
    await expect(readCheckPolicy(txWith(row), 'school', true)).resolves.toEqual({ ...row, showsPeriods: true });
    await expect(readCheckPolicy(txWith(null), 'school', false)).resolves.toEqual({
      ...DEFAULT_CHECK_POLICY,
      unstaffedGeneration: 'ALLOW',
      showsPeriods: false,
    });
  });
});

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

/*
 * lessonQualificationFindings in a tioårig läsår (SFS 2025:729). The lesson's
 * span is its year's — a 10A is 10 — and the behörighet is stated in NIOARIG,
 * so the span is read through the year's numbering: a "7–9" holds the tioårig
 * 10A (NIOARIG 9) and not the 11 (NIOARIG 10). The numbering comes from the
 * caller (the vikarie path has read the year), else with the year the window
 * is read from (the master-lesson PATCH), else alone beside a window. The
 * finding names the årskurser as the year numbers them.
 */
describe('lessonQualificationFindings and the läsår’s numbering', () => {
  const G10 = 'g-10a';
  const G11 = 'g-11a';
  const YEAR_ID = 'year-1';
  let tx: TxMock;

  /** The year row as Prisma answers it: only the selected columns. */
  const storeYear = (gradeNumbering: GradeNumbering | null) => {
    const row: Record<string, unknown> | null =
      gradeNumbering === null
        ? null
        : {
            startDate: new Date('2028-08-21T00:00:00.000Z'),
            endDate: new Date('2029-06-15T00:00:00.000Z'),
            gradeNumbering,
          };
    tx.academicYear.findUnique.mockImplementation((query: { select: Record<string, boolean> }) =>
      Promise.resolve(
        row && Object.fromEntries(Object.keys(query.select).filter((key) => query.select[key]).map((key) => [key, row[key]])),
      ),
    );
  };

  beforeEach(() => {
    tx = createTxMock();
    // No policy row: the defaults, qualificationMode WARN.
    tx.staffingPolicy.findUnique.mockResolvedValue(null);
    tx.teacherSubjectQualification.findMany.mockResolvedValue([
      { userId: 'anna', subjectId: 'ma', minGradeLevel: 7, maxGradeLevel: 9, kind: 'LEGITIMATION', validFrom: null, validTo: null },
    ]);
    tx.subject.findUnique.mockResolvedValue({ name: 'Matematik' });
    // Two classes with no pupils on the roster: each one's own årskurs is its span.
    tx.studentGroup.findMany.mockResolvedValue([
      { id: G10, gradeLevel: 10 },
      { id: G11, gradeLevel: 11 },
    ]);
  });

  const ask = (groupId: string, extra: { window?: { startDate: string; endDate: string }; gradeNumbering?: GradeNumbering } = {}) =>
    lessonQualificationFindings(tx as unknown as PrismaClient, {
      schoolId: 'school',
      academicYearId: YEAR_ID,
      subjectId: 'ma',
      groupIds: [groupId],
      assignees: [{ userId: 'anna', role: 'TEACHER' }],
      rosters: { kind: 'CURRENT' },
      ...extra,
    });
  const notQualified = (grades: string, role = 'TEACHER') => [
    { code: 'STAFF_TEACHER_NOT_QUALIFIED', mode: 'WARN', userId: 'anna', params: { role, subject: 'Matematik', grades } },
  ];

  it('without a window, reads the numbering with the läsår: a tioårig 10A passes a 7–9, its 11 is named "11"', async () => {
    storeYear('TIOARIG');
    await expect(ask(G10)).resolves.toEqual([]);
    await expect(ask(G11)).resolves.toEqual(notQualified('11'));
    // One read of the year, the numbering on it; never a second for the numbering alone.
    expect(tx.academicYear.findUnique).toHaveBeenCalledTimes(2);
    for (const [query] of tx.academicYear.findUnique.mock.calls) {
      expect(query).toEqual({ where: { id: YEAR_ID }, select: { startDate: true, endDate: true, gradeNumbering: true } });
    }
  });

  it('judges a nioårig läsår raw, as it always did: its 10 is past a 7–9', async () => {
    storeYear('NIOARIG');
    await expect(ask(G10)).resolves.toEqual(notQualified('10'));
  });

  it('with a window and no numbering, reads the year’s numbering alone; a year it cannot see is nioårig', async () => {
    const day = { startDate: '2028-09-04', endDate: '2028-09-04' };
    storeYear('TIOARIG');
    await expect(ask(G10, { window: day })).resolves.toEqual([]);
    expect(tx.academicYear.findUnique).toHaveBeenCalledWith({ where: { id: YEAR_ID }, select: { gradeNumbering: true } });

    storeYear(null);
    await expect(ask(G10, { window: day })).resolves.toEqual(notQualified('10'));
  });

  it('with the caller’s numbering and a window, reads no year at all and judges through what it was handed', async () => {
    const day = { startDate: '2028-09-04', endDate: '2028-09-04' };
    await expect(ask(G10, { window: day, gradeNumbering: 'TIOARIG' })).resolves.toEqual([]);
    await expect(ask(G11, { window: day, gradeNumbering: 'TIOARIG' })).resolves.toEqual(notQualified('11'));
    await expect(ask(G10, { window: day, gradeNumbering: 'NIOARIG' })).resolves.toEqual(notQualified('10'));
    expect(tx.academicYear.findUnique).not.toHaveBeenCalled();
  });

  it('still reads validity on the window in a tioårig läsår: a behörighet starting after the day is not held', async () => {
    tx.teacherSubjectQualification.findMany.mockResolvedValue([
      { userId: 'anna', subjectId: 'ma', minGradeLevel: 7, maxGradeLevel: 9, kind: 'LEGITIMATION', validFrom: new Date('2028-09-05T00:00:00.000Z'), validTo: null },
    ]);
    const day = { startDate: '2028-09-04', endDate: '2028-09-04' };
    await expect(ask(G10, { window: day, gradeNumbering: 'TIOARIG' })).resolves.toEqual(notQualified('10'));
    await expect(
      ask(G10, { window: { startDate: '2028-09-05', endDate: '2028-09-05' }, gradeNumbering: 'TIOARIG' }),
    ).resolves.toEqual([]);
  });
});
