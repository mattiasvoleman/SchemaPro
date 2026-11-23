import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { of } from 'rxjs';
import { testUser } from '../../test/utils/prisma-mock';
import { givenRolloverWorld, prismaFor, type Row } from '../../test/utils/rollover-world';
import type { PrismaService } from '../database/prisma.service';
import type { StaffRequest, StaffResponse } from './interfaces/staffing.interface';
import { OptimizationProxyService } from './optimization-proxy.service';
import { planOf, scopeCeilingTenths, StaffingProposalService, type StaffingState } from './staffing-proposal.service';
import { movesOf, searchModelOf } from './staffing-search';
import type { ScopeVersion } from '../staffing/assignment-scope';
import type { LoadRead } from '../staffing/load-input';
import { DEFAULT_CHECK_POLICY } from '../staffing/staffing-checks';
import type { EnforcedPolicy } from '../staffing/staffing-enforcement';
import type { LoadEmployment, LoadInput, LoadRequirement } from '../staffing/teacher-load';

/*
 * The ordinance's edge as a teacher's limit is the edge of the stages a teacher ENDS in (review of #408). The ordinance's span is blended
 * over the stages by hours, so a teacher who has åk 6 today and is given åk 7 has the lower edge afterwards: planned against the edge
 * they began with, the engine fills them to 650 hours and the answer is 649 hours against 633. A post that changes during the year
 * is scaled by its stretches, as the report scales it (not by its base row).
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


const G6 = 'b0000000-0000-4000-8000-000000000006';
const R_OPEN7 = '00000000-0000-4000-8000-0000000000f4';
const R_AK6 = '00000000-0000-4000-8000-0000000000f5';
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

describe('scopeCeilingTenths: the edge of the stages a teacher can end in', () => {
  // Anna: 6 lessons of 101 minutes in åk 6, 606 minutes and 434.3 hours.
  const anna = () => inputOf([lrow('own', ANNA, 6, 101, 6)], [emp(ANNA)]);

  it('is the edge she began with when no row she may be given is in a stricter stage: åk 6 only, 650 h', () => {
    expect(scopeCeilingTenths(anna(), [VERSION], ANNA, WEEKS)).toBe(9069);
    expect(scopeCeilingTenths(anna(), [VERSION], ANNA, WEEKS, [{ min: 5, max: 5 }, { min: 6, max: 6 }])).toBe(9069);
    // Rows with no årskurs, or in förskoleklass, are in no stage: they do not lower the edge.
    expect(scopeCeilingTenths(anna(), [VERSION], ANNA, WEEKS, [null, { min: 0, max: 0 }])).toBe(9069);
  });

  it('is the stricter stage\'s edge when she may be given a row there: åk 7, 600 h', () => {
    expect(scopeCeilingTenths(anna(), [VERSION], ANNA, WEEKS, [{ min: 6, max: 6 }, { min: 7, max: 7 }])).toBe(8372);
    // A span across the stages is the stricter, as the report places it.
    expect(scopeCeilingTenths(anna(), [VERSION], ANNA, WEEKS, [{ min: 6, max: 7 }])).toBe(8372);
  });

  it('holds a teacher with no teaching to the strictest of the stages she may be given, of all the lydelse\'s when nothing is known', () => {
    const none = inputOf([], [emp(ANNA)]);
    expect(scopeCeilingTenths(none, [VERSION], ANNA, WEEKS)).toBe(8372);
    expect(scopeCeilingTenths(none, [VERSION], ANNA, WEEKS, [{ min: 3, max: 3 }])).toBe(9069);
    expect(scopeCeilingTenths(none, [VERSION], ANNA, WEEKS, [{ min: 3, max: 3 }, { min: 8, max: 8 }])).toBe(8372);
  });

  it('scales a post that changes during the year by its stretches, as the report does, and not by its base row', () => {
    // 100 % to 11 January and 50 % after it: 446.5 hours of a 600 h edge (scopeOfTeacher, after one row, says the same).
    const periods = [{ validFrom: '2027-01-11', validTo: null, employmentPercent: 50, reductionPercent: 0, teachingTargetMinutesPerWeek: null }];
    const none = inputOf([], [emp(ANNA, { periods })]);
    expect(scopeCeilingTenths(none, [VERSION], ANNA, WEEKS)).toBe(6230);
    expect(scopeCeilingTenths(none, [VERSION], ANNA, WEEKS, [{ min: 7, max: 7 }])).toBe(6230);
  });
});

describe('planOf: what the engine is told under REFUSE', () => {
  const state = (requirements: LoadRequirement[], employments = [emp(ANNA), emp(CY)]): StaffingState => ({
    schoolId: 'school',
    read: { input: inputOf(requirements, employments) } as unknown as LoadRead,
    policy: { ...DEFAULT_CHECK_POLICY, qualificationMode: 'OFF', overAllocationMode: 'OFF', assignmentScopeMode: 'REFUSE', fullTimeTeachingMinutesPerWeek: 1080, overAllocationTolerancePercent: 10, unstaffedGeneration: 'ALLOW', showsPeriods: true } as EnforcedPolicy,
    staffIds: [ANNA, CY],
    candidateIds: [ANNA, CY],
    lastYear: new Map(),
    released: new Set(),
    scopeVersions: [VERSION],
  });
  const DTO = { onlyUnstaffed: false, respectQualifications: false, pinnedRequirementIds: [] as string[] };

  it('holds a teacher in åk 6 to 600 h when a row in åk 7 is open, and to 650 h when every open row is in åk 1-6', () => {
    const withSeven = planOf(state([lrow('own', ANNA, 6, 101, 6), lrow('open7', null, 5, 60, 7)]), DTO);
    expect(withSeven.teacherById.get(ANNA)!.limitTenths).toBe(8372);
    const onlySix = planOf(state([lrow('own', ANNA, 6, 101, 6), lrow('open5', null, 5, 60, 5)]), DTO);
    expect(onlySix.teacherById.get(ANNA)!.limitTenths).toBe(9069);
  });
});

describe('planOf: which rows lower the edge', () => {
  const stateWith = (requirements: LoadRequirement[], qualifications: LoadInput['qualifications'] = [], released: string[] = []): StaffingState => ({
    schoolId: 'school',
    read: { input: { ...inputOf(requirements, [emp(ANNA), emp(CY)]), qualifications } } as unknown as LoadRead,
    policy: { ...DEFAULT_CHECK_POLICY, qualificationMode: 'OFF', overAllocationMode: 'OFF', assignmentScopeMode: 'REFUSE', fullTimeTeachingMinutesPerWeek: 1080, overAllocationTolerancePercent: 10, unstaffedGeneration: 'ALLOW', showsPeriods: true } as EnforcedPolicy,
    staffIds: [ANNA, CY],
    candidateIds: [ANNA, CY],
    lastYear: new Map(),
    released: new Set(released),
    scopeVersions: [VERSION],
  });
  const DTO_RESPECT = { onlyUnstaffed: false, respectQualifications: true, pinnedRequirementIds: [] as string[] };

  it('is not lowered by a row the school has settled: a row somebody else leads and has not released is nobody\'s to be given', () => {
    const plan = planOf(stateWith([lrow('own', ANNA, 6, 101, 6), lrow('settled7', CY, 5, 60, 7)]), DTO_RESPECT);
    expect(plan.teacherById.get(ANNA)!.limitTenths).toBe(9069);
  });

  it('is not lowered by a row she is not qualified for, when behörigheter are respected: only Cy holds the subject of the åk 7 post', () => {
    const qualification = (userId: string) => ({ userId, subjectId: 's-open7', minGradeLevel: 7, maxGradeLevel: 7, kind: 'BEHORIG' as const, validFrom: null, validTo: null });
    const requirements = [lrow('own', ANNA, 6, 101, 6), lrow('open7', null, 5, 60, 7)];
    expect(planOf(stateWith(requirements, [qualification(CY)]), DTO_RESPECT).teacherById.get(ANNA)!.limitTenths).toBe(9069);
    expect(planOf(stateWith(requirements, [qualification(CY), qualification(ANNA)]), DTO_RESPECT).teacherById.get(ANNA)!.limitTenths).toBe(8372);
  });
});

describe('the search of lärarval: a teacher in åk 6 is not given a row in åk 7 that takes her past that stage\'s edge', () => {
  // Anna leads 606 minutes of åk 6 (434.3 h, a fixed post); Cy leads a released åk 7 post of 5 x 60 minutes. Given it, Anna is at 649.3 h
  // against 633.4 (the edge of her hours as they would be): over, and for the apply a warning (WARN) or a refusal (REFUSE).
  for (const mode of ['WARN', 'REFUSE'] as const) {
    it(`offers no move of the åk 7 post to her under ${mode}`, () => {
      const searched: StaffingState = {
        schoolId: 'school',
        read: { input: inputOf([lrow('own', ANNA, 6, 101, 6), lrow('k7', CY, 5, 60, 7)], [emp(ANNA), emp(CY)]) } as unknown as LoadRead,
        policy: { ...DEFAULT_CHECK_POLICY, qualificationMode: 'OFF', overAllocationMode: 'OFF', assignmentScopeMode: mode, fullTimeTeachingMinutesPerWeek: 1080, overAllocationTolerancePercent: 10, unstaffedGeneration: 'ALLOW', showsPeriods: true } as EnforcedPolicy,
        staffIds: [ANNA, CY],
        candidateIds: [ANNA, CY],
        lastYear: new Map(),
        released: new Set(['k7']),
        scopeVersions: [VERSION],
      };
      const plan = planOf(searched, { onlyUnstaffed: false, respectQualifications: true, pinnedRequirementIds: [] });
      const { model } = searchModelOf(plan, () => [7]);
      expect(model.rows.map((row) => row.requirementId)).toEqual(['k7']);
      const offered = movesOf(model, new Map(), new Set([7])).flatMap((move) => move.changes.map((change) => `${change.requirementId}>${change.toTeacherId}`));
      expect(offered).not.toContain(`k7>${ANNA}`);
    });
  }
});

describe('Föreslå bemanning under REFUSE: a teacher in åk 6 is not filled to the åk 1-6 edge with åk 7', () => {
  /** Anna leads 6 lessons of 101 minutes in åk 6 (606 minutes) and a 5 x 60 minute row in åk 7 is open: 434.3 + 215 = 649.3 h. */
  const mixed = (): Record<string, Row[]> => {
    const rows = school();
    rows['studentGroup']!.push({ id: G6, academicYearId: YEAR, name: '6A', kind: 'CLASS', gradeLevel: 6, predecessorId: null });
    rows['teachingRequirement'] = [
      requirement(R_AK6, { teacherId: ANNA, lessonsPerWeek: 6, minutesPerLesson: 101, studentGroupId: G6 }),
      requirement(R_OPEN7, { lessonsPerWeek: 5, minutesPerLesson: 60 }),
    ];
    return rows;
  };

  it('is not given the åk 7 row by the engine, which was told her real edge, so the answer needs nothing taken back', async () => {
    const { service } = setup(mixed(), engineWith());
    const proposal = await service.propose(ask(), admin());
    expect(proposal.assignments).toEqual([]);
    expect(proposal.unstaffed.map((row) => row.requirementId)).toEqual([R_OPEN7]);
    // The engine's own answer, as it gave it: nothing was given back.
    expect(proposal.status).toBe('OPTIMAL');
    expect(proposal.terms).not.toBeNull();
  });

  it('is given a row in åk 5 when that is all there is: her edge is still 650 h', async () => {
    const rows = mixed();
    rows['studentGroup']!.push({ id: 'b0000000-0000-4000-8000-000000000005', academicYearId: YEAR, name: '5A', kind: 'CLASS', gradeLevel: 5, predecessorId: null });
    Object.assign(rows['teachingRequirement']![1]!, { studentGroupId: 'b0000000-0000-4000-8000-000000000005' });
    const { service } = setup(rows, engineWith());
    const proposal = await service.propose(ask(), admin());
    expect(proposal.assignments.map((row) => [row.requirementId, row.toTeacherId])).toEqual([[R_OPEN7, ANNA]]);
  });
});
