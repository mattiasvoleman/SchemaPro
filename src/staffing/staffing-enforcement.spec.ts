import { ConflictException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import { WORLD_YEAR, givenStaffingWorld, type StaffingWorld } from '../../test/utils/staffing-world';
import type { GradeNumbering } from '../common/grade-numbering';
import {
  RequirementImportChecks,
  STAFFING_FIELDS,
  enforceRequirementBatch,
  enforceRequirementWrite,
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

  describe('a subject that takes its behörighet from another (Behörighet som i ett annat ämne)', () => {
    // The lesson is in "ma"; Anna holds the SO-like source "so" alone.
    const holdsSource = (pointsAt: string | null) => {
      tx.subject.findMany.mockResolvedValue([{ id: 'ma', qualificationSubjectId: pointsAt }]);
      tx.teacherSubjectQualification.findMany.mockResolvedValue([
        { userId: 'anna', subjectId: 'so', minGradeLevel: 7, maxGradeLevel: 9, kind: 'LEGITIMATION', validFrom: null, validTo: null },
      ]);
    };

    it('says nothing of a teacher who holds the source for the class, which the report agrees with', async () => {
      storeYear('TIOARIG');
      holdsSource('so');
      await expect(ask(G10)).resolves.toEqual([]);
    });

    it('still warns when the subject takes its behörighet from none: the warning the pointer removes', async () => {
      storeYear('TIOARIG');
      holdsSource(null);
      await expect(ask(G10)).resolves.toEqual(notQualified('10'));
    });
  });
});

/*
 * A timplanspost write and a requirements file in a tioårig läsår (SFS
 * 2025:729). Both judge on readLoadInput's year, which carries the numbering
 * when it is tioårig, so under REFUSE a 7–9 teacher on a tioårig 10A is no
 * refusal and her 11 is one, named as the läsår numbers it. A nioårig läsår —
 * the numbering stored or absent — refuses its 10 as it always did.
 */
describe('enforceRequirementWrite and RequirementImportChecks and the läsår’s numbering', () => {
  const ANNA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const MA = 'ma';
  const G10 = 'g-10a';
  const G11 = 'g-11a';
  const TIOARIG: StaffingWorld['year'] = {
    ...WORLD_YEAR,
    startDate: new Date('2028-08-21T00:00:00.000Z'),
    endDate: new Date('2029-06-15T00:00:00.000Z'),
    gradeNumbering: 'TIOARIG',
  };
  const NIOARIG: StaffingWorld['year'] = { ...WORLD_YEAR, gradeNumbering: 'NIOARIG' };
  let tx: TxMock;

  beforeEach(() => {
    tx = createTxMock();
  });

  // Behörighet only: the load question is OFF, so no post is locked or read.
  const arrange = (year: StaffingWorld['year']) =>
    givenStaffingWorld(tx, {
      policy: { qualificationMode: 'REFUSE', overAllocationMode: 'OFF' },
      year,
      groups: [
        { id: G10, name: '10A', gradeLevel: 10 },
        { id: G11, name: '11A', gradeLevel: 11 },
      ],
      subjects: [{ id: MA, name: 'Matematik' }],
      qualifications: [{ userId: ANNA, subjectId: MA, minGradeLevel: 7, maxGradeLevel: 9 }],
    });
  const create = (studentGroupId: string) =>
    enforceRequirementWrite(tx as unknown as PrismaClient, {
      viewer: testUser(),
      showsPeriods: true,
      schoolId: 'school',
      academicYearId: WORLD_YEAR.id,
      requirementId: null,
      subjectId: MA,
      studentGroupId,
      before: null,
      patch: { teacherId: ANNA, lessonsPerWeek: 2 },
    });
  const refusal = (grades: string) => ({
    status: 409,
    response: {
      code: 'STAFF_TEACHER_NOT_QUALIFIED',
      params: { role: 'TEACHER', subject: 'Matematik', grades },
      message: `Läraren saknar behörighet i Matematik för åk ${grades}.`,
    },
  });

  it('a timplanspost write passes the 7–9 teacher on a tioårig 10A under REFUSE, and refuses her on the 11 as åk 11', async () => {
    arrange(TIOARIG);
    await expect(create(G10)).resolves.toEqual([]);
    await expect(create(G11)).rejects.toMatchObject(refusal('11'));
  });

  it('a timplanspost write in a nioårig läsår, the numbering stored or absent, refuses her 10 as åk 10', async () => {
    for (const year of [NIOARIG, WORLD_YEAR]) {
      arrange(year);
      await expect(create(G10)).rejects.toMatchObject(refusal('10'));
    }
  });

  it('a requirements file judges its rows on the same year: the tioårig 10A passes, the 11A is refused as åk 11', async () => {
    const judged = async (year: StaffingWorld['year']) => {
      arrange(year);
      const checks = await RequirementImportChecks.open(tx as unknown as PrismaClient, {
        viewer: testUser(),
        showsPeriods: true,
        schoolId: 'school',
        academicYearId: WORLD_YEAR.id,
        teacherIds: [ANNA],
        groupIds: [G10, G11],
      });
      return (studentGroupId: string, groupName: string, rowNumber: number) =>
        checks!.judge({
          requirementId: null,
          rowNumber,
          subjectId: MA,
          subjectName: 'Matematik',
          studentGroupId,
          groupName,
          patch: { teacherId: ANNA },
        }).findings;
    };
    const notQualified = (grades: string) => [
      { code: 'STAFF_TEACHER_NOT_QUALIFIED', mode: 'REFUSE', userId: ANNA, params: { role: 'TEACHER', subject: 'Matematik', grades } },
    ];

    const tioarig = await judged(TIOARIG);
    expect(tioarig(G10, '10A', 2)).toEqual([]);
    expect(tioarig(G11, '11A', 3)).toEqual(notQualified('11'));

    for (const year of [NIOARIG, WORLD_YEAR]) {
      expect((await judged(year))(G10, '10A', 2)).toEqual(notQualified('10'));
    }
  });
});

/*
 * The ordinance's highest level of teaching time (SFS 2026:1487 3 §) at the writes: STAFF_TEACHER_OVER_SCOPE through the single
 * write and the requirements file. Anna is a full-time ferietjänst in årskurs 7 (upper edge 600 h) in the default year of 43 weeks, so
 * 13 lessons a week of 60 minutes are 559 h and 14 are 602.
 */
describe('enforceRequirementWrite and RequirementImportChecks and the ordinance\'s highest level', () => {
  const ANNA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const MA = 'ma';
  const G7 = 'g-7a';
  let tx: TxMock;
  let world: ReturnType<typeof givenStaffingWorld>;

  const band = (overrides: Record<string, unknown>) => ({
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
    ...overrides,
  });
  const ordinance = (validFrom: string) => ({
    code: 'SFS2026:1487',
    sfs: 'SFS 2026:1487',
    title: 'Förordning',
    validFrom: new Date(`${validFrom}T00:00:00.000Z`),
    validTo: null,
    source: 'https://example.invalid/sfs',
    bands: [band({}), band({ gradeFrom: 7, gradeTo: 9, teachingHoursLow: 500, teachingHoursHigh: 600, planningFloorPercent: 110, teachingSection: '3 § p. 2' })],
  });

  beforeEach(() => {
    tx = createTxMock();
  });

  const arrange = (policy: Record<string, unknown>, extra: { employments?: boolean; validFrom?: string } = {}) => {
    // The database picks the lydelse that holds on the year's first day (2026-08-17): none when it begins later.
    const validFrom = extra.validFrom ?? '2020-01-01';
    const { bands, ...version } = ordinance(validFrom);
    tx.assignmentScopeVersion.findFirst.mockResolvedValue(validFrom <= '2026-08-17' ? { id: 'version-1', ...version } : null);
    tx.assignmentScopeBand.findMany.mockResolvedValue(bands);
    world = givenStaffingWorld(tx, {
      policy: { qualificationMode: 'OFF', overAllocationMode: 'OFF', ...policy },
      employments: extra.employments === false ? [] : [{ id: 'emp-anna', userId: ANNA }],
      groups: [{ id: G7, name: '7A', gradeLevel: 7 }],
      subjects: [{ id: MA, name: 'Matematik' }],
    });
  };
  const create = (lessonsPerWeek: number) =>
    enforceRequirementWrite(tx as unknown as PrismaClient, {
      viewer: testUser(),
      showsPeriods: true,
      schoolId: 'school',
      academicYearId: WORLD_YEAR.id,
      requirementId: null,
      subjectId: MA,
      studentGroupId: G7,
      before: null,
      patch: { teacherId: ANNA, lessonsPerWeek, minutesPerLesson: 60 },
    });

  it('refuses under REFUSE a row that takes the teacher past the edge, with the hours and the limit, and passes one that does not', async () => {
    arrange({ assignmentScopeMode: 'REFUSE' });
    await expect(create(13)).resolves.toEqual([]);
    await expect(create(14)).rejects.toMatchObject({
      status: 409,
      response: {
        code: 'STAFF_TEACHER_OVER_SCOPE',
        params: { role: 'TEACHER', hours: '602', limit: '600' },
        message: 'Läraren skulle få 602 timmars undervisning under läsåret mot förordningens högsta nivå 600 timmar (SFS 2026:1487 3 §).',
      },
    });
  });

  it('saves and warns under WARN, with the code and the params beside the row', async () => {
    arrange({ assignmentScopeMode: 'WARN' });
    await expect(create(14)).resolves.toEqual([
      { code: 'STAFF_TEACHER_OVER_SCOPE', params: { role: 'TEACHER', hours: '602', limit: '600' } },
    ]);
  });

  it('asks nothing under OFF: no post is locked and the lydelser are not read', async () => {
    arrange({ assignmentScopeMode: 'OFF' });
    await expect(create(14)).resolves.toEqual([]);
    expect(world.locked).toEqual([]);
    expect(tx.assignmentScopeVersion.findFirst).not.toHaveBeenCalled();
  });

  it('locks the teacher\'s post before it reads the year, for this question alone, and reads the lydelser after the lock', async () => {
    arrange({ assignmentScopeMode: 'WARN' });
    await create(13);
    expect(world.locked).toEqual([['emp-anna']]);
    expect(world.order.indexOf('lock')).toBeLessThan(world.order.indexOf('year'));
    expect(tx.assignmentScopeVersion.findFirst).toHaveBeenCalledTimes(1);
  });

  it('asks nothing of a teacher with no post (no span to scale), and reads no lydelse for it', async () => {
    arrange({ assignmentScopeMode: 'REFUSE' }, { employments: false });
    await expect(create(14)).resolves.toEqual([]);
    expect(tx.assignmentScopeVersion.findFirst).not.toHaveBeenCalled();
  });

  it('asks nothing in a läsår the ordinance does not reach', async () => {
    arrange({ assignmentScopeMode: 'REFUSE' }, { validFrom: '2027-07-01' });
    await expect(create(14)).resolves.toEqual([]);
  });

  describe('the rektor\'s assessments of the year (AssignmentScopeAssessments)', () => {
    const stored = (exceptionKind: 'OWN_INITIATIVE' | 'SMALL_GROUP' | null, level: number | null = null) => ({
      id: 'a-1',
      schoolId: 'school',
      userId: ANNA,
      academicYearId: WORLD_YEAR.id,
      teachingLevelHours: level,
      exceptionKind,
      ownInitiativeOn: exceptionKind === 'OWN_INITIATIVE' ? new Date('2026-05-02T00:00:00.000Z') : null,
      note: null,
      decidedById: null,
      decidedAt: new Date('2026-03-05T08:00:00.000Z'),
      createdAt: new Date('2026-03-05T08:00:00.000Z'),
      updatedAt: new Date('2026-03-05T08:00:00.000Z'),
    });

    it('warns, and writes, for a teacher with a registered exception though the school refuses: 11 § allows it', async () => {
      arrange({ assignmentScopeMode: 'REFUSE' });
      tx.assignmentScopeAssessment.findMany.mockResolvedValue([stored('SMALL_GROUP')]);
      await expect(create(14)).resolves.toEqual([
        { code: 'STAFF_TEACHER_OVER_SCOPE', params: { role: 'TEACHER', hours: '602', limit: '600' } },
      ]);
    });

    it('still refuses a teacher whose assessment is a level and no exception', async () => {
      arrange({ assignmentScopeMode: 'REFUSE' });
      tx.assignmentScopeAssessment.findMany.mockResolvedValue([stored(null, 500)]);
      await expect(create(14)).rejects.toMatchObject({ status: 409, response: { code: 'STAFF_TEACHER_OVER_SCOPE' } });
    });

    it('reads the year\'s assessments once, in the same transaction, after the lydelse, and only for a year the ordinance reaches', async () => {
      arrange({ assignmentScopeMode: 'WARN' });
      await create(13);
      expect(tx.assignmentScopeAssessment.findMany).toHaveBeenCalledTimes(1);
      expect(tx.assignmentScopeAssessment.findMany).toHaveBeenCalledWith({ where: { academicYearId: WORLD_YEAR.id }, orderBy: { userId: 'asc' } });
    });

    it('reads none for a year the ordinance does not reach, a school that asks nothing, or a teacher with no post', async () => {
      arrange({ assignmentScopeMode: 'REFUSE' }, { validFrom: '2027-07-01' });
      await create(14);
      arrange({ assignmentScopeMode: 'OFF' });
      await create(14);
      arrange({ assignmentScopeMode: 'REFUSE' }, { employments: false });
      await create(14);
      expect(tx.assignmentScopeAssessment.findMany).not.toHaveBeenCalled();
    });

    it('a requirements file reads them once for the whole upload and excuses the same teacher on every row', async () => {
      arrange({ assignmentScopeMode: 'REFUSE' });
      tx.assignmentScopeAssessment.findMany.mockResolvedValue([stored('OWN_INITIATIVE')]);
      const checks = await RequirementImportChecks.open(tx as unknown as PrismaClient, {
        viewer: testUser(),
        showsPeriods: true,
        schoolId: 'school',
        academicYearId: WORLD_YEAR.id,
        teacherIds: [ANNA],
        groupIds: [G7],
      });
      expect(tx.assignmentScopeAssessment.findMany).toHaveBeenCalledTimes(1);
      const row = checks!.judge({
        requirementId: null,
        rowNumber: 2,
        subjectId: 'ma',
        subjectName: 'ma',
        studentGroupId: G7,
        groupName: '7A',
        patch: { teacherId: ANNA, lessonsPerWeek: 14, minutesPerLesson: 60 },
      });
      expect(row.findings.map((finding) => finding.mode)).toEqual(['WARN']);
      expect(tx.assignmentScopeAssessment.findMany).toHaveBeenCalledTimes(1);
    });
  });

  it('says only the verdict to a reader without HR-läs', async () => {
    arrange({ assignmentScopeMode: 'REFUSE' });
    await expect(
      enforceRequirementWrite(tx as unknown as PrismaClient, {
        viewer: testUser(),
        showsPeriods: false,
        schoolId: 'school',
        academicYearId: WORLD_YEAR.id,
        requirementId: null,
        subjectId: MA,
        studentGroupId: G7,
        before: null,
        patch: { teacherId: ANNA, lessonsPerWeek: 14, minutesPerLesson: 60 },
      }),
    ).rejects.toMatchObject({ response: { code: 'STAFF_TEACHER_OVER_SCOPE_HIDDEN', params: { role: 'TEACHER' } } });
  });

  it('a requirements file counts a row for the rows after it: 10 lessons, then 4 more, is 602 h on the second', async () => {
    arrange({ assignmentScopeMode: 'REFUSE' });
    const checks = await RequirementImportChecks.open(tx as unknown as PrismaClient, {
      viewer: testUser(),
      showsPeriods: true,
      schoolId: 'school',
      academicYearId: WORLD_YEAR.id,
      teacherIds: [ANNA],
      groupIds: [G7],
    });
    expect(tx.assignmentScopeVersion.findFirst).toHaveBeenCalledTimes(1);
    const judge = (rowNumber: number, lessonsPerWeek: number, subjectId: string) =>
      checks!.judge({
        requirementId: null,
        rowNumber,
        subjectId,
        subjectName: subjectId,
        studentGroupId: G7,
        groupName: '7A',
        patch: { teacherId: ANNA, lessonsPerWeek, minutesPerLesson: 60 },
      });
    const first = judge(2, 10, 'ma');
    expect(first.findings).toEqual([]);
    checks!.apply(first.after);
    const second = judge(3, 4, 'no');
    expect(second.findings).toEqual([
      { code: 'STAFF_TEACHER_OVER_SCOPE', mode: 'REFUSE', userId: ANNA, params: { role: 'TEACHER', hours: '602', limit: '600' } },
    ]);
  });
});

describe('enforceRequirementBatch and the ordinance\'s highest level', () => {
  const ANNA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const BO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const YEAR = { startDate: '2026-08-17', endDate: '2027-06-11' };
  const version = {
    code: 'SFS2026:1487',
    sfs: 'SFS 2026:1487',
    title: 'Förordning',
    validFrom: '2020-01-01',
    validTo: null,
    source: 'https://example.invalid/sfs',
    bands: [
      { schoolForm: 'GRUNDSKOLA', gradeNumbering: 'NIOARIG' as const, gradeFrom: 7, gradeTo: 9, teachingHoursLow: 500, teachingHoursHigh: 600, planningFloorPercent: 110, teachingSection: '3 § p. 2', planningSection: '4 §', note: null },
    ],
  };
  const row = (id: string, teacherId: string | null, lessonsPerWeek: number): LoadRequirement => ({
    id,
    subjectId: id,
    subjectName: `Ämne ${id}`,
    studentGroupId: 'g-7a',
    groupName: '7A',
    teacherId,
    coTeacherId: null,
    lessonsPerWeek,
    minutesPerLesson: 60,
    teacherLoadPercent: 100,
    coTeacherLoadPercent: 100,
    recurrence: 'ALL_WEEKS',
    startDate: null,
    endDate: null,
    gradeSpan: { min: 7, max: 7 },
  });
  const input = (requirements: LoadRequirement[]): LoadInput => ({
    year: YEAR,
    policy: null,
    employments: [
      { userId: ANNA, employmentPercent: 100, reductionPercent: 0, contractKind: 'FERIE', teachingTargetMinutesPerWeek: null, signature: null },
      { userId: BO, employmentPercent: 100, reductionPercent: 0, contractKind: 'FERIE', teachingTargetMinutesPerWeek: null, signature: null },
    ],
    requirements,
    qualifications: [],
    closures: [],
    duties: [],
  });
  const batch = (extra: Partial<Parameters<typeof enforceRequirementBatch>[0]>) =>
    enforceRequirementBatch({
      input: input([row('ma', BO, 10), row('no', ANNA, 4)]),
      policy: { ...DEFAULT_CHECK_POLICY, qualificationMode: 'OFF', overAllocationMode: 'OFF', assignmentScopeMode: 'REFUSE' },
      postsLocked: 2,
      changes: [{ requirementId: 'ma', teacherId: ANNA }],
      rowName: (id) => `Ämne ${id} för 7A`,
      scopeVersions: [version],
      ...extra,
    });

  it('refuses a batch that gives Anna 10 more lessons on top of her 4 (602 h), naming the row, the teacher and the sentence', () => {
    expect(() => batch({})).toThrow(ConflictException);
    try {
      batch({});
    } catch (error) {
      const body = (error as ConflictException).getResponse() as Record<string, unknown>;
      expect(body.code).toBe('STAFF_TEACHER_OVER_SCOPE');
      expect(body.params).toEqual({ role: 'TEACHER', hours: '602', limit: '600', userId: ANNA, requirementId: 'ma' });
      expect(body.message).toMatch(/^Ämne ma för 7A: Läraren skulle få 602 timmars undervisning/);
    }
  });

  it('warns under WARN with the rows it is about', () => {
    expect(
      batch({ policy: { ...DEFAULT_CHECK_POLICY, qualificationMode: 'OFF', overAllocationMode: 'OFF', assignmentScopeMode: 'WARN' } }),
    ).toEqual([
      { code: 'STAFF_TEACHER_OVER_SCOPE', params: { role: 'TEACHER', hours: '602', limit: '600' }, userId: ANNA, requirementIds: ['ma'] },
    ]);
  });

  it('asks nothing without the lydelser or when no post was locked, whatever the mode says', () => {
    expect(batch({ scopeVersions: undefined })).toEqual([]);
    expect(batch({ postsLocked: 0 })).toEqual([]);
  });

  it('judges a swap as ONE write: Anna and Bo trading rows leave each where they were, so nobody is asked', () => {
    const swap = [
      { requirementId: 'ma', teacherId: ANNA },
      { requirementId: 'no', teacherId: BO },
    ];
    expect(batch({ input: input([row('ma', BO, 14), row('no', ANNA, 14)]), changes: swap })).toEqual([]);
  });

  it('asks of an undo what the state the apply found would be asked: putting a row back is no growth past what they had', () => {
    // Anna carried 14 + 14 before, the apply shed one row, and the undo puts it back.
    const restoring = new Map<string, string | null>([['ma', ANNA]]);
    expect(
      batch({ input: input([row('ma', BO, 14), row('no', ANNA, 14)]), changes: [{ requirementId: 'ma', teacherId: ANNA }], restoring }),
    ).toEqual([]);
  });
});
