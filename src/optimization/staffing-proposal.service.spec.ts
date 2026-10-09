import { BadRequestException, ConflictException, HttpException, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AxiosError } from 'axios';
import { of, throwError } from 'rxjs';
import { testUser } from '../../test/utils/prisma-mock';
import { givenRolloverWorld, prismaFor, type RolloverWorld, type Row } from '../../test/utils/rollover-world';
import type { PrismaService } from '../database/prisma.service';
import { strongestCoveringQualification, loadStatus } from '../staffing/teacher-load';
import type { StaffingProposalDto } from './dto/staffing-proposal.dto';
import type { StaffRequest, StaffResponse, StaffTerms } from './interfaces/staffing.interface';
import { OptimizationProxyService } from './optimization-proxy.service';
import {
  MAX_STAFF_BODY_BYTES,
  STAFF_ENGINE_UNAVAILABLE,
  STAFF_PROPOSAL_STALE,
  StaffingProposalService,
  floorTenthsOf,
  limitTenthsOf,
  toTenthsUp,
  type StaffingProposal,
} from './staffing-proposal.service';

// ---------------------------------------------------------------------------
// A small school, as rows.

const SCHOOL = '33333333-3333-4333-8333-333333333333';
const YEAR = 'a0000000-0000-4000-8000-00000000000a';
const LAST_YEAR = 'a0000000-0000-4000-8000-0000000000a0';
const G7A = 'b0000000-0000-4000-8000-000000000007';
const G8A = 'b0000000-0000-4000-8000-000000000008';
const G6A = 'b0000000-0000-4000-8000-000000000006';
const MA = 'e0000000-0000-4000-8000-0000000000aa';
const SV = 'e0000000-0000-4000-8000-0000000000bb';
/** Riktmärke 600, 10 %: Anna (100 %) 600, limit 660. */
const ANNA = 'd0000000-0000-4000-8000-00000000000a';
/** 50 %: target 300, limit 330. */
const BO = 'd0000000-0000-4000-8000-00000000000b';
/** No post: no target. */
const CY = 'd0000000-0000-4000-8000-00000000000c';
/** A post with a target of 0 (a 100 % nedsättning). */
const DAG = 'd0000000-0000-4000-8000-00000000000d';
/** Has left: inactive. */
const EVA = 'd0000000-0000-4000-8000-00000000000e';
/** A teaching rektor, 100 %. */
const REKTOR = 'd0000000-0000-4000-8000-0000000000ad';
const PUPIL = 'c0000000-0000-4000-8000-000000000071';

const R_MA7 = '00000000-0000-4000-8000-000000000001';
const R_SV7 = '00000000-0000-4000-8000-000000000002';
const R_MA8 = '00000000-0000-4000-8000-000000000003';
const R_SV8 = '00000000-0000-4000-8000-000000000004';
const R_ODD = '00000000-0000-4000-8000-000000000005';
const R_LAST = '00000000-0000-4000-8000-0000000000f1';

const day = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

const requirement = (id: string, studentGroupId: string, subjectId: string, extra: Row = {}): Row => ({
  id,
  academicYearId: YEAR,
  subjectId,
  studentGroupId,
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

const post = (userId: string, extra: Row = {}): Row => ({
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
  ...extra,
});

/**
 * Anna leads Ma 7A (120); Eva, who has left, leads Sv 7A; Ma 8A and Sv 8A are
 * open, Sv 8A with Bo as its co-teacher; an odd-week row nobody teaches; and
 * Anna is both teachers of a 30-minute row nothing should touch.
 */
function schoolRows(): Record<string, Row[]> {
  return {
    academicYear: [
      { id: YEAR, schoolId: SCHOOL, name: '2026/27', startDate: day('2026-08-17'), endDate: day('2027-06-11'), isActive: true, predecessorId: null },
    ],
    studentGroup: [
      { id: G7A, academicYearId: YEAR, name: '7A', kind: 'CLASS', gradeLevel: 7, predecessorId: null },
      { id: G8A, academicYearId: YEAR, name: '8A', kind: 'CLASS', gradeLevel: 8, predecessorId: null },
    ],
    user: [
      { id: ANNA, role: 'TEACHER', isActive: true, studentGroupId: null, firstName: 'Anna', email: 'anna@skola.se' },
      { id: BO, role: 'TEACHER', isActive: true, studentGroupId: null, firstName: 'Bo', email: 'bo@skola.se' },
      { id: CY, role: 'TEACHER', isActive: true, studentGroupId: null, firstName: 'Cy' },
      { id: DAG, role: 'TEACHER', isActive: true, studentGroupId: null, firstName: 'Dag' },
      { id: EVA, role: 'TEACHER', isActive: false, studentGroupId: null, firstName: 'Eva' },
      { id: REKTOR, role: 'SCHOOL_ADMIN', isActive: true, studentGroupId: null, firstName: 'Rektor' },
      { id: PUPIL, role: 'STUDENT', isActive: true, studentGroupId: G7A },
    ],
    studentGroupMember: [],
    subject: [
      { id: MA, name: 'Matematik', loadFactor: new Prisma.Decimal('1.20') },
      { id: SV, name: 'Svenska', loadFactor: new Prisma.Decimal('1.00') },
    ],
    staffingPolicy: [
      {
        schoolId: SCHOOL,
        fullTimeTeachingMinutesPerWeek: 600,
        fullTimeRegulatedHoursPerYear: 1360,
        fullTimeAnnualHours: 1767,
        workDaysPerYear: 194,
        semesterHoursPerWeek: new Prisma.Decimal('40.0'),
        qualificationMode: 'WARN',
        overAllocationMode: 'WARN',
        overAllocationTolerancePercent: 10,
        loadModel: 'MINUTES',
        unstaffedGeneration: 'ALLOW',
      },
    ],
    teacherEmployment: [
      post(ANNA, { signature: 'AN' }),
      post(BO, { employmentPercent: new Prisma.Decimal('50.000'), signature: 'BO' }),
      post(DAG, { teachingTargetMinutesPerWeek: 0 }),
      post(EVA),
      post(REKTOR),
    ],
    teachingRequirement: [
      requirement(R_MA7, G7A, MA, { teacherId: ANNA }),
      requirement(R_SV7, G7A, SV, { teacherId: EVA }),
      requirement(R_MA8, G8A, MA),
      requirement(R_SV8, G8A, SV, { coTeacherId: BO, coTeacherLoadPercent: 50 }),
      requirement(R_ODD, G8A, SV, { lessonsPerWeek: 1, minutesPerLesson: 30, teacherId: ANNA, coTeacherId: ANNA }),
    ],
    teacherSubjectQualification: [],
    teacherDuty: [],
    schoolBreak: [],
    scheduleChangeLog: [],
  };
}

const ZERO_TERMS: StaffTerms = {
  unstaffedRows: 0,
  unstaffedMinutes: 0,
  deviationTenths: 0,
  underBandTenths: 0,
  newClassTeachers: 0,
  continuityChanges: 0,
  currentChanges: 0,
  unqualifiedAssignments: 0,
};

/**
 * A stand-in engine that keeps the rules: kept rows keep their lead, an open
 * row goes to the first eligible (or, without respect, any) normal teacher with
 * room, in payload order — or stays unstaffed. Enough to exercise the
 * realisation; the model itself is the engine's tests' business.
 */
function engineAnswer(payload: StaffRequest): StaffResponse {
  const sets = new Map(payload.eligibilitySets.map((set) => [set.id, set.teacherIds]));
  const load = new Map(payload.teachers.map((teacher) => [teacher.id, teacher.fixedTenths]));
  for (const row of payload.requirements) {
    if (!row.fixed && row.currentTeacherId) load.set(row.currentTeacherId, load.get(row.currentTeacherId)! + row.chargeTenths);
  }
  const normal = new Set(
    payload.teachers
      .filter((t) => (t.targetTenths ?? 0) > 0 && load.get(t.id)! <= t.limitTenths!)
      .map((t) => t.id),
  );
  const limit = new Map(payload.teachers.map((t) => [t.id, t.limitTenths ?? 0]));
  const assignments: StaffResponse['assignments'] = [];
  const unstaffed: StaffResponse['unstaffed'] = [];
  for (const row of payload.requirements) {
    if (row.fixed) continue;
    if (row.currentTeacherId) {
      assignments.push({ requirementId: row.id, teacherId: row.currentTeacherId });
      continue;
    }
    const pool = payload.respectQualifications
      ? (sets.get(row.eligibilitySetId ?? '') ?? [])
      : payload.teachers.map((t) => t.id);
    const pick = pool.find(
      (id) => id !== row.coTeacherId && normal.has(id) && load.get(id)! + row.chargeTenths <= limit.get(id)!,
    );
    if (pick) {
      load.set(pick, load.get(pick)! + row.chargeTenths);
      assignments.push({ requirementId: row.id, teacherId: pick });
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
    terms: { before: ZERO_TERMS, after: ZERO_TERMS },
  };
}

interface Setup {
  world: RolloverWorld;
  service: StaffingProposalService;
  http: { post: jest.Mock };
  /** The payloads the engine was sent. */
  sent: () => StaffRequest[];
}

function setup(rows: Record<string, Row[]> = schoolRows(), answer: (payload: StaffRequest) => StaffResponse = engineAnswer): Setup {
  const world = givenRolloverWorld(rows);
  const prisma = prismaFor(world);
  const http = { post: jest.fn((_url: string, payload: StaffRequest) => of({ data: answer(payload) })) };
  const config = {
    getOrThrow: jest.fn().mockReturnValue({ baseUrl: 'http://solver.test', apiKey: 'k'.repeat(32), timeoutMs: 50 }),
  };
  const proxy = new OptimizationProxyService(prisma as unknown as PrismaService, http as never, config as never);
  const service = new StaffingProposalService(prisma as unknown as PrismaService, proxy);
  return { world, service, http, sent: () => http.post.mock.calls.map((call) => call[1] as StaffRequest) };
}

const ask = (overrides: Partial<StaffingProposalDto> = {}): StaffingProposalDto => ({
  academicYearId: YEAR,
  onlyUnstaffed: true,
  respectQualifications: false,
  ...overrides,
});

const admin = () => testUser({ schoolId: SCHOOL, userId: REKTOR });

/** The payload row (and its set) of a real requirement, through the order the gateway sends in. */
const sentRow = (payload: StaffRequest, realId: string, rows: Row[] | Record<string, Row[]>) => {
  const list = Array.isArray(rows) ? rows : rows['teachingRequirement']!;
  const index = list.map((row) => row['id'] as string).sort().indexOf(realId);
  return payload.requirements[index]!;
};

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

// ---------------------------------------------------------------------------

describe('the tenths arithmetic (C3)', () => {
  it('charges and fixed load round UP to a tenth, losing at most a tenth per row', () => {
    expect(toTenthsUp(59.3)).toBe(593);
    expect(toTenthsUp(60)).toBe(600);
    expect(toTenthsUp(0)).toBe(0);
    expect(toTenthsUp(12.01)).toBe(121);
    // Ten rows of 59.3 are 593 tenths, exactly what the exact load is.
    expect(10 * toTenthsUp(59.3)).toBe(5930);
  });

  it('puts the limit at 10·floor(T + T·tol) + 4, the last tenth loadStatus still calls OK', () => {
    expect(limitTenthsOf(600, 10)).toBe(6604);
    expect(limitTenthsOf(593, 0)).toBe(5934);
    expect(limitTenthsOf(735, 7)).toBe(10 * Math.floor(735 + 51.45) + 4);
    // The boundary, by loadStatus itself: 660.4 is OK, 660.5 OVER.
    expect(loadStatus(6604 / 10, 600, 10)).toBe('OK');
    expect(loadStatus(6605 / 10, 600, 10)).toBe('OVER');
    // Ten rows of 59.3 at tolerance 0 against 593: all fit.
    expect(10 * toTenthsUp(59.3)).toBeLessThanOrEqual(limitTenthsOf(593, 0));
  });

  it('puts the band’s floor at 10·ceil(T − T·tol) − 5, the first tenth loadStatus no longer calls UNDER', () => {
    expect(floorTenthsOf(600, 10)).toBe(5395);
    expect(loadStatus(5395 / 10, 600, 10)).toBe('OK');
    expect(loadStatus(5394 / 10, 600, 10)).toBe('UNDER');
    expect(floorTenthsOf(0, 10)).toBe(0);
  });
});

describe('StaffingProposalService.propose', () => {
  it('sends every active member of staff, a rektor and a teacher with no row included, and nobody else', async () => {
    const { service, sent } = setup();
    await service.propose(ask(), admin());
    const [payload] = sent();
    expect(payload!.teachers).toHaveLength(5); // Anna, Bo, Cy, Dag, Rektor — not Eva, not the pupil
    // Canonical order: by real id, so Anna, Bo, Cy, Dag, Rektor.
    expect(payload!.teachers.map((t) => t.targetTenths)).toEqual([6000, 3000, null, 0, 6000]);
    expect(payload!.teachers.map((t) => t.limitTenths)).toEqual([6604, 3304, null, 4, 6604]);
  });

  it('classifies the rows: a staffed row fixed, a vacated one and the open ones free, the one with one person twice fixed', async () => {
    const { service, sent } = setup();
    const proposal = await service.propose(ask(), admin());
    expect(proposal.counts).toEqual({
      freeRequirements: 3,
      openRequirements: 3,
      keptRequirements: 0,
      fixedRequirements: 2,
      vacated: 1,
      inconsistent: 1,
      teachersSent: 5,
      teachersWithTarget: 4,
      teachersWithZeroTarget: 1,
      teachersWithoutTarget: 1,
    });
    const rows = schoolRows()['teachingRequirement']!;
    const payload = sent()[0]!;
    expect(sentRow(payload, R_MA7, rows)).toMatchObject({ fixed: true, chargeTenths: 1200 });
    // Eva has left: her row is free and has no current lead on the wire.
    expect(sentRow(payload, R_SV7, rows)).toMatchObject({ fixed: false, currentTeacherId: null });
    // Never sent with current = co (the engine would 422 the whole request).
    expect(sentRow(payload, R_ODD, rows)).toMatchObject({ fixed: true, currentTeacherId: null, coTeacherId: null });
    // Anna's fixed load: 120 + both halves of the inconsistent row (30 + 30).
    expect(payload.teachers[0]!.fixedTenths).toBe(1800);
    // Bo co-teaches Sv 8A at 50 %: 60 fixed.
    expect(payload.teachers[1]!.fixedTenths).toBe(600);
  });

  it('with onlyUnstaffed off, keeps every staffed row free and KEPT, never unstaffable', async () => {
    const { service, sent } = setup();
    const proposal = await service.propose(ask({ onlyUnstaffed: false }), admin());
    expect(proposal.counts).toMatchObject({ freeRequirements: 4, keptRequirements: 1, openRequirements: 3, fixedRequirements: 1 });
    const payload = sent()[0]!;
    expect(sentRow(payload, R_MA7, schoolRows()['teachingRequirement']!)).toMatchObject({
      fixed: false,
      currentTeacherId: payload.teachers[0]!.id,
    });
    // Her kept row is no longer fixed load.
    expect(payload.teachers[0]!.fixedTenths).toBe(600);
  });

  it('keeps a pinned row as it is, and reports only the pins this year holds', async () => {
    const { service, sent } = setup();
    const stranger = '00000000-0000-4000-8000-0000000000ee';
    const proposal = await service.propose(ask({ pinnedRequirementIds: [R_MA8, stranger] }), admin());
    expect(proposal.options.pinnedRequirementIds).toEqual([R_MA8]);
    expect(sentRow(sent()[0]!, R_MA8, schoolRows()['teachingRequirement']!).fixed).toBe(true);
    expect(proposal.counts.freeRequirements).toBe(2);
  });

  it('charges what the report charges: split lengths, odd weeks and the FACTOR weight', async () => {
    const rows = schoolRows();
    rows['staffingPolicy']![0]!['loadModel'] = 'FACTOR';
    Object.assign(rows['teachingRequirement']!.find((row) => row['id'] === R_MA8)!, {
      lessonsPerWeek: 2,
      minutesPerLesson: 80,
      lessonLengths: [80, 40],
      recurrence: 'ODD_WEEKS',
    });
    const { service, sent } = setup(rows);
    const proposal = await service.propose(ask(), admin());
    // (80 + 40) × ½ × 1.2 = 72.
    expect(sentRow(sent()[0]!, R_MA8, rows)).toMatchObject({ chargeTenths: 720, lessonMinutes: 60 });
    expect(proposal.loadModel).toBe('FACTOR');
    // Anna's fixed Ma 7A is weighted too: 144 + 30 + 30.
    expect(sent()[0]!.teachers[0]!.fixedTenths).toBe(2040);
  });

  it('sends, with nothing recorded, who already teaches the subject as the eligibility — a preference, never respected', async () => {
    const { service, sent } = setup();
    const proposal = await service.propose(ask({ respectQualifications: true }), admin());
    const payload = sent()[0]!;
    expect(payload).toMatchObject({ qualificationsRecorded: false, respectQualifications: false });
    expect(proposal.options).toMatchObject({ respectQualifications: false, qualificationsRecorded: false });
    // Ma 8A: Anna leads Ma 7A. Sv 7A: Bo co-teaches Sv 8A, and Anna is on the Sv row twice.
    const set = (realId: string) =>
      payload.eligibilitySets.find((s) => s.id === sentRow(payload, realId, schoolRows()['teachingRequirement']!).eligibilitySetId)
        ?.teacherIds ?? [];
    expect(set(R_MA8)).toEqual([payload.teachers[0]!.id]);
    expect(set(R_SV7)).toEqual([payload.teachers[0]!.id, payload.teachers[1]!.id]);
  });

  it('sends, with behörigheter recorded, exactly the active staff holding a covering one', async () => {
    const rows = schoolRows();
    rows['teacherSubjectQualification'] = [
      { userId: ANNA, subjectId: MA, minGradeLevel: 7, maxGradeLevel: 9, kind: 'LEGITIMATION', validFrom: null, validTo: null },
      { userId: BO, subjectId: MA, minGradeLevel: 7, maxGradeLevel: 7, kind: 'BEHORIG', validFrom: null, validTo: null },
      { userId: CY, subjectId: MA, minGradeLevel: 1, maxGradeLevel: 9, kind: 'TILLATEN', validFrom: null, validTo: day('2026-01-01') },
      { userId: EVA, subjectId: MA, minGradeLevel: 1, maxGradeLevel: 9, kind: 'LEGITIMATION', validFrom: null, validTo: null },
    ];
    const { service, sent } = setup(rows);
    await service.propose(ask({ respectQualifications: true }), admin());
    const payload = sent()[0]!;
    expect(payload).toMatchObject({ qualificationsRecorded: true, respectQualifications: true });
    const ids = [ANNA, BO, CY, DAG, REKTOR];
    const quals = rows['teacherSubjectQualification']!.map((q) => ({ ...q, validTo: q['validTo'] ? '2026-01-01' : null })) as never;
    const ma8 = sentRow(payload, R_MA8, rows);
    const members = payload.eligibilitySets.find((s) => s.id === ma8.eligibilitySetId)!.teacherIds;
    const expected = ids.filter(
      (id) =>
        strongestCoveringQualification(quals, id, { subjectId: MA, gradeSpan: { min: 8, max: 8 } }, {
          startDate: '2026-08-17',
          endDate: '2027-06-11',
        }) !== null,
    );
    expect(expected).toEqual([ANNA]);
    expect(members).toEqual(expected.map((id) => payload.teachers[ids.indexOf(id)]!.id));
    // Sv has no holder: no set at all.
    expect(sentRow(payload, R_SV8, rows).eligibilitySetId).toBeNull();
  });

  it('forces respect under REFUSE, and says it was forced', async () => {
    const rows = schoolRows();
    rows['staffingPolicy']![0]!['qualificationMode'] = 'REFUSE';
    rows['teacherSubjectQualification'] = [
      { userId: ANNA, subjectId: MA, minGradeLevel: 7, maxGradeLevel: 9, kind: 'LEGITIMATION', validFrom: null, validTo: null },
    ];
    const { service, sent } = setup(rows);
    const proposal = await service.propose(ask({ respectQualifications: false }), admin());
    expect(sent()[0]!.respectQualifications).toBe(true);
    expect(proposal.options).toMatchObject({ respectQualifications: true, respectForcedByPolicy: true });
  });

  it('deduplicates identical eligibility sets', async () => {
    const rows = schoolRows();
    rows['teachingRequirement']!.push(requirement('00000000-0000-4000-8000-000000000006', G7A, MA));
    const { service, sent } = setup(rows);
    await service.propose(ask(), admin());
    const payload = sent()[0]!;
    const ma8 = sentRow(payload, R_MA8, rows);
    const second = sentRow(payload, '00000000-0000-4000-8000-000000000006', rows);
    expect(ma8.eligibilitySetId).not.toBeNull();
    expect(second.eligibilitySetId).toBe(ma8.eligibilitySetId);
    expect(new Set(payload.eligibilitySets.map((s) => s.teacherIds.join())).size).toBe(payload.eligibilitySets.length);
  });

  it('sends last year’s teachers of a rolled group, among the active staff only', async () => {
    const rows = schoolRows();
    rows['academicYear']!.push({ id: LAST_YEAR, schoolId: SCHOOL, name: '2025/26', startDate: day('2025-08-18'), endDate: day('2026-06-12'), isActive: false, predecessorId: null });
    rows['academicYear']![0]!['predecessorId'] = LAST_YEAR;
    rows['studentGroup']!.push({ id: G6A, academicYearId: LAST_YEAR, name: '6A', kind: 'CLASS', gradeLevel: 6, predecessorId: null });
    rows['studentGroup']!.find((g) => g['id'] === G7A)!['predecessorId'] = G6A;
    rows['teachingRequirement']!.push({ ...requirement(R_LAST, G6A, SV, { teacherId: EVA, coTeacherId: CY }), academicYearId: LAST_YEAR });
    const { service, sent } = setup(rows);
    const proposal = await service.propose(ask(), admin());
    const payload = sent()[0]!;
    const yearRows = rows['teachingRequirement']!.filter((row) => row['academicYearId'] === YEAR);
    // Eva led it but has left; Cy co-taught it and is still here.
    expect(sentRow(payload, R_SV7, yearRows).lastYearTeacherIds).toEqual([payload.teachers[2]!.id]);
    expect(sentRow(payload, R_MA8, yearRows).lastYearTeacherIds).toEqual([]);
    expect(proposal.status).toBe('OPTIMAL');
  });

  it('answers without the engine when every row is fixed', async () => {
    const rows = schoolRows();
    rows['teachingRequirement'] = rows['teachingRequirement']!.filter((row) => row['teacherId'] === ANNA);
    const { service, http, world } = setup(rows);
    const before = world.calls.length;
    const proposal = await service.propose(ask(), admin());
    expect(http.post).not.toHaveBeenCalled();
    expect(proposal).toMatchObject({ status: 'OPTIMAL', unstaffedProven: true, assignments: [], unstaffed: [], terms: null });
    expect(world.calls.slice(before).some((call) => ['create', 'update', 'updateMany', 'createMany'].includes(call.method))).toBe(false);
  });

  it('answers without the engine, NO_TEACHER_WITH_TARGET, when nobody has a target and nobody keeps a row (C9)', async () => {
    const rows = schoolRows();
    rows['staffingPolicy']![0]!['fullTimeTeachingMinutesPerWeek'] = null;
    const { service, http } = setup(rows);
    const proposal = await service.propose(ask(), admin());
    expect(http.post).not.toHaveBeenCalled();
    expect(proposal.counts.teachersWithTarget).toBe(1); // Dag's 0
    expect(proposal.unstaffed.map((row) => [row.requirementId, row.reason])).toEqual([
      [R_SV7, 'NO_TEACHER_WITH_TARGET'],
      [R_MA8, 'NO_TEACHER_WITH_TARGET'],
      [R_SV8, 'NO_TEACHER_WITH_TARGET'],
    ]);
  });

  it('refuses a payload past the engine’s body limit with STAFF_MODEL_TOO_LARGE, before calling it', async () => {
    const { service, http } = setup();
    const stringify = JSON.stringify;
    jest.spyOn(JSON, 'stringify').mockImplementation(((value: unknown, ...rest: never[]) =>
      value && typeof value === 'object' && 'eligibilitySets' in (value as object)
        ? 'x'.repeat(MAX_STAFF_BODY_BYTES + 1)
        : stringify(value, ...rest)) as typeof JSON.stringify);
    await expect(service.propose(ask(), admin())).rejects.toMatchObject({
      status: 400,
      response: { code: 'STAFF_MODEL_TOO_LARGE', params: { variables: expect.any(Number), limit: 1_000_000 } },
    });
    expect(http.post).not.toHaveBeenCalled();
  });

  it.each([404, 405])('names an engine without /staff (%i) STAFF_ENGINE_UNAVAILABLE, a 503 and not the year’s 404', async (status) => {
    const { service, http } = setup();
    const missing = new AxiosError('missing');
    missing.response = { status, data: { code: 'HTTP_ERROR', message: 'Not Found' } } as never;
    http.post.mockReturnValue(throwError(() => missing));
    await expect(service.propose(ask(), admin())).rejects.toMatchObject({
      status: 503,
      response: { code: STAFF_ENGINE_UNAVAILABLE },
    });
  });

  it('forwards the engine’s own STAFF_MODEL_TOO_LARGE with its code and numbers', async () => {
    const { service, http } = setup();
    const refused = new AxiosError('too large');
    refused.response = {
      status: 400,
      data: {
        code: 'INVALID_SCHEDULE_INPUT',
        message: 'There are too many possible teacher assignments to weigh in one go: about 1200000 model variables against a limit of 1000000.',
        details: { code: 'STAFF_MODEL_TOO_LARGE', params: { variables: 1_200_000, limit: 1_000_000 } },
      },
    } as never;
    http.post.mockReturnValue(throwError(() => refused));
    await expect(service.propose(ask(), admin())).rejects.toMatchObject({
      status: 400,
      response: { code: 'STAFF_MODEL_TOO_LARGE', params: { variables: 1_200_000, limit: 1_000_000 } },
    });
  });

  it('404s an academic year RLS hides', async () => {
    const { service } = setup();
    await expect(service.propose(ask({ academicYearId: 'a0000000-0000-4000-8000-0000000000ff' }), admin())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('returns each lead change with its reasons, and every teacher before → after with the matrix’s own figures', async () => {
    const { service } = setup();
    const proposal = await service.propose(ask(), admin());
    // The stand-in gives each open row to the first normal teacher with room:
    // Anna (180 + 120 + 120 ≤ 660), then Sv 8A — Bo is its co-teacher, so Anna again.
    expect(proposal.assignments.map((a) => [a.requirementId, a.fromTeacherId, a.toTeacherId])).toEqual([
      [R_SV7, EVA, ANNA],
      [R_MA8, null, ANNA],
      [R_SV8, null, ANNA],
    ]);
    expect(proposal.assignments[1]).toMatchObject({
      subjectId: MA,
      studentGroupId: G8A,
      chargeMinutesPerWeek: 120,
      reasons: { qualificationKind: null, familiarWithSubject: true, taughtLastYear: false, teachesGroupAlready: true },
    });
    const anna = proposal.teachers.find((t) => t.userId === ANNA)!;
    expect(anna).toEqual({
      userId: ANNA,
      targetMinutesPerWeek: 600,
      limitMinutesPerWeek: 660,
      keepOrShed: false,
      before: { countedMinutesPerWeek: 180, countedExact: 180, percentOfTarget: 30, status: 'UNDER' },
      after: { countedMinutesPerWeek: 540, countedExact: 540, percentOfTarget: 90, status: 'OK' },
    });
    expect(proposal.teachers.find((t) => t.userId === CY)).toMatchObject({ keepOrShed: true, targetMinutesPerWeek: null });
    expect(proposal.teachers.find((t) => t.userId === DAG)).toMatchObject({ keepOrShed: true, before: { percentOfTarget: null } });
    expect(proposal.teachers.map((t) => t.userId)).toEqual([ANNA, BO, CY, DAG, REKTOR]);
    expect(proposal.basisSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('marks NO_QUALIFIED_TEACHER rows whose only qualified teacher is their own co-teacher', async () => {
    const rows = schoolRows();
    rows['teacherSubjectQualification'] = [
      { userId: BO, subjectId: SV, minGradeLevel: 7, maxGradeLevel: 9, kind: 'LEGITIMATION', validFrom: null, validTo: null },
    ];
    const { service } = setup(rows, (payload) => {
      const answer = engineAnswer(payload);
      return { ...answer, unstaffed: answer.unstaffed.map((row) => ({ ...row, reason: 'NO_QUALIFIED_TEACHER' as const })) };
    });
    const proposal = await service.propose(ask({ respectQualifications: true }), admin());
    const sv8 = proposal.unstaffed.find((row) => row.requirementId === R_SV8)!;
    expect(sv8).toMatchObject({ reason: 'NO_QUALIFIED_TEACHER', onlyCoTeacherQualified: true, chargeMinutesPerWeek: 120 });
    expect(proposal.unstaffed.find((row) => row.requirementId === R_MA8)!.onlyCoTeacherQualified).toBe(false);
  });

  it('realises conflicts itself: subjects to names, rows to "Matematik för 8A", teachers to real ids in their own field only', async () => {
    const { service } = setup(undefined, (payload) => {
      const answer = engineAnswer(payload);
      const rows = schoolRows()['teachingRequirement']!;
      const ma8 = sentRow(payload, R_MA8, rows);
      return {
        ...answer,
        conflicts: [
          {
            code: 'STAFF_CAPACITY_EXHAUSTED_FOR_SUBJECT',
            params: { subject: ma8.subjectId, count: 1, demandedMinutes: 120, availableMinutes: 60, shortMinutes: 60 },
            message: `${ma8.subjectId} needs 120 minutes a week …`,
            requirementIds: [ma8.id],
            teacherIds: [],
            subjectIds: [ma8.subjectId],
          },
          {
            code: 'STAFF_TEACHER_CAPACITY_ZERO',
            params: { fixedMinutes: 660, limitMinutes: 660 },
            message: 'Already carries 660 minutes a week against a limit of 660, so no further curriculum entry fits.',
            requirementIds: [],
            teacherIds: [payload.teachers[1]!.id],
            subjectIds: [],
          },
        ],
      };
    });
    const proposal = await service.propose(ask(), admin());
    expect(proposal.conflicts).toEqual([
      {
        code: 'STAFF_CAPACITY_EXHAUSTED_FOR_SUBJECT',
        params: { subject: 'Matematik', count: 1, demandedMinutes: 120, availableMinutes: 60, shortMinutes: 60 },
        message: 'Matematik needs 120 minutes a week …',
        requirementIds: [R_MA8],
        requirementNames: ['Matematik för 8A'],
        subjectIds: [MA],
        teacherIds: [],
      },
      expect.objectContaining({ code: 'STAFF_TEACHER_CAPACITY_ZERO', teacherIds: [BO], params: { fixedMinutes: 660, limitMinutes: 660 } }),
    ]);
    // Never a person: no name or email anywhere in the conflicts.
    expect(JSON.stringify(proposal.conflicts)).not.toMatch(/Bo|bo@|Anna/);
  });

  describe('refuses (502) an answer outside the question asked', () => {
    const rows = schoolRows()['teachingRequirement']!;
    const cases: [string, (payload: StaffRequest, answer: StaffResponse) => StaffResponse][] = [
      ['an unknown requirement id', (_p, a) => ({ ...a, assignments: [...a.assignments, { requirementId: 'f0000000-0000-4000-8000-000000000000', teacherId: _p.teachers[0]!.id }] })],
      ['an unknown teacher id', (p, a) => ({ ...a, assignments: a.assignments.map((x, i) => (i === 0 ? { ...x, teacherId: 'f0000000-0000-4000-8000-000000000000' } : x)) })],
      ['a fixed row assigned', (p, a) => ({ ...a, assignments: [...a.assignments, { requirementId: sentRow(p, R_MA7, rows).id, teacherId: p.teachers[0]!.id }] })],
      ['a row assigned twice', (p, a) => ({ ...a, assignments: [...a.assignments, a.assignments[0]!] })],
      ['an open row both assigned and unstaffed', (p, a) => ({ ...a, unstaffed: [{ requirementId: a.assignments[0]!.requirementId, reason: 'NO_CAPACITY_LEFT' }] })],
      ['an open row neither', (p, a) => ({ ...a, assignments: a.assignments.slice(1) })],
      ['a co-teacher as lead', (p, a) => ({ ...a, assignments: a.assignments.map((x) => (x.requirementId === sentRow(p, R_SV8, rows).id ? { ...x, teacherId: p.teachers[1]!.id } : x)) })],
      ['a keep-or-shed teacher given a row not theirs', (p, a) => ({ ...a, assignments: a.assignments.map((x, i) => (i === 0 ? { ...x, teacherId: p.teachers[2]!.id } : x)) })],
      ['a reason the gateway has never heard of', (p, a) => ({ ...a, assignments: a.assignments.slice(1), unstaffed: [{ requirementId: a.assignments[0]!.requirementId, reason: 'BECAUSE' as never }] })],
      ['a status that is not a proposal', (_p, a) => ({ ...a, status: 'INFEASIBLE' as never })],
      ['a conflict naming an unknown subject', (_p, a) => ({ ...a, conflicts: [{ code: 'X', params: { subject: 'f0000000-0000-4000-8000-000000000000' }, message: '', requirementIds: [], teacherIds: [], subjectIds: [] }] })],
    ];
    // Two parameters exactly: a third would be read as jest's `done`.
    it.each(cases)('%s', async (_name, corrupt) => {
      const { service } = setup(undefined, (payload) => corrupt(payload, engineAnswer(payload)));
      await expect(service.propose(ask(), admin())).rejects.toMatchObject({ status: 502 });
    });

    it('a kept row unstaffed', async () => {
      const { service } = setup(undefined, (p) => {
        const a = engineAnswer(p);
        const kept = sentRow(p, R_MA7, rows).id;
        return { ...a, assignments: a.assignments.filter((x) => x.requirementId !== kept), unstaffed: [...a.unstaffed, { requirementId: kept, reason: 'NO_CAPACITY_LEFT' }] };
      });
      await expect(service.propose(ask({ onlyUnstaffed: false }), admin())).rejects.toMatchObject({ status: 502 });
    });

    it('an unqualified pair under respect', async () => {
      const withQuals = schoolRows();
      withQuals['teacherSubjectQualification'] = [
        { userId: ANNA, subjectId: MA, minGradeLevel: 7, maxGradeLevel: 9, kind: 'LEGITIMATION', validFrom: null, validTo: null },
      ];
      const { service } = setup(withQuals, (p) => {
        const a = engineAnswer(p);
        // Rektor, a normal teacher with room, but holding nothing in Ma.
        return { ...a, assignments: a.assignments.map((x) => (x.requirementId === sentRow(p, R_MA8, rows).id ? { ...x, teacherId: p.teachers[4]!.id } : x)), unstaffed: a.unstaffed.filter((x) => x.requirementId !== sentRow(p, R_MA8, rows).id) };
      });
      await expect(service.propose(ask({ respectQualifications: true }), admin())).rejects.toMatchObject({ status: 502 });
    });

    it('a growing teacher put OVER, by the exact recount', async () => {
      const big = schoolRows();
      big['teachingRequirement']!.find((row) => row['id'] === R_MA8)!['lessonsPerWeek'] = 9;
      const { service } = setup(big, (p) => {
        const a = engineAnswer(p);
        const ma8 = sentRow(p, R_MA8, big['teachingRequirement']!).id;
        // Bo (limit 330) given 540 minutes.
        return { ...a, assignments: [...a.assignments.filter((x) => x.requirementId !== ma8), { requirementId: ma8, teacherId: p.teachers[1]!.id }], unstaffed: a.unstaffed.filter((x) => x.requirementId !== ma8) };
      });
      await expect(service.propose(ask(), admin())).rejects.toBeInstanceOf(HttpException);
      await expect(service.propose(ask(), admin())).rejects.toMatchObject({ status: 502 });
    });
  });

  describe('the basis', () => {
    const basis = async (rows: Record<string, Row[]>) => (await setup(rows).service.propose(ask(), admin())).basisSha256;

    it('does not move with the order rows are read in, or with the options', async () => {
      const rows = schoolRows();
      const reversed = schoolRows();
      reversed['teachingRequirement']!.reverse();
      reversed['teacherEmployment']!.reverse();
      expect(await basis(reversed)).toBe(await basis(rows));
      const pinned = await setup(rows).service.propose(ask({ onlyUnstaffed: false, pinnedRequirementIds: [R_MA8] }), admin());
      expect(pinned.basisSha256).toBe(await basis(rows));
    });

    it.each<[string, (rows: Record<string, Row[]>) => void]>([
      ['a lead', (r) => void (r['teachingRequirement']![2]!['teacherId'] = BO)],
      ['a co-teacher', (r) => void (r['teachingRequirement']![2]!['coTeacherId'] = CY)],
      ['the lessons', (r) => void (r['teachingRequirement']![2]!['lessonsPerWeek'] = 3)],
      ['the lengths', (r) => void Object.assign(r['teachingRequirement']![2]!, { lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40] })],
      ['a load percent', (r) => void (r['teachingRequirement']![3]!['coTeacherLoadPercent'] = 60)],
      ['the recurrence', (r) => void (r['teachingRequirement']![2]!['recurrence'] = 'EVEN_WEEKS')],
      ['a row’s dates', (r) => void (r['teachingRequirement']![2]!['endDate'] = day('2027-01-15'))],
      ['a post', (r) => void (r['teacherEmployment']![1]!['employmentPercent'] = new Prisma.Decimal('60.000'))],
      ['a target override', (r) => void (r['teacherEmployment']![0]!['teachingTargetMinutesPerWeek'] = 500)],
      ['a counted uppdrag', (r) => void (r['teacherDuty'] = [{ userId: BO, academicYearId: YEAR, minutesPerWeek: 40, countsAsTeaching: true }])],
      ['a behörighet', (r) => void (r['teacherSubjectQualification'] = [{ userId: BO, subjectId: MA, minGradeLevel: 7, maxGradeLevel: 9, kind: 'BEHORIG', validFrom: null, validTo: null }])],
      ['a lov', (r) => void (r['schoolBreak'] = [{ academicYearId: YEAR, startDate: day('2026-10-26'), endDate: day('2026-10-30'), minGradeLevel: null, maxGradeLevel: null }])],
      ['the riktmärke', (r) => void (r['staffingPolicy']![0]!['fullTimeTeachingMinutesPerWeek'] = 700)],
      ['the tolerance', (r) => void (r['staffingPolicy']![0]!['overAllocationTolerancePercent'] = 5)],
      ['the load model', (r) => void (r['staffingPolicy']![0]!['loadModel'] = 'FACTOR')],
      ['the qualification mode', (r) => void (r['staffingPolicy']![0]!['qualificationMode'] = 'REFUSE')],
      ['the load mode', (r) => void (r['staffingPolicy']![0]!['overAllocationMode'] = 'OFF')],
      ['who is active', (r) => void (r['user']!.find((u) => u['id'] === CY)!['isActive'] = false)],
    ])('changes with %s', async (_name, change) => {
      const rows = schoolRows();
      change(rows);
      expect(await basis(rows)).not.toBe(await basis(schoolRows()));
    });
  });
});

// ---------------------------------------------------------------------------

describe('StaffingProposalService.apply', () => {
  /** Locks answered as Postgres would, every raw statement recorded in order. */
  const givenLocks = (world: RolloverWorld) => {
    const fallback = world.queryRaw;
    world.queryRaw = (sql, values) => {
      if (sql.includes('"TeacherEmployments"')) {
        const ids = values[0] as string[];
        return (world.rows['teacherEmployment'] ?? []).filter((row) => ids.includes(row['id'] as string)).map((row) => ({ id: row['id'] }));
      }
      if (sql.includes('"TeachingRequirements"')) return (values[0] as string[]).map((id) => ({ id }));
      return fallback(sql, values);
    };
  };

  const proposeThenApply = async (rows = schoolRows()) => {
    const context = setup(rows);
    givenLocks(context.world);
    const proposal: StaffingProposal = await context.service.propose(ask(), admin());
    return { ...context, proposal };
  };
  const changesOf = (proposal: StaffingProposal) =>
    proposal.assignments.map((a) => ({ requirementId: a.requirementId, fromTeacherId: a.fromTeacherId, toTeacherId: a.toTeacherId }));
  const leadOf = (world: RolloverWorld, id: string) => world.rows['teachingRequirement']!.find((row) => row['id'] === id)!['teacherId'];

  it('locks the year, then the posts, then the rows, then reads — and writes the leads, one log row, and the basis a fresh read gives', async () => {
    const { service, world, proposal } = await proposeThenApply();
    const start = world.calls.length;
    const result = await service.apply(
      { academicYearId: YEAR, basisSha256: proposal.basisSha256, changes: changesOf(proposal) },
      admin(),
    );
    const calls = world.calls.slice(start);
    const order = calls.map((call) => (call.sql ? call.sql.slice(0, 60) : `${call.model}.${call.method}`));
    const at = (needle: string) => order.findIndex((entry) => entry.includes(needle));
    expect(at('pg_advisory_xact_lock')).toBe(0);
    expect(at('teacherEmployment.findMany')).toBeGreaterThan(at('pg_advisory_xact_lock'));
    const employmentLock = calls.findIndex((call) => call.sql?.includes('"TeacherEmployments"'));
    const rowLock = calls.findIndex((call) => call.sql?.includes('"TeachingRequirements"'));
    expect(employmentLock).toBeGreaterThan(at('teacherEmployment.findMany'));
    expect(rowLock).toBeGreaterThan(employmentLock);
    expect(calls[rowLock]!.sql).toContain('FOR NO KEY UPDATE');
    expect(calls[rowLock]!.values![0]).toEqual([R_SV7, R_MA8, R_SV8]);
    expect(at('academicYear.findUnique')).toBeGreaterThan(rowLock);

    expect([leadOf(world, R_SV7), leadOf(world, R_MA8), leadOf(world, R_SV8)]).toEqual([ANNA, ANNA, ANNA]);
    // Grouped by (from, to): Eva → Anna, and nobody → Anna.
    expect(calls.filter((call) => call.method === 'updateMany')).toHaveLength(2);
    expect(world.rows['scheduleChangeLog']).toHaveLength(1);
    expect(world.rows['scheduleChangeLog']![0]).toMatchObject({
      schoolId: SCHOOL,
      academicYearId: YEAR,
      masterLessonId: null,
      actorId: REKTOR,
      action: 'UPDATE',
      before: { kind: 'STAFFING_PROPOSAL', changes: [{ requirementId: R_SV7, teacherId: EVA }, { requirementId: R_MA8, teacherId: null }, { requirementId: R_SV8, teacherId: null }] },
      after: { kind: 'STAFFING_PROPOSAL', undo: false, basisBefore: proposal.basisSha256, basisAfter: result.basisSha256 },
    });
    expect(JSON.stringify(world.rows['scheduleChangeLog'])).not.toMatch(/minutes|target|Anna|Matematik/i);
    expect(result).toMatchObject({ updated: 3, warnings: [], logId: world.rows['scheduleChangeLog']![0]!['id'] });

    // A fresh proposal reads the basis apply returned.
    const fresh = await service.propose(ask(), admin());
    expect(fresh.basisSha256).toBe(result.basisSha256);
  });

  it('undoes an apply with the changes swapped and the returned basis — putting back a lead who has left, and nobody', async () => {
    const { service, world, proposal } = await proposeThenApply();
    const applied = await service.apply({ academicYearId: YEAR, basisSha256: proposal.basisSha256, changes: changesOf(proposal) }, admin());
    const undo = changesOf(proposal).map((c) => ({ requirementId: c.requirementId, fromTeacherId: c.toTeacherId, toTeacherId: c.fromTeacherId }));
    const undone = await service.apply({ academicYearId: YEAR, basisSha256: applied.basisSha256, undo: true, changes: undo }, admin());
    expect([leadOf(world, R_SV7), leadOf(world, R_MA8), leadOf(world, R_SV8)]).toEqual([EVA, null, null]);
    expect(undone.basisSha256).toBe(proposal.basisSha256);
    expect(world.rows['scheduleChangeLog']).toHaveLength(2);
    expect(world.rows['scheduleChangeLog']![1]!['after']).toMatchObject({ undo: true });
  });

  it('refuses STAFF_PROPOSAL_STALE when the tjänstefördelning changed since, writing nothing', async () => {
    const { service, world, proposal } = await proposeThenApply();
    world.rows['teachingRequirement']!.find((row) => row['id'] === R_MA7)!['lessonsPerWeek'] = 4;
    await expect(
      service.apply({ academicYearId: YEAR, basisSha256: proposal.basisSha256, changes: changesOf(proposal) }, admin()),
    ).rejects.toMatchObject({ status: 409, response: { code: STAFF_PROPOSAL_STALE } });
    expect(leadOf(world, R_MA8)).toBeNull();
    expect(world.rows['scheduleChangeLog']).toHaveLength(0);
  });

  it('refuses a change whose from-lead is not the row’s as stale', async () => {
    const { service, proposal } = await proposeThenApply();
    await expect(
      service.apply(
        { academicYearId: YEAR, basisSha256: proposal.basisSha256, changes: [{ requirementId: R_MA8, fromTeacherId: BO, toTeacherId: ANNA }] },
        admin(),
      ),
    ).rejects.toMatchObject({ status: 409, response: { code: STAFF_PROPOSAL_STALE } });
  });

  it.each<[string, Record<string, unknown>, boolean?]>([
    ['the same row twice', { changes: [{ requirementId: R_MA8, fromTeacherId: null, toTeacherId: ANNA }, { requirementId: R_MA8, fromTeacherId: null, toTeacherId: BO }] }],
    ['nobody, without undo', { changes: [{ requirementId: R_MA7, fromTeacherId: ANNA, toTeacherId: null }] }],
    ['the lead it has', { changes: [{ requirementId: R_MA7, fromTeacherId: ANNA, toTeacherId: ANNA }] }],
    ['a row of no year here', { changes: [{ requirementId: 'f0000000-0000-4000-8000-000000000000', fromTeacherId: null, toTeacherId: ANNA }] }],
    ['somebody who is not active staff', { changes: [{ requirementId: R_MA8, fromTeacherId: null, toTeacherId: EVA }] }],
    ['a pupil, even on an undo', { undo: true, changes: [{ requirementId: R_MA8, fromTeacherId: null, toTeacherId: PUPIL }] }],
    ['the row’s co-teacher as its lead', { changes: [{ requirementId: R_SV8, fromTeacherId: null, toTeacherId: BO }] }],
  ])('400s %s', async (_name, body) => {
    const { service, world, proposal } = await proposeThenApply();
    await expect(
      service.apply({ academicYearId: YEAR, basisSha256: proposal.basisSha256, ...body } as never, admin()),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(world.rows['scheduleChangeLog']).toHaveLength(0);
  });

  it('does not refuse a swap under REFUSE, though one row at a time would', async () => {
    const rows = schoolRows();
    rows['staffingPolicy']![0]!['overAllocationMode'] = 'REFUSE';
    // Bo (limit 330) and Rektor each lead a 300-minute row of Sv.
    rows['teachingRequirement']!.push(
      requirement('00000000-0000-4000-8000-0000000000b1', G7A, SV, { teacherId: BO, lessonsPerWeek: 5 }),
      requirement('00000000-0000-4000-8000-0000000000b2', G8A, SV, { teacherId: REKTOR, lessonsPerWeek: 5 }),
    );
    const { service, world, proposal } = await proposeThenApply(rows);
    const result = await service.apply(
      {
        academicYearId: YEAR,
        basisSha256: proposal.basisSha256,
        changes: [
          { requirementId: '00000000-0000-4000-8000-0000000000b1', fromTeacherId: BO, toTeacherId: REKTOR },
          { requirementId: '00000000-0000-4000-8000-0000000000b2', fromTeacherId: REKTOR, toTeacherId: BO },
        ],
      },
      admin(),
    );
    expect(result.warnings).toEqual([]);
    expect(leadOf(world, '00000000-0000-4000-8000-0000000000b1')).toBe(REKTOR);
  });

  it('refuses under REFUSE with a named 409: the code, the params with whom and which row, the row’s name first', async () => {
    const rows = schoolRows();
    rows['staffingPolicy']![0]!['overAllocationMode'] = 'REFUSE';
    rows['teachingRequirement']!.find((row) => row['id'] === R_MA8)!['lessonsPerWeek'] = 5;
    const { service, world, proposal } = await proposeThenApply(rows);
    let thrown: unknown;
    try {
      await service.apply(
        { academicYearId: YEAR, basisSha256: proposal.basisSha256, changes: [{ requirementId: R_MA8, fromTeacherId: null, toTeacherId: BO }] },
        admin(),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConflictException);
    expect((thrown as ConflictException).getResponse()).toEqual({
      code: 'STAFF_TEACHER_OVER_TARGET',
      message: 'Matematik för 8A: Läraren skulle få 360 min/v mot riktmärket 300 min/v (gränsen är 330 min/v med 10 % tolerans).',
      params: { role: 'TEACHER', minutes: 360, target: 300, limit: 330, tolerance: 10, userId: BO, requirementId: R_MA8 },
    });
    expect(leadOf(world, R_MA8)).toBeNull();
    expect(world.rows['scheduleChangeLog']).toHaveLength(0);
  });

  it('hands back WARNs naming the teacher and the rows, and writes', async () => {
    const rows = schoolRows();
    rows['teachingRequirement']!.find((row) => row['id'] === R_MA8)!['lessonsPerWeek'] = 5;
    const { service, world, proposal } = await proposeThenApply(rows);
    const result = await service.apply(
      { academicYearId: YEAR, basisSha256: proposal.basisSha256, changes: [{ requirementId: R_MA8, fromTeacherId: null, toTeacherId: BO }] },
      admin(),
    );
    expect(result.warnings).toEqual([
      { code: 'STAFF_TEACHER_OVER_TARGET', params: expect.objectContaining({ minutes: 360 }), userId: BO, requirementIds: [R_MA8] },
    ]);
    expect(leadOf(world, R_MA8)).toBe(BO);
  });
});
