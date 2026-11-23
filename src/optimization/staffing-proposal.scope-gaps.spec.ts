import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { of } from 'rxjs';
import { testUser } from '../../test/utils/prisma-mock';
import { givenRolloverWorld, prismaFor, type Row } from '../../test/utils/rollover-world';
import type { PrismaService } from '../database/prisma.service';
import type { StaffRequest, StaffResponse } from './interfaces/staffing.interface';
import { OptimizationProxyService } from './optimization-proxy.service';
import { planOf, StaffingProposalService, type StaffingState } from './staffing-proposal.service';
import { movesOf, searchModelOf, type SearchModel } from './staffing-search';
import type { ScopeVersion } from '../staffing/assignment-scope';
import type { LoadRead } from '../staffing/load-input';
import { DEFAULT_CHECK_POLICY } from '../staffing/staffing-checks';
import type { EnforcedPolicy } from '../staffing/staffing-enforcement';
import type { LoadEmployment, LoadInput, LoadRequirement } from '../staffing/teacher-load';

/*
 * Tests that were missing for what #408 says (review of #408): each of them passes on the pull request's head and fails against a
 * mutant of the line it is about, which no test of the head did.
 *
 * The year is 2026-08-17 to 2027-06-11, 43 teaching weeks: one lesson of 60 minutes a week is 43 hours; the edges are 650 hours for
 * åk 1-6 (9 069 tenths of a standardvecka) and 600 for åk 7-9 (8 372).
 */
const SCHOOL = '33333333-3333-4333-8333-333333333333';
const YEAR = 'a0000000-0000-4000-8000-00000000000a';
const G7 = 'b0000000-0000-4000-8000-000000000007';
const MA = 'e0000000-0000-4000-8000-0000000000aa';
const ANNA = 'd0000000-0000-4000-8000-00000000000a';
const CY = 'd0000000-0000-4000-8000-00000000000c';
const REKTOR = 'd0000000-0000-4000-8000-0000000000ad';
const R_FIXED = '00000000-0000-4000-8000-0000000000f1';
const R_HALF = '00000000-0000-4000-8000-0000000000f2';
const R_KEPT = '00000000-0000-4000-8000-0000000000f3';
const day = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

const requirement = (id: string, extra: Row): Row => ({
  id,
  academicYearId: YEAR,
  subjectId: MA,
  studentGroupId: G7,
  teacherId: null,
  coTeacherId: null,
  lessonsPerWeek: 2,
  minutesPerLesson: 60,
  lessonLengths: [],
  minutesBefore: 0,
  minutesAfter: 0,
  teacherLoadPercent: 100,
  coTeacherLoadPercent: 100,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  ...extra,
});
const post = (userId: string): Row => ({
  id: `f3000000-0000-4000-8000-${userId.slice(-12)}`,
  schoolId: SCHOOL,
  userId,
  academicYearId: YEAR,
  employmentPercent: new Prisma.Decimal('100.000'),
  reductionPercent: new Prisma.Decimal('0.000'),
  contractKind: 'FERIE',
  teachingTargetMinutesPerWeek: null,
  signature: 'XX',
  note: null,
});

const band = (gradeFrom: number, gradeTo: number, low: number, high: number, percent: number): Row => ({
  schoolForm: 'GRUNDSKOLA',
  gradeNumbering: 'NIOARIG',
  gradeFrom,
  gradeTo,
  teachingHoursLow: low,
  teachingHoursHigh: high,
  planningFloorPercent: percent,
  teachingSection: '3 §',
  planningSection: '4 §',
  note: null,
});

/**
 * Anna (100 %) leads 8 lessons of åk 7 (344 h) and the school's riktmärke is 1 080 minutes. R_HALF is open: 10 lessons of 60 minutes
 * charged at 50 % to its lead, so the engine counts 300 minutes where the ordinance counts 430 hours. 344 + 430 is 774 hours.
 */
const school = (): Record<string, Row[]> => {
  const bands = [band(1, 6, 550, 650, 100), band(7, 9, 500, 600, 110)];
  return {
    academicYear: [
      { id: YEAR, schoolId: SCHOOL, name: '2026/27', startDate: day('2026-08-17'), endDate: day('2027-06-11'), isActive: true, predecessorId: null },
    ],
    studentGroup: [{ id: G7, academicYearId: YEAR, name: '7A', kind: 'CLASS', gradeLevel: 7, predecessorId: null }],
    user: [
      { id: ANNA, role: 'TEACHER', isActive: true, studentGroupId: null, firstName: 'Anna' },
      { id: CY, role: 'TEACHER', isActive: true, studentGroupId: null, firstName: 'Cy' },
      { id: REKTOR, role: 'SCHOOL_ADMIN', isActive: true, studentGroupId: null, firstName: 'Rektor' },
    ],
    studentGroupMember: [],
    subject: [{ id: MA, name: 'Matematik', loadFactor: new Prisma.Decimal('1.00') }],
    staffingPolicy: [
      {
        schoolId: SCHOOL,
        fullTimeTeachingMinutesPerWeek: 1080,
        fullTimeRegulatedHoursPerYear: 1360,
        fullTimeAnnualHours: 1767,
        workDaysPerYear: 194,
        semesterHoursPerWeek: new Prisma.Decimal('40.0'),
        qualificationMode: 'OFF',
        overAllocationMode: 'OFF',
        assignmentScopeMode: 'REFUSE',
        overAllocationTolerancePercent: 10,
        loadModel: 'MINUTES',
        unstaffedGeneration: 'ALLOW',
      },
    ],
    teacherEmployment: [post(ANNA)],
    teachingRequirement: [
      requirement(R_FIXED, { teacherId: ANNA, lessonsPerWeek: 8 }),
      requirement(R_HALF, { lessonsPerWeek: 10, teacherLoadPercent: 50 }),
    ],
    assignmentScopeVersion: [
      { id: 'ordinance', code: 'SFS2026:1487', sfs: 'SFS 2026:1487', title: 'Förordning', validFrom: day('2000-01-01'), validTo: null, source: 'https://example.invalid/sfs', bands },
    ],
    assignmentScopeBand: bands.map((b) => ({ ...b, versionId: 'ordinance' })),
    teacherSubjectQualification: [],
    teacherDuty: [],
    schoolBreak: [],
    scheduleChangeLog: [],
  };
};

/** An engine that keeps every kept row and gives every open row to the first teacher with room by the limit it was sent. */
const engineWith =
  () =>
  (payload: StaffRequest): StaffResponse => {
    const load = new Map(payload.teachers.map((teacher) => [teacher.id, teacher.fixedTenths]));
    const limit = new Map(payload.teachers.map((teacher) => [teacher.id, teacher.limitTenths ?? 0]));
    const normal = payload.teachers.filter((teacher) => (teacher.targetTenths ?? 0) > 0);
    const assignments: StaffResponse['assignments'] = [];
    const unstaffed: StaffResponse['unstaffed'] = [];
    for (const row of payload.requirements.filter((r) => !r.fixed)) {
      if (row.currentTeacherId) {
        assignments.push({ requirementId: row.id, teacherId: row.currentTeacherId });
        load.set(row.currentTeacherId, load.get(row.currentTeacherId)! + row.chargeTenths);
      }
    }
    for (const row of payload.requirements.filter((r) => !r.fixed && !r.currentTeacherId)) {
      const pick = normal.find((teacher) => load.get(teacher.id)! + row.chargeTenths <= limit.get(teacher.id)!);
      if (pick) {
        load.set(pick.id, load.get(pick.id)! + row.chargeTenths);
        assignments.push({ requirementId: row.id, teacherId: pick.id });
      } else {
        unstaffed.push({ requirementId: row.id, reason: 'NO_CAPACITY_LEFT' });
      }
    }
    return {
      requestId: payload.requestId,
      status: 'OPTIMAL',
      unstaffedProven: true,
      assignments,
      unstaffed,
      conflicts: [],
      terms: {
        before: { unstaffedRows: 0, unstaffedMinutes: 0, deviationTenths: 0, underBandTenths: 0, newClassTeachers: 0, continuityChanges: 0, currentChanges: 0, unqualifiedAssignments: 0 },
        after: { unstaffedRows: 0, unstaffedMinutes: 0, deviationTenths: 0, underBandTenths: 0, newClassTeachers: 0, continuityChanges: 0, currentChanges: 0, unqualifiedAssignments: 0 },
      },
    };
  };

function setup(rows: Record<string, Row[]>, answer: (payload: StaffRequest) => StaffResponse) {
  const world = givenRolloverWorld(rows);
  const prisma = prismaFor(world);
  const http = { post: jest.fn((_url: string, payload: StaffRequest) => of({ data: answer(payload) })) };
  const config = { getOrThrow: jest.fn().mockReturnValue({ baseUrl: 'http://solver.test', apiKey: 'k'.repeat(32), timeoutMs: 50 }) };
  const proxy = new OptimizationProxyService(prisma as unknown as PrismaService, http as never, config as never);
  return { service: new StaffingProposalService(prisma as unknown as PrismaService, proxy), world };
}
const ask = () => ({ academicYearId: YEAR, onlyUnstaffed: true, respectQualifications: false });
const admin = () => testUser({ schoolId: SCHOOL, userId: REKTOR });

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());


const WEEKS = 43;
const YEAR_BOUNDS = { startDate: '2026-08-17', endDate: '2027-06-11' };

const VERSION: ScopeVersion = {
  code: 'SFS2026:1487',
  sfs: 'SFS 2026:1487',
  title: 'Förordning',
  validFrom: '2020-01-01',
  validTo: null,
  source: 'https://example.invalid/sfs',
  bands: [
    { schoolForm: 'GRUNDSKOLA', gradeNumbering: 'NIOARIG', gradeFrom: 1, gradeTo: 6, teachingHoursLow: 550, teachingHoursHigh: 650, planningFloorPercent: 100, teachingSection: '3 §', planningSection: '4 §', note: null },
    { schoolForm: 'GRUNDSKOLA', gradeNumbering: 'NIOARIG', gradeFrom: 7, gradeTo: 9, teachingHoursLow: 500, teachingHoursHigh: 600, planningFloorPercent: 110, teachingSection: '3 §', planningSection: '4 §', note: null },
  ],
};
const emp = (userId: string, extra: Partial<LoadEmployment> = {}): LoadEmployment => ({
  userId,
  employmentPercent: 100,
  reductionPercent: 0,
  contractKind: 'FERIE',
  teachingTargetMinutesPerWeek: null,
  signature: null,
  ...extra,
});
const lrow = (id: string, teacherId: string | null, lessons: number, minutes: number, grade: number): LoadRequirement => ({
  id,
  subjectId: `s-${id}`,
  subjectName: `Ämne ${id}`,
  studentGroupId: `g-${grade}`,
  groupName: `${grade}A`,
  teacherId,
  coTeacherId: null,
  lessonsPerWeek: lessons,
  minutesPerLesson: minutes,
  teacherLoadPercent: 100,
  coTeacherLoadPercent: 100,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  gradeSpan: { min: grade, max: grade },
});
const inputOf = (requirements: LoadRequirement[], employments: LoadEmployment[]): LoadInput => ({
  year: YEAR_BOUNDS,
  policy: { fullTimeTeachingMinutesPerWeek: 1080, overAllocationTolerancePercent: 10, fullTimeRegulatedHoursPerYear: 1360, workDaysPerYear: 194, qualificationMode: 'OFF' },
  employments,
  requirements,
  qualifications: [],
  closures: [],
  duties: [],
});


const stateOf = (
  mode: 'OFF' | 'WARN' | 'REFUSE',
  requirements: LoadRequirement[],
  options: { employments?: LoadEmployment[]; closures?: LoadInput['closures']; released?: string[] } = {},
): StaffingState => {
  const input = inputOf(requirements, options.employments ?? [emp(ANNA), emp(CY)]);
  return {
    schoolId: 'school',
    read: { input: { ...input, closures: options.closures ?? [] } } as unknown as LoadRead,
    policy: { ...DEFAULT_CHECK_POLICY, qualificationMode: 'OFF', overAllocationMode: 'OFF', assignmentScopeMode: mode, fullTimeTeachingMinutesPerWeek: 1080, overAllocationTolerancePercent: 10, unstaffedGeneration: 'ALLOW', showsPeriods: true } as EnforcedPolicy,
    staffIds: [ANNA, CY],
    candidateIds: [ANNA, CY],
    lastYear: new Map(),
    released: new Set(options.released ?? []),
    scopeVersions: [VERSION],
  };
};
const DTO = { onlyUnstaffed: false, respectQualifications: true, pinnedRequirementIds: [] as string[] };

describe('planOf and the ordinance: the edge, to the tenth, over the school\'s own weeks', () => {
  it('is a teacher\'s limit to the tenth: exactly on the ceiling is not over it, a tenth above it is', () => {
    // 4 186 minutes charged at 20 % is 837.2 minutes, 8 372 tenths: the ceiling of a 600 h edge over 43 weeks.
    const charged = (minutes: number) => ({ ...lrow('own', ANNA, 1, minutes, 7), teacherLoadPercent: 20 });
    const on = planOf(stateOf('REFUSE', [charged(4186)]), DTO).teacherById.get(ANNA)!;
    expect(on.currentTenths).toBe(8372);
    expect(on.scopeCeilingTenths).toBe(8372);
    expect(on.keepOrShed).toBe(false);
    const over = planOf(stateOf('REFUSE', [charged(4187)]), DTO).teacherById.get(ANNA)!;
    expect(over.currentTenths).toBe(8374);
    expect(over.keepOrShed).toBe(true);
  });

  it('counts the school\'s lov: two weeks closed make the standardvecka 41 weeks long, and the ceiling 600 x 60 / 41', () => {
    const closures = [{ startDate: '2026-10-26', endDate: '2026-11-06' }];
    const plan = planOf(stateOf('REFUSE', [lrow('own', ANNA, 5, 60, 7)], { closures }), DTO);
    expect(plan.teacherById.get(ANNA)!.scopeCeilingTenths).toBe(Math.floor((10 * 600 * 60) / 41));
  });

  it('takes tjänst minus nedsättning for a teacher with no teaching: 100 % less 20 % is 480 h, 6 697 tenths', () => {
    const plan = planOf(stateOf('WARN', [lrow('open', null, 2, 60, 7)], { employments: [emp(ANNA, { reductionPercent: 20 }), emp(CY)] }), DTO);
    expect(plan.teacherById.get(ANNA)!.scopeCeilingTenths).toBe(6697);
  });
});

describe('the search\'s model carries the plan\'s ordinance edge', () => {
  const rows = () => [lrow('own', ANNA, 6, 60, 7), lrow('k1', CY, 4, 60, 7)];
  it('under WARN and under REFUSE, and not at all when the school asks nothing', () => {
    const modelOf = (mode: 'OFF' | 'WARN' | 'REFUSE') =>
      searchModelOf(planOf(stateOf(mode, rows(), { released: ['k1'] }), DTO), () => [7]).model;
    expect(modelOf('WARN').teachers.get(ANNA)!.scopeCeilingTenths).toBe(8372);
    expect(modelOf('REFUSE').teachers.get(CY)!.scopeCeilingTenths).toBe(8372);
    expect(modelOf('OFF').teachers.get(ANNA)).not.toHaveProperty('scopeCeilingTenths');
  });

  it('offers a move that ends exactly on the ceiling and not one a tenth over it', () => {
    const base = (ceiling: number): SearchModel => ({
      rows: [{ requirementId: 'p1', leadId: 'A', options: ['A', 'B'], chargeTenths: 100, years: [9] }],
      teachers: new Map([
        ['A', { currentTenths: 300, limitTenths: 1000 }],
        ['B', { currentTenths: 100, limitTenths: 1000, scopeCeilingTenths: ceiling }],
      ]),
    });
    const offered = (model: SearchModel) =>
      movesOf(model, new Map(), new Set([9])).flatMap((move) => move.changes.map((change) => `${change.requirementId}>${change.toTeacherId}`));
    expect(offered(base(200))).toContain('p1>B');
    expect(offered(base(199))).not.toContain('p1>B');
  });
});

describe('ProposalTeacher.scope: what the dialog prints, from the gateway\'s own arithmetic', () => {
  const given = async (user = admin()) => {
    const rows = school();
    rows['staffingPolicy']![0]!['assignmentScopeMode'] = 'WARN';
    // Anna leads 344 h; the open row is 10 lessons at 50 %: the engine counts 300 minutes and gives it to her (774 h, over a 600 h edge).
    // Cy leads 15 lessons (645 h), over the edge already, and is given nothing.
    rows['teacherEmployment']!.push(post(CY));
    rows['teachingRequirement']!.push(requirement('00000000-0000-4000-8000-0000000000f9', { teacherId: CY, lessonsPerWeek: 15 }));
    const { service } = setup(rows, engineWith());
    return service.propose(ask(), user);
  };

  it('says hours before and after for the whole proposal, and over or not over, before and after, by the ordinance\'s edge', async () => {
    const proposal = await given();
    const scopeOf = (id: string) => proposal.teachers.find((teacher) => teacher.userId === id)!.scope;
    expect(scopeOf(ANNA)).toEqual({ hoursBefore: 344, hoursAfter: 774, highestHours: 600, overBefore: false, overAfter: true });
    expect(scopeOf(CY)).toEqual({ hoursBefore: 645, hoursAfter: 645, highestHours: 600, overBefore: true, overAfter: true });
  });

  it('gives a reader without HR-läs the verdict and the hours, and not the highest level, which with the span gives the post back', async () => {
    const planner = testUser({ schoolId: SCHOOL, userId: REKTOR, adminProfile: 'SCHEMALAGGARE', hrRead: false });
    const proposal = await given(planner);
    const anna = proposal.teachers.find((teacher) => teacher.userId === ANNA)!.scope!;
    expect(anna).toEqual({ hoursBefore: 344, hoursAfter: 774, highestHours: null, overBefore: false, overAfter: true });
  });
});

describe('the apply: the ordinance is read under the lock', () => {
  it('asks for the lydelser once, after the teachers\' posts are locked and in the same transaction, never before', async () => {
    const rows = school();
    rows['staffingPolicy']![0]!['assignmentScopeMode'] = 'WARN';
    rows['teachingRequirement']![1]!['teacherLoadPercent'] = 100;
    rows['teachingRequirement']![1]!['lessonsPerWeek'] = 2;
    const { service, world } = setup(rows, engineWith());
    // Locks as Postgres answers them: every raw statement is recorded in order.
    const fallback = world.queryRaw;
    world.queryRaw = (sql, values) => {
      if (sql.includes('"TeacherEmployments"')) {
        const ids = values[0] as string[];
        return (world.rows['teacherEmployment'] ?? []).filter((row) => ids.includes(row['id'] as string)).map((row) => ({ id: row['id'] }));
      }
      if (sql.includes('"TeachingRequirements"')) return (values[0] as string[]).map((id) => ({ id }));
      return fallback(sql, values);
    };
    const proposal = await service.propose(ask(), admin());
    const start = world.calls.length;
    await service.apply({ academicYearId: YEAR, basisSha256: proposal.basisSha256, changes: [{ requirementId: R_HALF, fromTeacherId: null, toTeacherId: ANNA }] }, admin());
    const calls = world.calls.slice(start);
    const lock = calls.findIndex((call) => call.sql?.includes('"TeacherEmployments"') && call.sql.includes('FOR NO KEY UPDATE'));
    const read = calls.findIndex((call) => call.model === 'assignmentScopeVersion');
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(read).toBeGreaterThan(lock);
    expect(calls.filter((call) => call.model === 'assignmentScopeVersion')).toHaveLength(1);
    expect(calls.findIndex((call) => call.method === 'updateMany')).toBeGreaterThan(read);
  });
});
