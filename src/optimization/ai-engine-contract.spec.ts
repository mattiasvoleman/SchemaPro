import { of } from 'rxjs';
import { OptimizationProxyService } from './optimization-proxy.service';
import {
  createPrismaMock,
  createTxMock,
  testUser,
} from '../../test/utils/prisma-mock';

/**
 * The three-sided wire contract, pinned from the gateway's side.
 *
 * The engine's pydantic models set `extra="forbid"`, so one field the gateway
 * sends and the engine has not heard of is a 422 for the WHOLE optimize
 * request — not a warning, not a dropped field. The reverse drift is just as
 * hard: the API's ValidationPipe runs with `forbidNonWhitelisted`.
 *
 * The evidence that this drifts in practice: the engine has carried a
 * `roomPreference` objective weight the gateway has never been able to send.
 * Nothing failed; the weight was simply unreachable.
 *
 * Its mirror lives in optimization-engine/tests/test_optimize.py, asserting the
 * same names against the pydantic models. Either half failing means the two
 * sides have parted company — fix the code, not the list, and change both
 * halves in the same commit as the engine deploy.
 */

const PAYLOAD_FIELDS = [
  'academicYearId',
  'constraints',
  'fixedLessons',
  'groupConflicts',
  'groups',
  'previousLessons',
  'requestId',
  'requirements',
  'roomPreferences',
  'rooms',
  'rules',
];

const GROUP_FIELDS = ['id', 'lunchHeadcount'];

const REQUIREMENT_FIELDS = [
  'coTeacherId',
  'id',
  'lessonsPerWeek',
  'maxGradeLevel',
  'minGradeLevel',
  'minutesPerLesson',
  'requiredRoomType',
  'studentGroupId',
  'studentGroupSize',
  'subjectId',
  'teacherId',
];

/** No resourceId: a year range names no resource, and sending one is refused. */
const GRADE_CONSTRAINT_FIELDS = [
  'date',
  'dayOfWeek',
  'endTime',
  'id',
  'kind',
  'maxGradeLevel',
  'minGradeLevel',
  'resourceKind',
  'startTime',
];

const RULES_FIELDS = [
  'diningSeats',
  'lunchEndTime',
  'lunchMinutes',
  'lunchStartTime',
  'maxLessonsPerDayPerGroup',
];

describe('AI engine wire contract', () => {
  const buildPayload = async (): Promise<Record<string, unknown>> => {
    const tx = createTxMock();
    const prisma = createPrismaMock(tx);
    const empty = [
      'teachingRequirement',
      'user',
      'studentGroupMember',
      'masterLesson',
      'room',
      'availabilityConstraint',
      'studentGroup',
      'roomPreference',
    ] as const;
    for (const model of empty) {
      tx[model]!['findMany']!.mockResolvedValue([]);
    }
    tx['lunchSetting']!['findUnique']!.mockResolvedValue({
      lunchEnabled: true,
      lunchStartTime: new Date(0),
      lunchEndTime: new Date(0),
      lunchMinutes: 30,
      diningSeats: 180,
      maxLessonsPerDayPerGroup: 7,
    });
    tx['teachingRequirement']!['findMany']!.mockResolvedValue([
      {
        id: 'r1',
        subjectId: 's1',
        studentGroupId: 'g1',
        teacherId: null,
        coTeacherId: null,
        lessonsPerWeek: 1,
        minutesPerLesson: 60,
        subject: { requiredRoomTypeId: null },
      },
    ]);
    tx['availabilityConstraint']!['findMany']!.mockResolvedValue([
      {
        id: 'c1',
        resourceType: 'GRADE_LEVEL',
        userId: null,
        roomId: null,
        studentGroupId: null,
        minGradeLevel: 4,
        maxGradeLevel: 6,
        dayOfWeek: 1,
        date: null,
        startTime: new Date(0),
        endTime: new Date(0),
        type: 'UNAVAILABLE',
      },
    ]);
    tx['room']!['findMany']!.mockResolvedValue([
      {
        id: 'rm1',
        capacity: 30,
        roomTypeId: null,
        minGradeLevel: null,
        maxGradeLevel: null,
      },
    ]);
    tx['masterLesson']!['deleteMany']!.mockResolvedValue({ count: 0 });
    tx['masterLesson']!['count']!.mockResolvedValue(0);
    tx['scheduleChangeLog']!['create']!.mockResolvedValue({});

    let sent: Record<string, unknown> = {};
    const http = {
      post: jest.fn((_url: string, payload: Record<string, unknown>) => {
        sent = payload;
        return of({
          data: {
            requestId: payload['requestId'],
            status: 'OPTIMAL',
            lessons: [],
            conflicts: null,
          },
        });
      }),
    };
    const config = {
      getOrThrow: () => ({ url: 'http://engine', apiKey: 'k', timeoutMs: 1000 }),
    };

    await new OptimizationProxyService(
      prisma as never,
      http as never,
      config as never,
    ).triggerScheduling('year-1', testUser());

    return sent;
  };

  it('sends exactly the top-level fields the engine declares', async () => {
    expect(Object.keys(await buildPayload()).sort()).toEqual(PAYLOAD_FIELDS);
  });

  it('sends exactly the group fields the engine declares', async () => {
    const payload = await buildPayload();
    const groups = payload['groups'] as Array<Record<string, unknown>>;
    expect(Object.keys(groups[0]!).sort()).toEqual(GROUP_FIELDS);
  });

  it('sends exactly the requirement fields the engine declares', async () => {
    const payload = await buildPayload();
    const requirements = payload['requirements'] as Array<Record<string, unknown>>;
    expect(Object.keys(requirements[0]!).sort()).toEqual(REQUIREMENT_FIELDS);
  });

  it('sends a year-range lock with bounds and without a resource id', async () => {
    const payload = await buildPayload();
    const constraints = payload['constraints'] as Array<Record<string, unknown>>;
    expect(Object.keys(constraints[0]!).sort()).toEqual(GRADE_CONSTRAINT_FIELDS);
  });

  it('sends exactly the rule fields the engine declares', async () => {
    const payload = await buildPayload();
    expect(Object.keys(payload['rules'] as object).sort()).toEqual(RULES_FIELDS);
  });
});
