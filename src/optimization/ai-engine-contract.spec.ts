import { of } from 'rxjs';
import { OptimizationProxyService } from './optimization-proxy.service';
import { RoomOptimizationService } from './room-optimization.service';
import type {
  OptimizeRoomsResponse,
  Walk,
} from './interfaces/room-walks.interface';
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
  'frameTimes',
  'groupConflicts',
  'groups',
  'lunchPlacements',
  'lunchServings',
  'previousLessons',
  'rasts',
  'requestId',
  'requirements',
  'roomPreferences',
  'rooms',
  'rules',
];

/** The group's years too: a sitting and a frame reach a stage, and a MEAL has
 *  no requirement to read a span off. */
const GROUP_FIELDS = ['id', 'lunchHeadcount', 'maxGradeLevel', 'minGradeLevel'];

/** A sitting names a span of years, so there is nothing here to anonymise. */
const SERVING_FIELDS = [
  'dayOfWeek',
  'endTime',
  'maxGradeLevel',
  'minGradeLevel',
  'seats',
  'startTime',
];

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

/** A frame names a span of years, so there is nothing here to anonymise. */
const FRAME_FIELDS = [
  'changeoverMinutes',
  'dayOfWeek',
  'endTime',
  'maxGradeLevel',
  'minGradeLevel',
  'startTime',
];

/** Never pinned before — only the top-level key list was. */
const PREFERENCE_FIELDS = [
  'id',
  'kind',
  'maxGradeLevel',
  'minGradeLevel',
  'roomIds',
  'roomType',
  'subjectId',
  'weight',
];

/**
 * A meal placed by hand is a START on one class's day and nothing else. Its
 * length is the school's one lunchMinutes; an end here would be a second
 * answer to "how long is lunch".
 */
const PLACEMENT_FIELDS = ['dayOfWeek', 'startTime', 'studentGroupId'];

const RULES_FIELDS = [
  'diningSeats',
  'lunchEndTime',
  'lunchMinutes',
  'lunchStartTime',
  'maxLessonsPerDayPerGroup',
];

describe('AI engine wire contract', () => {
  /** The tx of the most recent buildPayload, for assertions about the QUERIES. */
  let lastTx: ReturnType<typeof createTxMock>;

  const buildPayload = async (): Promise<Record<string, unknown>> => {
    const tx = createTxMock();
    lastTx = tx;
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
    // The requirement's group is a home class, so it is somebody who eats and
    // reaches `groups` — which is what the group-field assertion inspects.
    tx['studentGroup']!['findMany']!.mockResolvedValue([
      { id: 'g1', gradeLevel: null, kind: 'CLASS' },
    ]);
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
    tx['roomPreference']!['findMany']!.mockResolvedValue([
      {
        id: 'pref-1',
        subjectId: 's1',
        kind: 'LOCK',
        minGradeLevel: 4,
        maxGradeLevel: 4,
        roomTypeId: null,
        weight: 5,
        rooms: [{ roomId: 'rm1' }],
      },
    ]);
    tx['lunchServing']!['findMany']!.mockResolvedValue([
      {
        minGradeLevel: 4,
        maxGradeLevel: 6,
        dayOfWeek: null,
        startTime: new Date('1970-01-01T11:40:00.000Z'),
        endTime: new Date('1970-01-01T12:20:00.000Z'),
        seats: null,
      },
    ]);
    // One meal the school placed by hand, so the pins reach the payload and
    // their shape is pinned too. `id` because regeneration reads the row back.
    tx['lunchSitting']!['findMany']!.mockResolvedValue([
      {
        id: 'hand-1',
        studentGroupId: 'g1',
        dayOfWeek: 2,
        startTime: new Date('1970-01-01T13:00:00.000Z'),
      },
    ]);
    tx['frameTime']!['findMany']!.mockResolvedValue([
      {
        minGradeLevel: 4,
        maxGradeLevel: 6,
        dayOfWeek: 1,
        // 1970-anchored, exactly as Prisma reads a TIME column back.
        startTime: new Date('1970-01-01T08:00:00.000Z'),
        endTime: new Date('1970-01-01T15:00:00.000Z'),
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
    // Regeneration now also clears the future calendar rows the replaced
    // master lessons had already materialised — without it, publishing again
    // duplicated the week.
    tx['calendarLesson']!['deleteMany']!.mockResolvedValue({ count: 0 });
    tx['masterLesson']!['create']!.mockResolvedValue({ id: 'ml-1' });
    tx['masterLesson']!['count']!.mockResolvedValue(0);
    tx['scheduleChangeLog']!['create']!.mockResolvedValue({});

    let sent: Record<string, unknown> = {};
    const http = {
      post: jest.fn((_url: string, payload: Record<string, unknown>) => {
        sent = payload;
        // One placement per requested lesson. An empty answer is no longer an
        // acceptable stub: the proxy now refuses a solution that does not match
        // what it asked for, rather than deleting the year and finding out
        // afterwards. A contract test must exercise the accepting path, or it
        // would only ever be measuring the rejection.
        const requirements = payload['requirements'] as Array<{
          id: string;
          lessonsPerWeek: number;
        }>;
        const rooms = payload['rooms'] as Array<{ id: string }>;
        return of({
          data: {
            requestId: payload['requestId'],
            status: 'OPTIMAL',
            lessons: requirements.flatMap((requirement) =>
              Array.from({ length: requirement.lessonsPerWeek }, () => ({
                requirementId: requirement.id,
                roomId: rooms[0]?.id ?? null,
                dayOfWeek: 1,
                startTime: '08:00:00',
                endTime: '09:00:00',
              })),
            ),
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

  it('sends exactly the placement fields the engine declares', async () => {
    const payload = await buildPayload();
    const placements = payload['lunchPlacements'] as Array<Record<string, unknown>>;

    expect(placements).toHaveLength(1);
    expect(Object.keys(placements[0]!).sort()).toEqual(PLACEMENT_FIELDS);
  });

  it('reads every room-rule field it forwards out of the database', async () => {
    /*
     * A field dropped from the `select` arrives as undefined, and pydantic's
     * default then fills it in — so a lock would reach the engine as a WISH,
     * silently, on a run that succeeds.
     *
     * Asserted on the QUERY, which is weaker than a behavioural test and is the
     * strongest thing available: the prisma mock returns its fixture whole,
     * regardless of the projection, so no fixture can make it omit a column.
     */
    await buildPayload();

    const select = lastTx['roomPreference']!['findMany']!.mock.calls[0][0].select;
    expect(select).toMatchObject({
      kind: true,
      minGradeLevel: true,
      maxGradeLevel: true,
      weight: true,
    });
  });

  it('sends exactly the room-rule fields the engine declares', async () => {
    const payload = await buildPayload();
    const preferences = payload['roomPreferences'] as Array<Record<string, unknown>>;
    expect(preferences).toHaveLength(1);
    expect(Object.keys(preferences[0]!).sort()).toEqual(PREFERENCE_FIELDS);
  });

  it('sends exactly the sitting fields the engine declares', async () => {
    const payload = await buildPayload();
    const servings = payload['lunchServings'] as Array<Record<string, unknown>>;
    expect(servings).toHaveLength(1);
    expect(Object.keys(servings[0]!).sort()).toEqual(SERVING_FIELDS);
    expect(servings[0]!['startTime']).toBe('11:40:00');
  });

  it('sends exactly the frame fields the engine declares', async () => {
    const payload = await buildPayload();
    const frames = payload['frameTimes'] as Array<Record<string, unknown>>;
    expect(frames).toHaveLength(1);
    expect(Object.keys(frames[0]!).sort()).toEqual(FRAME_FIELDS);
  });

  it('sends a frame clock as HH:MM:SS, not as a 1970 timestamp', async () => {
    const payload = await buildPayload();
    const frames = payload['frameTimes'] as Array<Record<string, unknown>>;

    // Prisma reads a TIME column into a Date at 1970-01-01, and the engine's
    // pattern is ^\d{2}:\d{2}:\d{2}$ — so an unconverted value is a 422 for
    // the whole optimize request, not a bad-looking field.
    expect(frames[0]!['startTime']).toBe('08:00:00');
    expect(frames[0]!['endTime']).toBe('15:00:00');
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

/*
 * The room optimisation's half of the same contract: POST /api/v1/optimize-rooms.
 * Mirrored in optimization-engine/tests/test_room_walks.py
 * (test_the_wire_contract_is_exactly_what_the_gateway_sends_and_reads) against
 * the pydantic models, which forbid extra fields exactly as the schedule
 * route's do.
 */

const ROOMS_REQUEST_FIELDS = [
  'constraints',
  'lessons',
  'requestId',
  'roomPreferences',
  'rooms',
  'walkers',
];

/** Times and weeks as they are; the engine never moves either. */
const ROOMS_LESSON_FIELDS = [
  'coTeacherId',
  'dayOfWeek',
  'endDate',
  'endTime',
  'extraGroupIds',
  'id',
  'maxGradeLevel',
  'minGradeLevel',
  'movable',
  'recurrence',
  'requiredRoomType',
  'roomId',
  'startDate',
  'startTime',
  'studentGroupId',
  'studentGroupSize',
  'subjectId',
  'teacherId',
];

/** The building is a token, never the school's name for it. */
const ROOMS_ROOM_FIELDS = [
  'building',
  'capacity',
  'floor',
  'id',
  'maxGradeLevel',
  'minGradeLevel',
  'type',
];

/** A room closed on a weekday, the one kind of constraint this route reads. */
const ROOMS_CONSTRAINT_FIELDS = [
  'date',
  'dayOfWeek',
  'endTime',
  'id',
  'kind',
  'resourceId',
  'resourceKind',
  'startTime',
];

const ROOMS_RESPONSE_FIELDS = [
  'changes',
  'frozenLessonIds',
  'groups',
  'missedWishes',
  'requestId',
  'status',
  'teachers',
  'walkers',
];

const WALK_FIELDS = ['buildingChanges', 'floorChanges', 'roomChanges'];

describe('AI engine wire contract — room optimisation', () => {
  const walk = (roomChanges: number): Walk => ({
    roomChanges,
    floorChanges: 1,
    buildingChanges: 2,
  });

  /**
   * One of everything the engine sends back, typed against the interface: a
   * field added to OptimizeRoomsResponse without being added here fails the
   * type-check, and one added here without the list fails the key assertion.
   */
  const engineReply = (requestId: string): OptimizeRoomsResponse => ({
    requestId,
    status: 'FEASIBLE',
    changes: [],
    teachers: { before: walk(3), after: walk(1) },
    groups: { before: walk(4), after: walk(2) },
    missedWishes: { before: 2, after: 1 },
    walkers: [],
    frozenLessonIds: [],
  });

  const run = async (reply: (requestId: string) => object = engineReply) => {
    const tx = createTxMock();
    const prisma = createPrismaMock(tx);
    tx['academicYear']!['findUnique']!.mockResolvedValue({ id: 'year-1', schoolId: 'school-1' });
    tx['masterLesson']!['findMany']!.mockResolvedValue([
      {
        id: 'ml-1',
        subjectId: 's1',
        studentGroupId: 'g1',
        teacherId: 't1',
        coTeacherId: null,
        roomId: 'rm1',
        dayOfWeek: 1,
        startTime: new Date('1970-01-01T08:00:00.000Z'),
        endTime: new Date('1970-01-01T09:00:00.000Z'),
        recurrence: 'ALL_WEEKS',
        startDate: null,
        endDate: null,
        isLocked: false,
        isParked: false,
        extraGroups: [],
        participants: [],
        subject: { requiredRoomTypeId: null },
      },
    ]);
    tx['room']!['findMany']!.mockResolvedValue([
      {
        id: 'rm1',
        capacity: 30,
        roomTypeId: null,
        minGradeLevel: null,
        maxGradeLevel: null,
        building: 'Hus A',
        floor: 2,
      },
    ]);
    tx['availabilityConstraint']!['findMany']!.mockResolvedValue([
      {
        id: 'c1',
        roomId: 'rm1',
        dayOfWeek: 2,
        startTime: new Date('1970-01-01T12:00:00.000Z'),
        endTime: new Date('1970-01-01T13:00:00.000Z'),
      },
    ]);

    let sent: Record<string, unknown> = {};
    const http = {
      post: jest.fn((_url: string, payload: Record<string, unknown>) => {
        sent = payload;
        return of({ data: reply(payload['requestId'] as string) });
      }),
    };
    const config = {
      getOrThrow: () => ({ baseUrl: 'http://engine', apiKey: 'k', timeoutMs: 1000 }),
    };
    const proxy = new OptimizationProxyService(prisma as never, http as never, config as never);
    const proposal = await new RoomOptimizationService(
      prisma as never,
      proxy,
      {} as never,
      {} as never,
    ).propose({ academicYearId: 'year-1', walkers: 'TEACHERS' }, testUser());

    return { sent, proposal };
  };

  it('sends exactly the top-level fields the engine declares', async () => {
    const { sent } = await run();
    expect(Object.keys(sent).sort()).toEqual(ROOMS_REQUEST_FIELDS);
  });

  it('sends exactly the lesson fields the engine declares', async () => {
    const { sent } = await run();
    const lessons = sent['lessons'] as Array<Record<string, unknown>>;
    expect(lessons).toHaveLength(1);
    expect(Object.keys(lessons[0]!).sort()).toEqual(ROOMS_LESSON_FIELDS);
  });

  it('sends exactly the room fields the engine declares', async () => {
    const { sent } = await run();
    const rooms = sent['rooms'] as Array<Record<string, unknown>>;
    expect(Object.keys(rooms[0]!).sort()).toEqual(ROOMS_ROOM_FIELDS);
  });

  it('sends exactly the constraint fields the engine declares', async () => {
    const { sent } = await run();
    const constraints = sent['constraints'] as Array<Record<string, unknown>>;
    expect(constraints).toHaveLength(1);
    expect(Object.keys(constraints[0]!).sort()).toEqual(ROOMS_CONSTRAINT_FIELDS);
  });

  it('reads exactly the response fields the engine declares', async () => {
    const reply = engineReply('r');
    expect(Object.keys(reply).sort()).toEqual(ROOMS_RESPONSE_FIELDS);
    expect(Object.keys(reply.teachers.before).sort()).toEqual(WALK_FIELDS);

    // And every one of them reaches the proposal, under the name it had.
    const { proposal } = await run();
    expect(proposal.status).toBe('FEASIBLE');
    expect(proposal.teachers).toEqual({ before: walk(3), after: walk(1) });
    expect(proposal.groups).toEqual({ before: walk(4), after: walk(2) });
    expect(proposal.missedWishes).toEqual({ before: 2, after: 1 });
  });

  it('passes a walk on with exactly the walk fields, whatever else the engine adds', async () => {
    const { proposal } = await run((requestId) => {
      const reply = engineReply(requestId);
      return { ...reply, teachers: { ...reply.teachers, before: { ...walk(3), stairs: 9 } } };
    });
    expect(Object.keys(proposal.teachers.before).sort()).toEqual(WALK_FIELDS);
  });
});
