import type { PrismaClient } from '@prisma/client';
import { createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import { WORLD_YEAR, givenStaffingWorld } from '../../test/utils/staffing-world';
import { enforceRequirementWrite } from './staffing-enforcement';
import { DEFAULT_CHECK_POLICY, judgeRequirementWrite, type CheckPolicy } from './staffing-checks';
import type { ScopeBand, ScopeVersion } from './assignment-scope';
import type { LoadInput, LoadRequirement } from './teacher-load';

/*
 * Mutants of #404's own code that the PR's tests let through (review of #404, M-5): a limit that is not a whole number printed with a dot,
 * a school with no policy row asking nothing of the ordinance, the lydelse asked for by another day than the year's first, and a teacher who
 * has only a share of a row never being asked. Anna is full-time in årskurs 7 (upper edge 600 h) in a year of 43 weeks.
 */
const ANNA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MA = 'ma';
const G7 = 'g-7a';

const bands: ScopeBand[] = [
  { schoolForm: 'GRUNDSKOLA', gradeNumbering: 'NIOARIG', gradeFrom: 1, gradeTo: 6, teachingHoursLow: 550, teachingHoursHigh: 650, planningFloorPercent: 100, teachingSection: '3 § p. 1', planningSection: '4 § p. 1', note: null },
  { schoolForm: 'GRUNDSKOLA', gradeNumbering: 'NIOARIG', gradeFrom: 7, gradeTo: 9, teachingHoursLow: 500, teachingHoursHigh: 600, planningFloorPercent: 110, teachingSection: '3 § p. 2', planningSection: '4 § p. 1', note: null },
];
/** The lydelse as the reader may get it: its bands on the row (a relation read) or from the bands' own table. */
const ordinance = () => ({
  id: 'version-1',
  code: 'SFS2026:1487',
  sfs: 'SFS 2026:1487',
  title: 'Förordning',
  validFrom: new Date('2020-01-01T00:00:00.000Z'),
  validTo: null,
  source: 'https://example.invalid/sfs',
  bands,
});

describe('enforceRequirementWrite and the ordinance, edges', () => {
  let tx: TxMock;
  beforeEach(() => {
    tx = createTxMock();
    tx.assignmentScopeVersion.findFirst.mockResolvedValue(ordinance());
    tx.assignmentScopeBand.findMany.mockResolvedValue(bands);
  });
  const create = (patch: { lessonsPerWeek: number; minutesPerLesson: number }) =>
    enforceRequirementWrite(tx as unknown as PrismaClient, {
      viewer: testUser(),
      showsPeriods: true,
      schoolId: 'school',
      academicYearId: WORLD_YEAR.id,
      requirementId: null,
      subjectId: MA,
      studentGroupId: G7,
      before: null,
      patch: { teacherId: ANNA, ...patch },
    });
  const school = (world: Partial<Parameters<typeof givenStaffingWorld>[1]> = {}) =>
    givenStaffingWorld(tx, {
      policy: { qualificationMode: 'OFF', overAllocationMode: 'OFF', assignmentScopeMode: 'WARN' },
      employments: [{ id: 'emp-anna', userId: ANNA }],
      groups: [{ id: G7, name: '7A', gradeLevel: 7 }],
      subjects: [{ id: MA, name: 'Matematik' }],
      ...world,
    });

  it('prints a limit that is not a whole number with the Swedish comma, as the hours: 81,25 % of 600 h is 487,5', async () => {
    school({ employments: [{ id: 'emp-anna', userId: ANNA, employmentPercent: 81.25 }] });
    // 14 lessons of 50 minutes over 43 weeks are 501,67 h.
    await expect(create({ lessonsPerWeek: 14, minutesPerLesson: 50 })).resolves.toEqual([
      { code: 'STAFF_TEACHER_OVER_SCOPE', params: { role: 'TEACHER', hours: '501,7', limit: '487,5' } },
    ]);
  });

  it('asks a school with no policy row, which has decided nothing: the table\'s default is WARN', async () => {
    school({ policy: null });
    await expect(create({ lessonsPerWeek: 14, minutesPerLesson: 60 })).resolves.toEqual(
      expect.arrayContaining([{ code: 'STAFF_TEACHER_OVER_SCOPE', params: { role: 'TEACHER', hours: '602', limit: '600' } }]),
    );
  });

  it('asks for the lydelse that holds on the year\'s first day, the one the year was read with', async () => {
    school();
    await create({ lessonsPerWeek: 14, minutesPerLesson: 60 });
    const day = new Date('2026-08-17T00:00:00.000Z');
    expect(tx.assignmentScopeVersion.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { validFrom: { lte: day }, OR: [{ validTo: null }, { validTo: { gte: day } }] } }),
    );
  });
});

describe('judgeRequirementWrite and a teacher who has a share of a row', () => {
  const version: ScopeVersion = { ...ordinance(), validFrom: '2020-01-01', bands };
  const row = (id: string, teacherId: string, lessonsPerWeek: number, extra: Partial<LoadRequirement> = {}): LoadRequirement => ({
    id,
    subjectId: id,
    subjectName: id,
    studentGroupId: `g-${id}`,
    groupName: id,
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
    ...extra,
  });
  const input = (requirements: LoadRequirement[]): LoadInput => ({
    year: { startDate: '2026-08-17', endDate: '2027-06-11' },
    policy: null,
    employments: [ANNA, BO].map((userId) => ({ userId, employmentPercent: 100, reductionPercent: 0, contractKind: 'FERIE' as const, teachingTargetMinutesPerWeek: null, signature: null })),
    requirements,
    qualifications: [],
    closures: [],
    duties: [],
  });
  const policy: CheckPolicy = { ...DEFAULT_CHECK_POLICY, qualificationMode: 'OFF', overAllocationMode: 'OFF', assignmentScopeMode: 'REFUSE' };

  it('asks of a teacher whose only part of a new row is a share of its lessons: 1 + 13 lessons are 602 h', () => {
    // Bo leads 14 lessons a week; Anna takes 13 of them, and has 1 lesson of her own.
    const shared = row('shared', BO, 14, { shares: [{ teacherId: ANNA, lessons: 13, minutes: 60 }] });
    const findings = judgeRequirementWrite({ input: input([row('own', ANNA, 1)]), policy, before: null, after: shared, subjectName: 'X', scopeVersions: [version] });
    expect(findings.map(({ code, userId, params }) => ({ code, userId, params }))).toEqual([
      { code: 'STAFF_TEACHER_OVER_SCOPE', userId: ANNA, params: { role: 'TEACHER', hours: '602', limit: '600' } },
    ]);
  });
});
