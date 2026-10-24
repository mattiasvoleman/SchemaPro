import { of } from 'rxjs';
import { BASIS_EXCLUDED_FIELDS, BASIS_PAYLOAD_FIELDS } from './candidate-basis';
import { searchFor, type CallShape } from './candidate-variants';
import type { ObjectiveWeights } from './interfaces/ai-engine-payload.interface';
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
  'teacherWorkRules',
];

/** The group's years too: a sitting and a frame reach a stage, and a MEAL has
 *  no requirement to read a span off. */
const GROUP_FIELDS = ['id', 'lunchHeadcount', 'maxGradeLevel', 'minGradeLevel'];

/**
 * A teacher's arbetstid. BOTH ids are here and both are anonymised, which is the
 * one thing about this list worth pinning beyond the names: `teacherId` rides the
 * same map the requirements use and is thrown away, and `id` rides a map the
 * gateway KEEPS, because a refusal about a teacher may name no person and the
 * rule row is then the only thing a school can open.
 */
const WORK_RULE_FIELDS = [
  'id',
  'lunchEndTime',
  'lunchMinutes',
  'lunchStartTime',
  'minDailyRestMinutes',
  'teacherId',
];

/**
 * Lärarens dag on the work rule: the daily cap and the free-day wish, each
 * sent only when the rule sets it, so WORK_RULE_FIELDS above stays the pin of
 * every rule written before them. optimization-engine/tests/test_optimize.py's
 * `_field_names(AnonymousTeacherWorkRule)` must equal THIS set: the engine
 * declares every optional field either way.
 */
const WORK_RULE_FIELDS_DAY = [...WORK_RULE_FIELDS, 'maxTeachingMinutesPerDay', 'preferredFreeDay'].sort();

/**
 * Deltid in days, its own list and its own id space (the post's, kept and
 * reversed), so a refusal about it can be told from a cap's and masked for a
 * reader without HR-läs. The engine's `_field_names(AnonymousTeacherDayLimit)`.
 * `lockedWeekdays` is required on both sides: the weekdays the teacher's fixed
 * lessons hold week by week (common/teacher-day.ts, lockedWeekdaySets), which
 * the limit is held against in place of every weekday any of them holds.
 */
const DAY_LIMIT_FIELDS = ['id', 'lockedWeekdays', 'maxTeachingDaysPerWeek', 'teacherId'];

/** The top level with a day limit sent: the key exists only then. */
const PAYLOAD_FIELDS_WITH_DAY_LIMITS = [...PAYLOAD_FIELDS, 'teacherDayLimits'].sort();

/**
 * Restid i generatorn: the walks between the school's sites, sent only when
 * the school's Skolregler turn the walk on and a pair has a figure — and the
 * rooms then carry `siteId`. The engine's `_field_names(SiteTravelTime)`.
 */
const SITE_TRAVEL_FIELDS = ['minutes', 'siteAId', 'siteBId'];
const PAYLOAD_FIELDS_WITH_TRAVEL = [...PAYLOAD_FIELDS, 'siteTravelTimes'].sort();
/** Every key a payload can carry, the conditional ones included. */
const PAYLOAD_FIELDS_ALL = [...PAYLOAD_FIELDS, 'teacherDayLimits', 'siteTravelTimes'].sort();
/** The generator's room: the engine's `_field_names(AnonymousRoom)` with the walk on. */
const ROOM_FIELDS = ['capacity', 'id', 'maxGradeLevel', 'minGradeLevel', 'type'];
const ROOM_FIELDS_WITH_SITE = [...ROOM_FIELDS, 'siteId'].sort();

/** A sitting names a span of years, so there is nothing here to anonymise. */
const SERVING_FIELDS = [
  'dayOfWeek',
  'endTime',
  'maxGradeLevel',
  'minGradeLevel',
  'seats',
  'startTime',
];

/** `minutesBefore`/`minutesAfter` are the pupil buffers — the class's occupancy
 *  outside the lesson, which the engine must keep clear for the CHILDREN and for
 *  neither the teacher nor the room. */
const REQUIREMENT_FIELDS = [
  'coTeacherId',
  'id',
  'lessonsPerWeek',
  'maxGradeLevel',
  'minGradeLevel',
  'minutesAfter',
  'minutesBefore',
  'minutesPerLesson',
  'requiredRoomType',
  'studentGroupId',
  'studentGroupSize',
  'subjectId',
  'teacherId',
];

/**
 * A requirement whose remaining lessons have two or more lengths
 * (lektionslängder, 1 × 80 + 1 × 40) carries its list besides; a uniform one
 * never does, so REQUIREMENT_FIELDS above stays the uniform pin.
 */
const REQUIREMENT_FIELDS_MIXED = [...REQUIREMENT_FIELDS, 'lessonLengths'].sort();

/**
 * A requirement held to an ämnesfördelning carries its rule and the weekdays
 * of its locked lessons besides; one without a rule never does, so a school
 * that has written none sends the payload it always sent.
 */
const REQUIREMENT_FIELDS_DISTRIBUTED = [
  ...REQUIREMENT_FIELDS_MIXED,
  'lockedDays',
  'maxLessonsPerDay',
  'minDaysBetween',
].sort();

/**
 * A member of a parallel block with two or more members to place carries the
 * block's anonymous id besides; a row in no block never does.
 */
const REQUIREMENT_FIELDS_BLOCKED = [...REQUIREMENT_FIELDS_DISTRIBUTED, 'blockId'].sort();

/**
 * Delade lektioner: a post whose lessons still to place have two or more
 * teachers carries each lesson's teacher besides; a post nobody shares never
 * does. optimization-engine/tests/test_optimize.py's
 * `_field_names(AnonymousRequirement)` must equal THIS set: the engine
 * declares every optional field either way.
 */
const REQUIREMENT_FIELDS_SHARED = [...REQUIREMENT_FIELDS_BLOCKED, 'lessonTeacherIds'].sort();

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

/**
 * A schemaförslag candidate's search (SearchOptions in schemas/schedule.py).
 * Sent ONLY on a candidate's call: Generera's payload above has never carried
 * it, and an engine older than the field refuses a request that does, whole.
 */
const SEARCH_FIELDS = ['maxSeconds', 'probes', 'seed', 'workers'];

describe('AI engine wire contract', () => {
  /** The tx of the most recent buildPayload, for assertions about the QUERIES. */
  let lastTx: ReturnType<typeof createTxMock>;
  /** What the most recent buildPayload's run answered, and whether it called the engine. */
  let lastResult: Awaited<ReturnType<OptimizationProxyService['triggerScheduling']>>;
  let lastPost: jest.Mock;
  /** How the stub engine's lessons are answered: as asked, unless a test says otherwise. */
  let answered: (lessons: Record<string, unknown>[]) => Record<string, unknown>[] = (lessons) => lessons;
  afterEach(() => {
    answered = (lessons) => lessons;
  });

  const buildPayload = async (
    requirementOverrides: Record<string, unknown> = {},
    preservedLessons: Record<string, unknown>[] = [],
    moreRequirements: Record<string, unknown>[] = [],
    configure: (tx: ReturnType<typeof createTxMock>) => void = () => undefined,
    /** A schemaförslag candidate's call instead of Generera's: the same fetch, then solveCandidate. */
    candidate?: { weights: ObjectiveWeights | null; call: CallShape },
  ): Promise<Record<string, unknown>> => {
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
    if (preservedLessons.length > 0) {
      tx['masterLesson']!['findMany']!.mockResolvedValue(preservedLessons);
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
    // A named teacher, so `teacherAnonMap` holds somebody: a work rule whose
    // teacher appears in no requirement, fixed lesson or reservation is dropped
    // on purpose (the engine would have no lesson of theirs to bind it to), and
    // with a teacherless requirement the rule assertion below would be measuring
    // that drop instead of the contract.
    tx['teachingRequirement']!['findMany']!.mockResolvedValue([
      {
        id: 'r1',
        subjectId: 's1',
        studentGroupId: 'g1',
        teacherId: 't1',
        coTeacherId: null,
        lessonsPerWeek: 1,
        minutesPerLesson: 60,
        // The column's '{}': a uniform row, as the database answers it.
        lessonLengths: [],
        subject: { requiredRoomTypeId: null },
        ...requirementOverrides,
      },
      ...moreRequirements,
    ]);
    // One teacher's arbetstid, with the lunch trio whole and the night set, so
    // every field of the shape reaches the payload.
    tx['teacherWorkRule']!['findMany']!.mockResolvedValue([
      {
        id: 'wr-1',
        userId: 't1',
        lunchMinutes: 30,
        // 1970-anchored, exactly as Prisma reads a TIME column back.
        lunchStartTime: new Date('1970-01-01T10:30:00.000Z'),
        lunchEndTime: new Date('1970-01-01T13:30:00.000Z'),
        minDailyRestMinutes: 660,
        // As the columns default (20261123090000): no cap, no wish. Spelled
        // out because the database answers null for them, never undefined.
        maxTeachingMinutesPerDay: null,
        preferredFreeDayOfWeek: null,
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
        // Each at its own length: a split requirement's answer is held to the
        // lengths it was sent.
        const requirements = payload['requirements'] as Array<{
          id: string;
          lessonsPerWeek: number;
          minutesPerLesson: number;
          lessonLengths?: number[];
          lessonTeacherIds?: (string | null)[];
        }>;
        const rooms = payload['rooms'] as Array<{ id: string }>;
        const clock = (minutes: number): string =>
          `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00`;
        return of({
          data: {
            requestId: payload['requestId'],
            status: 'OPTIMAL',
            lessons: answered(requirements.flatMap((requirement) =>
              (
                requirement.lessonLengths ??
                Array.from({ length: requirement.lessonsPerWeek }, () => 60)
              ).map((minutes, index) => ({
                requirementId: requirement.id,
                roomId: rooms[0]?.id ?? null,
                dayOfWeek: 1,
                startTime: '08:00:00',
                endTime: clock(480 + minutes),
                // As the engine answers a shared post: each lesson's own
                // teacher, the key left out where the list says null.
                ...(requirement.lessonTeacherIds?.[index] ? { teacherId: requirement.lessonTeacherIds[index] } : {}),
              })),
            )),
            conflicts: null,
          },
        });
      }),
    };
    const config = {
      getOrThrow: () => ({ url: 'http://engine', apiKey: 'k', timeoutMs: 1000 }),
    };
    configure(tx);

    lastPost = http.post;
    const proxy = new OptimizationProxyService(prisma as never, http as never, config as never);
    if (candidate) {
      const prepared = await proxy.prepareSchedule(tx as never, 'year-1', testUser());
      if (!prepared.ready) throw new Error('The contract world was refused before the engine.');
      await proxy.solveCandidate(prepared, {
        weights: candidate.weights,
        search: searchFor(candidate.call, { maxSeconds: 30, workers: 4 }),
        timeoutMs: 75_000,
      });
      return sent;
    }
    lastResult = await proxy.triggerScheduling('year-1', testUser());

    return sent;
  };

  /** A second timplanspost for the block cases: Franska för g2, one lesson. */
  const member = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'r2',
    subjectId: 's2',
    studentGroupId: 'g2',
    teacherId: 't2',
    coTeacherId: null,
    lessonsPerWeek: 1,
    minutesPerLesson: 60,
    lessonLengths: [],
    subject: { requiredRoomTypeId: null },
    ...overrides,
  });
  const named = (tx: ReturnType<typeof createTxMock>) => {
    tx['teachingBlock']!['findMany']!.mockResolvedValue([{ id: 'b1', name: 'Språkval åk 7' }]);
  };

  it('sends exactly the top-level fields the engine declares', async () => {
    expect(Object.keys(await buildPayload()).sort()).toEqual(PAYLOAD_FIELDS);
    // Generera's call keeps the module's timeout: no per-call one rides along.
    expect(lastPost.mock.calls[0][2]).not.toHaveProperty('timeout');
  });

  it('leaves no field of the payload outside the schemaförslag basis, unless it is excluded by name', () => {
    // A field added to the payload (and to PAYLOAD_FIELDS) fails here until
    // candidate-basis.ts reads it or names it as excluded: otherwise a
    // candidate solved before a change to it would be applied after.
    // Every field any payload can carry: the ones a key is sent for only when
    // it has a value (teacherDayLimits) as well as the ones always sent, since
    // a field the guard never sees is the one a stale candidate slips through.
    const covered = [...BASIS_PAYLOAD_FIELDS, ...BASIS_EXCLUDED_FIELDS];
    expect(new Set(covered).size).toBe(covered.length);
    expect(PAYLOAD_FIELDS_ALL.filter((field) => !covered.includes(field as never))).toEqual([]);
    // And nothing is read that the payload no longer has.
    expect(BASIS_PAYLOAD_FIELDS.filter((field) => !PAYLOAD_FIELDS_ALL.includes(field))).toEqual([]);
  });

  it('sends a schemaförslag candidate Generera\'s fields plus search, and search exactly its four', async () => {
    const payload = await buildPayload({}, [], [], () => undefined, {
      weights: null,
      call: { variant: 'TEACHER_GAPS', seed: 1, lead: false },
    });
    expect(Object.keys(payload).sort()).toEqual([...PAYLOAD_FIELDS, 'search'].sort());
    expect(Object.keys(payload['search'] as object).sort()).toEqual(SEARCH_FIELDS);
    expect(payload['search']).toEqual({ workers: 4, probes: false, maxSeconds: 30, seed: 1 });
    // And waits for it exactly as long as the run said, on both timeouts.
    expect(lastPost.mock.calls[0][2]).toMatchObject({ timeout: 75_000 });
  });

  it('sends the KEEP candidate Generera\'s request with the workers, the probes and the budget, and its weights when it has some', async () => {
    const keep = await buildPayload({}, [], [], () => undefined, {
      weights: null,
      call: { variant: 'KEEP', seed: null, lead: true },
    });
    expect(keep['search']).toEqual({ workers: 4, probes: true, maxSeconds: 30 });
    for (const field of Object.keys(keep['search'] as object)) expect(SEARCH_FIELDS).toContain(field);

    const weighted = await buildPayload({}, [], [], () => undefined, {
      weights: { spread: 9, disruption: 2 },
      call: { variant: 'SPREAD', seed: 2, lead: false },
    });
    expect(Object.keys(weighted).sort()).toEqual([...PAYLOAD_FIELDS, 'search', 'weights'].sort());
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

  it('sends exactly the arbetstid fields the engine declares', async () => {
    const payload = await buildPayload();
    const rules = payload['teacherWorkRules'] as Array<Record<string, unknown>>;
    expect(rules).toHaveLength(1);
    expect(Object.keys(rules[0]!).sort()).toEqual(WORK_RULE_FIELDS);

    // The clock as HH:MM:SS, like every other time on this wire: Prisma reads a
    // TIME column into a 1970 Date and the engine's pattern is
    // ^\d{2}:\d{2}:\d{2}$, so an unconverted value is a 422 for the WHOLE
    // optimize request rather than one bad-looking field.
    expect(rules[0]!['lunchStartTime']).toBe('10:30:00');
    expect(rules[0]!['lunchEndTime']).toBe('13:30:00');

    // And NEITHER id is the real one. The teacher's map is discarded when the
    // request ends, which is what keeps a person out of the stored conflicts; the
    // rule's is kept and reversed, which is what leaves the school something to
    // open. Both would be broken by forwarding the row's own ids.
    expect(rules[0]!['id']).not.toBe('wr-1');
    expect(rules[0]!['teacherId']).not.toBe('t1');
  });

  it('sends a school without a cap, a wish or a day limit the bytes it always sent', async () => {
    /*
     * "Off by default" is the data: every rule written before Lärarens dag
     * has no cap and no wish, and no post limits its days. Byte-identical
     * means the same keys IN THE SAME ORDER on the rule, no null for a new
     * field (a null is a key an older engine 422s on as surely as a value),
     * and no `teacherDayLimits` at all, not an empty list.
     */
    const payload = await buildPayload();
    const rule = (payload['teacherWorkRules'] as Array<Record<string, unknown>>)[0]!;

    expect(Object.keys(rule)).toEqual([
      'id',
      'teacherId',
      'lunchMinutes',
      'lunchStartTime',
      'lunchEndTime',
      'minDailyRestMinutes',
    ]);
    expect(JSON.stringify(rule)).toBe(
      `{"id":"${String(rule['id'])}","teacherId":"${String(rule['teacherId'])}","lunchMinutes":30,` +
        `"lunchStartTime":"10:30:00","lunchEndTime":"13:30:00","minDailyRestMinutes":660}`,
    );
    expect(Object.keys(payload).sort()).toEqual(PAYLOAD_FIELDS);
    expect(JSON.stringify(payload)).not.toMatch(/teacherDayLimits|maxTeaching|preferredFreeDay/);
  });

  describe('Restid i generatorn', () => {
    const rooms = [
      { id: 'rm-n', capacity: 30, roomTypeId: null, minGradeLevel: null, maxGradeLevel: null, siteId: 'site-n', name: 'N1', roomType: null },
      { id: 'rm-s', capacity: 30, roomTypeId: null, minGradeLevel: null, maxGradeLevel: null, siteId: 'site-s', name: 'S1', roomType: null },
      { id: 'rm-x', capacity: 30, roomTypeId: null, minGradeLevel: null, maxGradeLevel: null, siteId: null, name: 'X1', roomType: null },
    ];
    const keeping = (keeps: boolean, figures: Array<Record<string, unknown>>) => (tx: ReturnType<typeof createTxMock>) => {
      tx['room']!['findMany']!.mockResolvedValue(rooms);
      tx['lunchSetting']!['findUnique']!.mockResolvedValue({
        lunchEnabled: true,
        lunchStartTime: new Date(0),
        lunchEndTime: new Date(0),
        lunchMinutes: 30,
        diningSeats: 180,
        maxLessonsPerDayPerGroup: 7,
        generatorKeepsTravelTime: keeps,
      });
      tx['siteTravelTime']!['findMany']!.mockResolvedValue(figures);
    };
    const figure = { siteAId: 'site-n', siteBId: 'site-s', minutes: 10 };

    it('sends a school whose walk is off neither a site nor a walk, and asks for no figure', async () => {
      const payload = await buildPayload({}, [], [], keeping(false, [figure]));

      expect(Object.keys(payload).sort()).toEqual(PAYLOAD_FIELDS);
      for (const room of payload['rooms'] as Array<Record<string, unknown>>) {
        expect(Object.keys(room).sort()).toEqual(ROOM_FIELDS);
      }
      expect(JSON.stringify(payload)).not.toMatch(/siteId|siteTravelTimes/);
      expect(lastTx['siteTravelTime']!['findMany']).not.toHaveBeenCalled();
    });

    it('sends a school that keeps the walk but has no figure the payload it always sent', async () => {
      const payload = await buildPayload({}, [], [], keeping(true, []));

      expect(Object.keys(payload).sort()).toEqual(PAYLOAD_FIELDS);
      expect(JSON.stringify(payload)).not.toMatch(/siteId|siteTravelTimes/);
    });

    it('sends the walks and every room’s site, anonymised, under the names the engine declares', async () => {
      const payload = await buildPayload({}, [], [], keeping(true, [figure]));
      const sentRooms = payload['rooms'] as Array<Record<string, unknown>>;
      const walks = payload['siteTravelTimes'] as Array<Record<string, unknown>>;

      expect(Object.keys(payload).sort()).toEqual(PAYLOAD_FIELDS_WITH_TRAVEL);
      expect(walks).toHaveLength(1);
      expect(Object.keys(walks[0]!).sort()).toEqual(SITE_TRAVEL_FIELDS);
      expect(walks[0]!['minutes']).toBe(10);
      // A room on a site carries it; a room on none carries no key, which the
      // engine reads as unknown, as common/site-travel.ts does.
      expect(Object.keys(sentRooms[0]!).sort()).toEqual(ROOM_FIELDS_WITH_SITE);
      expect(Object.keys(sentRooms[2]!).sort()).toEqual(ROOM_FIELDS);
      // The sites are tokens: the walk names exactly the two the rooms carry,
      // and neither is the school's own id.
      expect([walks[0]!['siteAId'], walks[0]!['siteBId']]).toEqual([sentRooms[0]!['siteId'], sentRooms[1]!['siteId']]);
      expect(JSON.stringify(payload)).not.toMatch(/site-n|site-s/);
    });
  });

  it('sends a rule’s cap and wish under the names the engine declares, and a rule holding only them', async () => {
    const payload = await buildPayload({}, [], [], (tx) => {
      tx['teacherWorkRule']!['findMany']!.mockResolvedValue([
        {
          id: 'wr-1',
          userId: 't1',
          lunchMinutes: 30,
          lunchStartTime: new Date('1970-01-01T10:30:00.000Z'),
          lunchEndTime: new Date('1970-01-01T13:30:00.000Z'),
          minDailyRestMinutes: 660,
          maxTeachingMinutesPerDay: 270,
          preferredFreeDayOfWeek: 5,
        },
        {
          // A cap alone: no lunch and no rest, and a rule all the same.
          id: 'wr-2',
          userId: 't1',
          lunchMinutes: null,
          lunchStartTime: null,
          lunchEndTime: null,
          minDailyRestMinutes: null,
          maxTeachingMinutesPerDay: 300,
          preferredFreeDayOfWeek: null,
        },
      ]);
    });
    const rules = payload['teacherWorkRules'] as Array<Record<string, unknown>>;

    expect(Object.keys(rules[0]!).sort()).toEqual(WORK_RULE_FIELDS_DAY);
    expect(rules[0]).toMatchObject({ maxTeachingMinutesPerDay: 270, preferredFreeDay: 5 });
    expect(Object.keys(rules[1]!).sort()).toEqual([...WORK_RULE_FIELDS, 'maxTeachingMinutesPerDay'].sort());
    expect(rules[1]).toMatchObject({ lunchMinutes: null, minDailyRestMinutes: null, maxTeachingMinutesPerDay: 300 });
  });

  it('sends a post’s day limit exactly as the engine declares it, under the key it declares', async () => {
    const payload = await buildPayload({}, [], [], (tx) => {
      tx['teacherEmployment']!['findMany']!.mockResolvedValue([
        { id: 'post-1', userId: 't1', maxTeachingDaysPerWeek: 4 },
      ]);
    });
    const limits = payload['teacherDayLimits'] as Array<Record<string, unknown>>;
    const requirements = payload['requirements'] as Array<Record<string, unknown>>;

    expect(Object.keys(payload).sort()).toEqual(PAYLOAD_FIELDS_WITH_DAY_LIMITS);
    expect(limits).toHaveLength(1);
    expect(Object.keys(limits[0]!).sort()).toEqual(DAY_LIMIT_FIELDS);
    expect(limits[0]!['maxTeachingDaysPerWeek']).toBe(4);
    // A teacher with no fixed lesson: one week, holding no weekday — a list
    // of lists of ISO weekdays, never an empty list.
    expect(limits[0]!['lockedWeekdays']).toEqual([[]]);
    // The teacher is the requirement's token, and neither id is a real one.
    expect(limits[0]!['teacherId']).toBe(requirements[0]!['teacherId']);
    expect(limits[0]!['id']).not.toBe('post-1');
    expect(JSON.stringify(payload)).not.toMatch(/post-1|"t1"/);
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

  it('names the engine’s whole requirement set, the shared post’s key included', () => {
    expect(REQUIREMENT_FIELDS_SHARED).toEqual(
      [
        'blockId', 'coTeacherId', 'id', 'lessonLengths', 'lessonTeacherIds', 'lessonsPerWeek', 'lockedDays',
        'maxGradeLevel', 'maxLessonsPerDay', 'minDaysBetween', 'minGradeLevel', 'minutesAfter', 'minutesBefore',
        'minutesPerLesson', 'requiredRoomType', 'studentGroupId', 'studentGroupSize', 'subjectId', 'teacherId',
      ],
    );
  });

  it('delade lektioner: sends each lesson of a shared post its own teacher, and writes each lesson with it', async () => {
    // 9A's three matematik, Anna (t1) the lead and Bo (t3) one lesson.
    const payload = await buildPayload({
      lessonsPerWeek: 3,
      shares: [{ teacherId: 't3', lessons: 1, minutes: 60 }],
    });
    const requirements = payload['requirements'] as Array<Record<string, unknown>>;
    expect(Object.keys(requirements[0]!).sort()).toEqual([...REQUIREMENT_FIELDS, 'lessonTeacherIds'].sort());
    const list = requirements[0]!['lessonTeacherIds'] as string[];
    expect(list).toHaveLength(3);
    expect(list[0]).toBe(requirements[0]!['teacherId']);
    expect(list[1]).toBe(list[0]);
    expect(list[2]).not.toBe(list[0]);
    // Anonymous, as every id that crosses.
    expect(list.some((id) => id === 't1' || id === 't3')).toBe(false);

    const written = (lastTx['masterLesson']!['createMany']!.mock.calls as [{ data: { teacherId: string | null }[] }][])
      .flatMap(([call]) => call.data)
      .map((lesson) => lesson.teacherId);
    expect(written.sort()).toEqual(['t1', 't1', 't3']);
  });

  it('delade lektioner: refuses an answer that gives a shared post’s lessons other teachers, and writes nothing', async () => {
    // Every lesson answered as the lead's: three of Anna's where two were asked.
    answered = (lessons) => lessons.map((lesson) => (lesson['teacherId'] ? { ...lesson, teacherId: undefined } : lesson));
    await expect(
      buildPayload({ lessonsPerWeek: 3, shares: [{ teacherId: 't3', lessons: 1, minutes: 60 }] }),
    ).rejects.toMatchObject({ status: 502 });
    expect(lastTx['masterLesson']!['createMany']).not.toHaveBeenCalled();
  });

  it('delade lektioner: refuses to write an answer whose post was shared differently while the engine ran, as a draft that moved (409), not the engine’s 502', async () => {
    const row = {
      id: 'r1',
      subjectId: 's1',
      studentGroupId: 'g1',
      teacherId: 't1',
      coTeacherId: null,
      lessonsPerWeek: 3,
      minutesPerLesson: 60,
      lessonLengths: [],
      subject: { requiredRoomTypeId: null },
    };
    await expect(
      buildPayload({ lessonsPerWeek: 3, shares: [{ teacherId: 't3', lessons: 1, minutes: 60 }] }, [], [], (tx) => {
        // The fetch reads Bo's one; the write's own read finds two.
        tx['teachingRequirement']!['findMany']!
          .mockResolvedValueOnce([{ ...row, shares: [{ teacherId: 't3', lessons: 1, minutes: 60 }] }])
          .mockResolvedValue([{ ...row, shares: [{ teacherId: 't3', lessons: 2, minutes: 60 }] }]);
      }),
    ).rejects.toMatchObject({ status: 409, response: expect.objectContaining({ code: 'GENERATE_STALE' }) });
    expect(lastTx['masterLesson']!['createMany']).not.toHaveBeenCalled();
  });

  it('delade lektioner: sends a post whose lessons left have one teacher as it always did, with that teacher', async () => {
    // Anna's two lessons locked by hand: only Bo's is left to place.
    const lock = (id: string) => ({
      id,
      subjectId: 's1',
      studentGroupId: 'g1',
      teacherId: 't1',
      coTeacherId: null,
      roomId: null,
      dayOfWeek: 2,
      startTime: new Date('1970-01-01T08:00:00.000Z'),
      endTime: new Date('1970-01-01T09:00:00.000Z'),
      recurrence: 'ALL_WEEKS',
      startDate: null,
      endDate: null,
      extraGroups: [],
      participants: [],
    });
    const payload = await buildPayload(
      {
        lessonsPerWeek: 3,
        recurrence: 'ALL_WEEKS',
        startDate: null,
        endDate: null,
        shares: [{ teacherId: 't3', lessons: 1, minutes: 60 }],
      },
      [lock('ml-a'), lock('ml-b')],
    );
    const requirements = payload['requirements'] as Array<Record<string, unknown>>;
    // One lesson, one teacher: the entry a post with one teacher always had.
    expect(Object.keys(requirements[0]!).sort()).toEqual(REQUIREMENT_FIELDS);
    expect(requirements[0]!['lessonsPerWeek']).toBe(1);
    // The scalar is Bo, not the post's lead: the fixed lessons are Anna's.
    const fixed = payload['fixedLessons'] as Array<Record<string, unknown>>;
    expect(fixed.map((lesson) => lesson['teacherId'])).not.toContain(requirements[0]!['teacherId']);
    // And the lesson is written Bo's: a post sent with one teacher who is not
    // its lead is that teacher's, never stamped with the lead.
    const written = (lastTx['masterLesson']!['createMany']!.mock.calls as [{ data: { teacherId: string | null }[] }][])
      .flatMap(([call]) => call.data)
      .map((lesson) => lesson.teacherId);
    expect(written).toEqual(['t3']);
  });

  it('delade lektioner: sends a block with one split member, and refuses one with two by name, before the engine', async () => {
    const shared = (teacherId: string) => ({ lessonsPerWeek: 2, shares: [{ teacherId, lessons: 1, minutes: 60 }] });
    // One split member: its lessons laid against the other's in any order, so sent.
    const one = await buildPayload({ blockId: 'b1', ...shared('t3') }, [], [member({ blockId: 'b1', lessonsPerWeek: 2 })], named);
    const sent = one['requirements'] as Array<Record<string, unknown>>;
    expect(sent.map((r) => r['blockId'] !== undefined)).toEqual([true, true]);
    expect(sent[0]!['lessonTeacherIds']).toHaveLength(2);

    // Two: the block's k-th lessons tie one teacher's to one particular other's.
    await expect(
      buildPayload({ blockId: 'b1', ...shared('t3') }, [], [member({ blockId: 'b1', ...shared('t4') })], named),
    ).rejects.toMatchObject({ response: { code: 'BLOCK_MEMBERS_SPLIT', params: { block: 'Språkval åk 7' } } });
    expect(lastPost).not.toHaveBeenCalled();
  });

  it('sends every member of a block the block’s one anonymous id, and nothing else new', async () => {
    const payload = await buildPayload({ blockId: 'b1' }, [], [member({ blockId: 'b1' })], named);
    const requirements = payload['requirements'] as Array<Record<string, unknown>>;

    expect(requirements).toHaveLength(2);
    expect(Object.keys(requirements[0]!).sort()).toEqual(
      REQUIREMENT_FIELDS_BLOCKED.filter(
        (field) => !['lessonLengths', 'lockedDays', 'maxLessonsPerDay', 'minDaysBetween'].includes(field),
      ),
    );
    expect(requirements[0]!['blockId']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(requirements[1]!['blockId']).toBe(requirements[0]!['blockId']);
  });

  it('sends a block of one member no block, and asks for no block name when no row has one', async () => {
    const alone = await buildPayload({ blockId: 'b1' }, [], [member()], named);
    for (const requirement of alone['requirements'] as Array<Record<string, unknown>>) {
      expect(Object.keys(requirement).sort()).toEqual(REQUIREMENT_FIELDS);
    }

    await buildPayload();
    expect(lastTx['teachingBlock']!['findMany']).not.toHaveBeenCalled();
  });

  it('refuses a partly locked block before the engine, by the block’s name and its rows', async () => {
    // Språkval åk 7: r1's one lesson is locked every week, r2's is still to
    // place. The block cannot be held together around the lock.
    await buildPayload(
      { blockId: 'b1' },
      [
        {
          id: 'ml-locked',
          subjectId: 's1',
          studentGroupId: 'g1',
          teacherId: 't1',
          coTeacherId: null,
          roomId: null,
          dayOfWeek: 1,
          startTime: new Date('1970-01-01T09:00:00.000Z'),
          endTime: new Date('1970-01-01T10:00:00.000Z'),
          recurrence: 'ALL_WEEKS',
          startDate: null,
          endDate: null,
          extraGroups: [],
          participants: [],
        },
      ],
      [member({ blockId: 'b1', recurrence: 'ALL_WEEKS', startDate: null, endDate: null })],
      named,
    );

    expect(lastPost).not.toHaveBeenCalled();
    expect(lastResult.status).toBe('INFEASIBLE');
    expect(lastResult.lessons).toEqual([]);
    expect(lastResult.conflicts?.summaryCode).toBe('BLOCK_PARTLY_LOCKED_SUMMARY');
    expect(lastResult.conflicts?.summaryParams).toEqual({ count: 1 });
    const [detail] = lastResult.conflicts!.conflicts;
    expect(detail).toMatchObject({
      category: 'TEACHING_BLOCK',
      code: 'BLOCK_PARTLY_LOCKED',
      params: { block: 'Språkval åk 7', locked: 1 },
      resourceIds: ['b1'],
      resourceNames: ['Språkval åk 7'],
    });
    // Both rows, by the ids the payload gave them, as every refusal carries them.
    expect(detail!.requirementIds).toHaveLength(2);
    expect(detail!.message).toContain('Språkval åk 7 has 1 lesson locked');
    expect(lastTx['masterLesson']!['deleteMany']).not.toHaveBeenCalled();
  });

  it('places a block whose every lesson is locked as the school locked it, and refuses nothing', async () => {
    const locked = (groupId: string, subjectId: string) => ({
      id: `ml-${groupId}`,
      subjectId,
      studentGroupId: groupId,
      teacherId: null,
      coTeacherId: null,
      roomId: null,
      dayOfWeek: 1,
      startTime: new Date('1970-01-01T09:00:00.000Z'),
      endTime: new Date('1970-01-01T10:00:00.000Z'),
      recurrence: 'ALL_WEEKS',
      startDate: null,
      endDate: null,
      extraGroups: [],
      participants: [],
    });
    await buildPayload(
      { blockId: 'b1', recurrence: 'ALL_WEEKS', startDate: null, endDate: null },
      [locked('g1', 's1'), locked('g2', 's2')],
      [member({ blockId: 'b1', recurrence: 'ALL_WEEKS', startDate: null, endDate: null })],
      named,
    );

    expect(lastResult.conflicts).toBeNull();
  });

  it('sends a split requirement the same fields and its lengths', async () => {
    const payload = await buildPayload({ lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40] });
    const requirements = payload['requirements'] as Array<Record<string, unknown>>;
    expect(Object.keys(requirements[0]!).sort()).toEqual(REQUIREMENT_FIELDS_MIXED);
    expect(requirements[0]).toMatchObject({ lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40] });
  });

  it('sends a requirement with an ämnesfördelning its rule and its locked weekdays', async () => {
    // The subject's rule, and one lesson of the row locked on a Wednesday
    // every odd week — which cancels no demand (its weeks are not the row's)
    // and is still on Wednesday in the weeks it runs.
    const payload = await buildPayload(
      { subject: { requiredRoomTypeId: null, maxLessonsPerDay: 1, minDaysBetween: 2 } },
      [
        {
          id: 'ml-locked',
          subjectId: 's1',
          studentGroupId: 'g1',
          teacherId: 't1',
          coTeacherId: null,
          roomId: null,
          dayOfWeek: 3,
          startTime: new Date('1970-01-01T09:00:00.000Z'),
          endTime: new Date('1970-01-01T10:00:00.000Z'),
          recurrence: 'ODD_WEEKS',
          startDate: null,
          endDate: null,
          extraGroups: [],
          participants: [],
        },
      ],
    );
    const requirements = payload['requirements'] as Array<Record<string, unknown>>;
    expect(Object.keys(requirements[0]!).sort()).toEqual(
      REQUIREMENT_FIELDS_DISTRIBUTED.filter((field) => field !== 'lessonLengths'),
    );
    expect(requirements[0]).toMatchObject({ maxLessonsPerDay: 1, minDaysBetween: 2, lockedDays: [3] });
  });

  it('sends a row with its own rule of no limit nothing, although its subject has one', async () => {
    const payload = await buildPayload({
      ownDistribution: true,
      maxLessonsPerDay: null,
      minDaysBetween: null,
      subject: { requiredRoomTypeId: null, maxLessonsPerDay: 1, minDaysBetween: 2 },
    });
    const requirements = payload['requirements'] as Array<Record<string, unknown>>;
    expect(Object.keys(requirements[0]!).sort()).toEqual(REQUIREMENT_FIELDS);
  });

  it('reads both halves of the rule out of the database, the row’s and the subject’s', async () => {
    // Asserted on the QUERY for the reason the room rules are: the mock hands
    // its fixture back whole whatever the projection, so a column dropped from
    // the select would read as no rule and the run would succeed without it.
    await buildPayload();

    const select = lastTx['teachingRequirement']!['findMany']!.mock.calls[0][0].select;
    expect(select).toMatchObject({
      ownDistribution: true,
      maxLessonsPerDay: true,
      minDaysBetween: true,
      subject: { select: { maxLessonsPerDay: true, minDaysBetween: true } },
    });
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

  const run = async (reply: (requestId: string) => object = engineReply, keepsSites = false) => {
    const tx = createTxMock();
    const prisma = createPrismaMock(tx);
    tx['academicYear']!['findUnique']!.mockResolvedValue({ id: 'year-1', schoolId: 'school-1' });
    tx['lunchSetting']!['findUnique']!.mockResolvedValue({ generatorKeepsTravelTime: keepsSites });
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
        siteId: 'site-n',
      },
      {
        id: 'rm2',
        capacity: 30,
        roomTypeId: null,
        minGradeLevel: null,
        maxGradeLevel: null,
        building: 'Hus B',
        floor: 1,
        siteId: 'site-s',
      },
    ]);
    // The walk the switch is kept for: one figure above zero between the two
    // rooms' sites, which is what makes Optimera salar keep the sites.
    tx['siteTravelTime']!['findMany']!.mockResolvedValue([{ siteAId: 'site-n', siteBId: 'site-s' }]);
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

  it('sends each room’s site, a token, only when the school’s generator keeps the walk', async () => {
    // Restid i generatorn: the engine then moves no lesson off its site.
    const { sent } = await run(engineReply, true);
    const rooms = sent['rooms'] as Array<Record<string, unknown>>;
    expect(Object.keys(rooms[0]!).sort()).toEqual([...ROOMS_ROOM_FIELDS, 'siteId'].sort());
    expect(rooms[0]!['siteId']).not.toBe('site-n');
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
