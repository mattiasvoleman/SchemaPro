import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { of } from 'rxjs';
import { testUser } from '../../test/utils/prisma-mock';
import { givenRolloverWorld, prismaFor, type Row } from '../../test/utils/rollover-world';
import type { PrismaService } from '../database/prisma.service';
import type { StaffRequest, StaffResponse } from './interfaces/staffing.interface';
import { OptimizationProxyService } from './optimization-proxy.service';
import { StaffingProposalService } from './staffing-proposal.service';

/*
 * The line the dialog prints per teacher, "Enligt förordningen: A → B h undervisning" (ProposalTeacher.scope), is said only of a teacher
 * the ordinance judges (review of #408). A läsår that begins before 2027-07-01 is not governed by it, and a teacher with no post or
 * with no teaching has nothing to compare: the dialog must not state an ordinance's hours for them.
 */
const SCHOOL = '33333333-3333-4333-8333-333333333333';
const YEAR = 'a0000000-0000-4000-8000-00000000000a';
const G7 = 'b0000000-0000-4000-8000-000000000007';
const MA = 'e0000000-0000-4000-8000-0000000000aa';
const ANNA = 'd0000000-0000-4000-8000-00000000000a';
const CY = 'd0000000-0000-4000-8000-00000000000c';
const DAG = 'd0000000-0000-4000-8000-00000000000d';
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


/** A teacher with a post and no teaching who sorts before Anna, so that the engine's first pick is him. */
const NY = 'd0000000-0000-4000-8000-000000000001';

describe('ProposalTeacher.scope: only of a teacher the ordinance judges', () => {
  it('is absent for every teacher in a läsår the ordinance does not reach (it holds from 2027-07-01 and this one begins in 2026)', async () => {
    const rows = school();
    rows['assignmentScopeVersion'] = [{ ...rows['assignmentScopeVersion']![0]!, validFrom: day('2027-07-01') }];
    rows['staffingPolicy']![0]!['assignmentScopeMode'] = 'WARN';
    const { service } = setup(rows, engineWith());
    const proposal = await service.propose(ask(), admin());
    expect(proposal.teachers.length).toBeGreaterThan(0);
    expect(proposal.teachers.map((teacher) => teacher.scope)).toEqual(proposal.teachers.map(() => undefined));
  });

  it('is absent for a teacher with no post and for one with no teaching before or after, and present for the others', async () => {
    const rows = school();
    rows['staffingPolicy']![0]!['assignmentScopeMode'] = 'WARN';
    // The open row is 2 lessons (86 h): the engine gives it to Ny, who has a post and no teaching. Anna has teaching and is given nothing.
    // Cy has no post. Dag has a post and nothing, and is given nothing (the row is Ny's): he is judged neither before nor after.
    rows['user']!.push({ id: NY, role: 'TEACHER', isActive: true, studentGroupId: null, firstName: 'Ny' });
    rows['user']!.push({ id: DAG, role: 'TEACHER', isActive: true, studentGroupId: null, firstName: 'Dag' });
    rows['teacherEmployment']!.push(post(NY), post(DAG));
    rows['teachingRequirement']![1]!['teacherLoadPercent'] = 100;
    rows['teachingRequirement']![1]!['lessonsPerWeek'] = 2;
    const { service } = setup(rows, engineWith());
    const proposal = await service.propose(ask(), admin());
    const scopeOf = (id: string) => proposal.teachers.find((teacher) => teacher.userId === id)?.scope;
    expect(proposal.assignments.map((row) => row.toTeacherId)).toEqual([NY]);
    expect(scopeOf(ANNA)).toMatchObject({ hoursBefore: 344, hoursAfter: 344 });
    expect(scopeOf(NY)).toMatchObject({ hoursBefore: 0, hoursAfter: 86 });
    expect(scopeOf(CY)).toBeUndefined();
    expect(scopeOf(DAG)).toBeUndefined();
  });
});
