import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { of } from 'rxjs';
import { testUser } from '../../test/utils/prisma-mock';
import { givenRolloverWorld, prismaFor, type Row } from '../../test/utils/rollover-world';
import type { PrismaService } from '../database/prisma.service';
import type { StaffRequest, StaffResponse } from './interfaces/staffing.interface';
import { OptimizationProxyService } from './optimization-proxy.service';
import { STAFF_PATH, StaffingProposalService } from './staffing-proposal.service';

/**
 * The staffing proposal's wire contract, pinned from the gateway's side.
 *
 * The mirror is optimization-engine/tests/test_staffing.py
 * (test_the_wire_contract_is_exactly_what_the_gateway_sends_and_reads). The
 * engine's models forbid extra fields, so one name here the engine has not
 * heard of is a 422 for the whole proposal: change both lists in the commit
 * that deploys the engine, engine first. ai-engine-contract.spec.ts — the
 * /optimize and /optimize-rooms contract — is untouched by this route.
 *
 * And the privacy half: nothing crosses but opaque ids minted for the request
 * and integers. Every string in the payload is a fresh v4 uuid that is none of
 * the school's real ids; no name, email, signature, subject or group name.
 */

const REQUEST_FIELDS = [
  'eligibilitySets',
  'qualificationsRecorded',
  'requestId',
  'requirements',
  'respectQualifications',
  'teachers',
  'weights',
];
const WEIGHT_FIELDS = ['balance', 'classTeachers', 'continuity', 'keepCurrent', 'unqualified'];
const SET_FIELDS = ['id', 'teacherIds'];
const TEACHER_FIELDS = ['fixedTenths', 'floorTenths', 'id', 'limitTenths', 'targetTenths'];
const REQUIREMENT_FIELDS = [
  'chargeTenths',
  'coTeacherId',
  'currentTeacherId',
  'eligibilitySetId',
  'fixed',
  'id',
  'lastYearTeacherIds',
  'lessonMinutes',
  'maxGradeLevel',
  'minGradeLevel',
  'studentGroupId',
  'subjectId',
];
/** What the gateway reads back; the engine's StaffResponse and its parts. */
const RESPONSE_FIELDS = ['assignments', 'conflicts', 'requestId', 'status', 'terms', 'unstaffed', 'unstaffedProven'];
const ASSIGNMENT_FIELDS = ['requirementId', 'teacherId'];
const UNSTAFFED_FIELDS = ['reason', 'requirementId'];
const CONFLICT_FIELDS = ['code', 'message', 'params', 'requirementIds', 'subjectIds', 'teacherIds'];
const TERMS_FIELDS = [
  'continuityChanges',
  'currentChanges',
  'deviationTenths',
  'newClassTeachers',
  'underBandTenths',
  'unqualifiedAssignments',
  'unstaffedMinutes',
  'unstaffedRows',
];

const SCHOOL = '33333333-3333-4333-8333-333333333333';
const YEAR = 'a0000000-0000-4000-8000-00000000000a';
const G7A = 'b0000000-0000-4000-8000-000000000007';
const G7B = 'b0000000-0000-4000-8000-00000000007b';
const MA = 'e0000000-0000-4000-8000-0000000000aa';
const ANNA = 'd0000000-0000-4000-8000-00000000000a';
const BO = 'd0000000-0000-4000-8000-00000000000b';
/** On no row at all: must still be sent, or a new teacher could never be proposed. */
const NEW = 'd0000000-0000-4000-8000-0000000000ff';

const rows = (): Record<string, Row[]> => ({
  academicYear: [
    { id: YEAR, schoolId: SCHOOL, name: '2026/27', startDate: new Date('2026-08-17'), endDate: new Date('2027-06-11'), isActive: true, predecessorId: null },
  ],
  studentGroup: [
    { id: G7A, academicYearId: YEAR, name: '7A Hjortarna', kind: 'CLASS', gradeLevel: 7, predecessorId: null },
    { id: G7B, academicYearId: YEAR, name: '7B Rävarna', kind: 'CLASS', gradeLevel: 7, predecessorId: null },
  ],
  user: [
    { id: BO, role: 'TEACHER', isActive: true, firstName: 'Bo', lastName: 'Ek', email: 'bo.ek@skolan.se' },
    { id: NEW, role: 'TEACHER', isActive: true, firstName: 'Ny', lastName: 'Lärare', email: 'ny@skolan.se' },
    { id: ANNA, role: 'TEACHER', isActive: true, firstName: 'Anna', lastName: 'Al', email: 'anna.al@skolan.se' },
  ],
  studentGroupMember: [],
  subject: [{ id: MA, name: 'Matematik', loadFactor: new Prisma.Decimal('1.00') }],
  staffingPolicy: [
    {
      schoolId: SCHOOL,
      fullTimeTeachingMinutesPerWeek: 600,
      fullTimeRegulatedHoursPerYear: 1360,
      workDaysPerYear: 194,
      qualificationMode: 'WARN',
      overAllocationMode: 'WARN',
      overAllocationTolerancePercent: 10,
      loadModel: 'MINUTES',
      unstaffedGeneration: 'ALLOW',
    },
  ],
  teacherEmployment: [ANNA, BO, NEW].map((userId, i) => ({
    id: `f3000000-0000-4000-8000-00000000000${i}`,
    userId,
    academicYearId: YEAR,
    employmentPercent: new Prisma.Decimal('100.000'),
    reductionPercent: new Prisma.Decimal('0.000'),
    contractKind: 'FERIE',
    teachingTargetMinutesPerWeek: null,
    signature: ['ANAL', 'BOEK', 'NYLA'][i],
  })),
  teachingRequirement: [
    // Read in reverse id order, so canonical order is the gateway's doing.
    { id: '00000000-0000-4000-8000-000000000003', academicYearId: YEAR, subjectId: MA, studentGroupId: G7B, teacherId: null, coTeacherId: null, lessonsPerWeek: 2, minutesPerLesson: 60, lessonLengths: [], teacherLoadPercent: 100, coTeacherLoadPercent: 100, recurrence: 'ALL_WEEKS', startDate: null, endDate: null },
    { id: '00000000-0000-4000-8000-000000000002', academicYearId: YEAR, subjectId: MA, studentGroupId: G7A, teacherId: null, coTeacherId: null, lessonsPerWeek: 2, minutesPerLesson: 60, lessonLengths: [], teacherLoadPercent: 100, coTeacherLoadPercent: 100, recurrence: 'ALL_WEEKS', startDate: null, endDate: null },
    { id: '00000000-0000-4000-8000-000000000001', academicYearId: YEAR, subjectId: MA, studentGroupId: G7A, teacherId: ANNA, coTeacherId: BO, lessonsPerWeek: 3, minutesPerLesson: 60, lessonLengths: [], teacherLoadPercent: 100, coTeacherLoadPercent: 100, recurrence: 'ALL_WEEKS', startDate: null, endDate: null },
  ],
  teacherSubjectQualification: [
    { userId: ANNA, subjectId: MA, minGradeLevel: 7, maxGradeLevel: 9, kind: 'LEGITIMATION', validFrom: null, validTo: null },
    { userId: NEW, subjectId: MA, minGradeLevel: 7, maxGradeLevel: 9, kind: 'BEHORIG', validFrom: null, validTo: null },
  ],
  teacherDuty: [],
  schoolBreak: [],
});

const keys = (value: object) => Object.keys(value).sort();
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Every string anywhere in a value. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

async function sendOnce(weights?: Record<string, number>) {
  const world = givenRolloverWorld(rows());
  const prisma = prismaFor(world);
  const http = {
    post: jest.fn((_url: string, payload: StaffRequest) =>
      of({
        data: {
          requestId: payload.requestId,
          status: 'OPTIMAL',
          unstaffedProven: true,
          assignments: payload.requirements.filter((r) => !r.fixed).map((r) => ({ requirementId: r.id, teacherId: payload.teachers[0]!.id })),
          unstaffed: [],
          conflicts: [],
          terms: {
            before: Object.fromEntries(TERMS_FIELDS.map((f) => [f, 0])),
            after: Object.fromEntries(TERMS_FIELDS.map((f) => [f, 0])),
          },
        } as unknown as StaffResponse,
      }),
    ),
  };
  const config = { getOrThrow: jest.fn().mockReturnValue({ baseUrl: 'http://solver.test', apiKey: 'k'.repeat(32), timeoutMs: 50 }) };
  const proxy = new OptimizationProxyService(prisma as unknown as PrismaService, http as never, config as never);
  const call = jest.spyOn(proxy, 'callAiEngine');
  const service = new StaffingProposalService(prisma as unknown as PrismaService, proxy);
  await service.propose(
    { academicYearId: YEAR, onlyUnstaffed: true, respectQualifications: true, ...(weights ? { weights } : {}) },
    testUser({ schoolId: SCHOOL }),
  );
  const [url, payload] = http.post.mock.calls[0]! as [string, StaffRequest];
  return { url, payload, call };
}

describe('the /staff wire contract', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('sends exactly the fields the engine’s models declare', async () => {
    const { url, payload } = await sendOnce({ balance: 7, unqualified: 0 });
    expect(url).toBe(`http://solver.test${STAFF_PATH}`);
    expect(keys(payload)).toEqual(REQUEST_FIELDS);
    for (const teacher of payload.teachers) expect(keys(teacher)).toEqual(TEACHER_FIELDS);
    for (const requirement of payload.requirements) expect(keys(requirement)).toEqual(REQUIREMENT_FIELDS);
    for (const set of payload.eligibilitySets) expect(keys(set)).toEqual(SET_FIELDS);
    // Only the weights the caller set; the engine's defaults fill the rest.
    expect(payload.weights).toEqual({ balance: 7, unqualified: 0 });
    for (const key of Object.keys(payload.weights)) expect(WEIGHT_FIELDS).toContain(key);
  });

  it('names the response fields the gateway reads', () => {
    // The stand-in answer above is built from these lists; the gateway's
    // StaffResponse type is checked against them here so a rename on either
    // side shows up as a diff to read.
    const response: Record<keyof StaffResponse, true> = {
      requestId: true,
      status: true,
      unstaffedProven: true,
      assignments: true,
      unstaffed: true,
      conflicts: true,
      terms: true,
    };
    expect(keys(response)).toEqual(RESPONSE_FIELDS);
    expect(ASSIGNMENT_FIELDS).toEqual(['requirementId', 'teacherId']);
    expect(UNSTAFFED_FIELDS).toEqual(['reason', 'requirementId']);
    expect(CONFLICT_FIELDS).toHaveLength(6);
  });

  it('sends no name, email, signature, subject or group name — only fresh v4 uuids that are none of the real ids', async () => {
    const { payload } = await sendOnce();
    const text = JSON.stringify(payload);
    for (const word of ['Anna', 'Bo', 'Ek', 'skolan', '@', 'ANAL', 'BOEK', 'Matematik', 'Hjortarna', 'Rävarna', '7A', 'FERIE', 'LEGITIMATION', 'BEHORIG']) {
      expect(text).not.toContain(word);
    }
    const real = new Set([SCHOOL, YEAR, G7A, G7B, MA, ANNA, BO, NEW, ...rows()['teachingRequirement']!.map((r) => r['id'] as string)]);
    const sent = strings(payload);
    expect(sent.length).toBeGreaterThan(10);
    for (const value of sent) {
      expect(value).toMatch(V4);
      expect(real.has(value)).toBe(false);
    }
    // Two requests, two sets of ids: nothing links one to the next by id.
    const again = await sendOnce();
    expect(again.payload.teachers[0]!.id).not.toBe(payload.teachers[0]!.id);
  });

  it('sends a teacher who is on no row, in canonical order, and deduplicates the eligibility sets', async () => {
    const { payload } = await sendOnce();
    // Anna, Bo, the new one: by real id, though the table read them otherwise.
    expect(payload.teachers).toHaveLength(3);
    expect(payload.teachers.map((t) => t.fixedTenths)).toEqual([1800, 1800, 0]);
    // Rows by real id: the fixed 001 first, then the two open ones.
    expect(payload.requirements.map((r) => r.fixed)).toEqual([true, false, false]);
    // Both open rows are covered by Anna and the new teacher: one set, named twice.
    expect(payload.eligibilitySets).toHaveLength(1);
    expect(payload.eligibilitySets[0]!.teacherIds).toEqual([payload.teachers[0]!.id, payload.teachers[2]!.id]);
    expect(payload.requirements[1]!.eligibilitySetId).toBe(payload.eligibilitySets[0]!.id);
    expect(payload.requirements[2]!.eligibilitySetId).toBe(payload.eligibilitySets[0]!.id);
  });

  it('hands the proxy empty maps: no engine sentence can be realised through it', async () => {
    const { call } = await sendOnce();
    const maps = call.mock.calls[0]![2];
    for (const map of Object.values(maps)) expect((map as Map<string, string>).size).toBe(0);
  });
});
