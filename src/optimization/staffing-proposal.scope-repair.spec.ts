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
 * The ordinance's highest level of teaching time under REFUSE (SFS 2026:1487 3 §): the engine plans against a standardvecka edge and
 * the ordinance counts clock hours, so an answer can leave a teacher over the edge by the real hours (a row charged at 50 %, a
 * teacher who gains a stricter stage, a school that charges by FACTOR). Review of #408: that was a 502 for the whole proposal, which
 * the dialog says is "the engine cannot propose just now" and which asking again repeats. The rows given beyond the edge go back.
 *
 * The year is 2026-08-17 to 2027-06-11, 43 teaching weeks: one lesson of 60 minutes a week is 43 hours, and the edge for åk 7-9 is
 * 600 hours (an 8 372 tenths standardvecka).
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

describe('Föreslå bemanning under REFUSE of the ordinance\'s highest level: an answer that leaves a teacher over it by the real hours', () => {
  it('gives the row the engine gave back, as unstaffed for lack of room, instead of refusing the whole proposal as an outage', async () => {
    const { service } = setup(school(), engineWith());
    const proposal = await service.propose(ask(), admin());
    // The engine counted 4 800 + 3 000 tenths against an 8 372 edge and gave Anna the row; it is 774 hours against 600.
    expect(proposal.assignments).toEqual([]);
    expect(proposal.unstaffed.map((row) => [row.requirementId, row.reason])).toEqual([[R_HALF, 'NO_CAPACITY_LEFT']]);
    expect(proposal.teachers.find((teacher) => teacher.userId === ANNA)!.scope).toMatchObject({ hoursBefore: 344, hoursAfter: 344, overAfter: false });
  });

  it('is then a feasible answer without the engine\'s figures: nothing proves what stays unstaffed, and its terms describe another answer', async () => {
    const { service } = setup(school(), engineWith());
    const proposal = await service.propose(ask(), admin());
    expect(proposal.status).toBe('FEASIBLE');
    expect(proposal.unstaffedProven).toBe(false);
    expect(proposal.terms).toBeNull();
  });

  it('leaves an answer that breaks nothing exactly as the engine gave it: its status and its figures', async () => {
    const rows = school();
    rows['teachingRequirement']![1]!['teacherLoadPercent'] = 100;
    rows['teachingRequirement']![1]!['lessonsPerWeek'] = 2;
    const { service } = setup(rows, engineWith());
    const proposal = await service.propose(ask(), admin());
    expect(proposal.assignments.map((row) => [row.requirementId, row.toTeacherId])).toEqual([[R_HALF, ANNA]]);
    expect(proposal.status).toBe('OPTIMAL');
    expect(proposal.unstaffedProven).toBe(true);
    expect(proposal.terms).not.toBeNull();
  });

  it('does not touch a school that warns: the dialog says the teacher ends over, and the apply warns', async () => {
    const rows = school();
    rows['staffingPolicy']![0]!['assignmentScopeMode'] = 'WARN';
    const { service } = setup(rows, engineWith());
    const proposal = await service.propose(ask(), admin());
    expect(proposal.assignments.map((row) => row.requirementId)).toEqual([R_HALF]);
    expect(proposal.teachers.find((teacher) => teacher.userId === ANNA)!.scope).toMatchObject({ overAfter: true });
  });
});
