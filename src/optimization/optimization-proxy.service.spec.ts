import { HttpException, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { HttpService } from '@nestjs/axios';
import type { ConfigService } from '@nestjs/config';
import { AxiosError } from 'axios';
import { of, throwError, timer } from 'rxjs';
import { mergeMap } from 'rxjs/operators';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  createPrismaMock,
  createTxMock,
  testUser,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import type {
  AiEngineLesson,
  AiEngineLunch,
  AiEngineScheduleRequest,
  AiEngineScheduleResponse,
  DayOfWeek,
} from './interfaces/ai-engine-payload.interface';
import {
  calendarSweepWhere,
  coverageLessonsOf,
  engineMayStillBeSolving,
  OptimizationProxyService,
  previousLessonsFrom,
  unplacedOf,
  yearGrades,
  type AnonMaps,
  type CandidateApplyInput,
  type CandidateLesson,
  type PreparedSchedule,
} from './optimization-proxy.service';
import * as eligibility from './room-eligibility';
import { WORK_DAYS_HIDDEN_MESSAGE, WorkDaysRefusal } from './work-days';
import { recordedReads } from '../../test/utils/recorded-reads';
import * as candidateBasis from './candidate-basis';
import { toNioarig, type GradeNumbering } from '../common/grade-numbering';

const ACADEMIC_YEAR = '44444444-4444-4444-8444-444444444444';
/** One requirement, as the database holds it and as the engine sees it. */
const REAL_REQ = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ANON_REQ = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

/** The school the test principal belongs to, and a year of one it does not. */
const THIS_SCHOOL = testUser().schoolId as string;
const OTHER_SCHOOL = '33333333-3333-4333-8333-3333333333ff';
const OTHER_YEAR = '44444444-4444-4444-8444-4444444444ff';

const makeConfigService = () =>
  ({
    // Keyed as the real one is: a namespace nobody registered is an error,
    // not the engine's settings under another name.
    getOrThrow: jest.fn((key: string) => {
      if (key !== 'aiEngine') throw new TypeError(`Configuration key "${key}" does not exist`);
      return { baseUrl: 'http://solver.test', apiKey: 'k'.repeat(32), timeoutMs: 50 };
    }),
  }) as unknown as ConfigService;

type Row = Record<string, unknown>;
type Selection = Record<string, unknown> | undefined;
type Query = { where?: Row; select?: Selection };

/** 55P03 as @prisma/adapter-pg hands a lock_timeout over. */
const lockTimeout = () =>
  new Prisma.PrismaClientKnownRequestError('canceling statement due to lock timeout', {
    code: 'P2010',
    clientVersion: '7',
    meta: { driverAdapterError: { cause: { originalCode: '55P03' } } },
  });

/** The SQL text of a tagged-template $executeRaw call, its values as `?`. */
const rawSql = (call: unknown[]): string => (call[0] as readonly string[]).join('?');

/** The body an HttpException answers with. */
const bodyOf = (error: unknown): Record<string, unknown> =>
  (error as HttpException).getResponse() as Record<string, unknown>;

/** The preserve rule, as every where-clause that names it spells it. */
const PRESERVED = {
  OR: [
    { isGenerated: false },
    { isLocked: true },
    { extraGroups: { some: {} } },
    { participants: { some: {} } },
  ],
};

/*
 * Tables that answer as Prisma does. A select returns the fields it names and
 * nothing else, a relation only through its own select, scalars only when no
 * select is given — and a select naming nothing is refused, as the engine
 * refuses it (EmptySelection). A field the service stops selecting is then a
 * field its code no longer gets, rather than one the fixture hands it anyway.
 */
const isRelation = (value: unknown): boolean =>
  // A scalar list (lessonLengths: [80, 40]) is a column, not a relation.
  (Array.isArray(value) && !(value.length > 0 && value.every((item) => typeof item !== 'object'))) ||
  (!Array.isArray(value) && value !== null && typeof value === 'object' && !(value instanceof Date));
const assertSelects = (select: Selection): void => {
  if (select === undefined) return;
  const asked = Object.entries(select).filter(([, how]) => how);
  if (asked.length === 0) throw new Error('EmptySelection: a select must ask for a field');
  for (const [, how] of asked) {
    if (typeof how === 'object') assertSelects((how as { select?: Selection }).select);
  }
};
const selected = (row: Row, select: Selection): Row => {
  if (select === undefined) {
    return Object.fromEntries(Object.entries(row).filter(([, value]) => !isRelation(value)));
  }
  const out: Row = {};
  for (const [field, how] of Object.entries(select)) {
    if (!how || !(field in row)) continue;
    const value = row[field];
    const nested = typeof how === 'object' ? (how as { select?: Selection }).select : undefined;
    const pick = (item: unknown) => (item === null ? null : selected(item as Row, nested));
    out[field] = !isRelation(value) ? value : Array.isArray(value) ? value.map(pick) : pick(value);
  }
  return out;
};
/** `{ in: [...] }`, or no condition when the filter names no list. */
const within = (value: unknown, filter: unknown): boolean => {
  const list = (filter as { in?: unknown[] } | undefined)?.in;
  return list === undefined || list.includes(value);
};
/**
 * A where clause as Prisma applies it, for the filters these reads use: the
 * year, the year -> school hop, and plain flags. A row is this year's and this
 * school's unless it says otherwise. A filter this does not know is refused
 * rather than ignored, and an empty filter object is no condition.
 */
const matchesWhere = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([key, filter]) => {
    switch (key) {
      case 'academicYearId':
        return (row['academicYearId'] ?? ACADEMIC_YEAR) === filter;
      case 'school': {
        const yearId = (filter as { academicYears?: { some?: { id?: string } } } | undefined)
          ?.academicYears?.some?.id;
        const schoolOfYear = yearId === ACADEMIC_YEAR ? THIS_SCHOOL : OTHER_SCHOOL;
        return yearId === undefined || (row['schoolId'] ?? THIS_SCHOOL) === schoolOfYear;
      }
      case 'isGenerated':
      case 'kind':
        return row[key] === filter;
      case 'maxTeachingDaysPerWeek': {
        // `{ not: null }`, the one shape the posts are read by: a post that
        // limits its days.
        if ((filter as { not?: unknown }).not !== null) throw new Error(`unexpected filter ${key}`);
        return row[key] !== null && row[key] !== undefined;
      }
      case 'AND':
        return (filter as Row[]).every((part) => matchesWhere(row, part));
      case 'OR':
        return (filter as Row[]).some((part) => matchesWhere(row, part));
      case 'teacherDutySlot': {
        // The 1:0..1 back-relation to an uppdrag's link (20261017090000), by
        // `is`: null, or a link whose duty is of the year.
        const slot = (row['teacherDutySlot'] ?? null) as Row | null;
        const is = (filter as { is?: Row | null }).is;
        if (is === null) return slot === null;
        return slot !== null && matchesWhere(slot, is ?? {});
      }
      case 'teacherDuty': {
        // From a link to its duty, by `is`: the duty's year.
        const duty = (row['teacherDuty'] ?? null) as Row | null;
        const is = (filter as { is?: Row | null }).is;
        if (is === null) return duty === null;
        return duty !== null && Object.entries(is ?? {}).every(([field, value]) => duty[field] === value);
      }
      default:
        throw new Error(`unexpected filter ${key}`);
    }
  });
/** A table read: the rows its where lets through, as its select shapes them. */
const table =
  (rows: unknown[]) =>
  async ({ where, select }: Query = {}) => {
    assertSelects(select);
    return (rows as Row[])
      .filter((row) => matchesWhere(row, where))
      .map((row) => selected(row, select));
  };

describe('engineMayStillBeSolving (a schemaförslag run keeps its call\'s deadline)', () => {
  it('after a call that reached the engine and timed out: this gateway\'s timeout, or the engine\'s own 503 or 504', () => {
    expect(engineMayStillBeSolving(new ServiceUnavailableException('The AI engine did not respond in time.'))).toBe(true);
    expect(engineMayStillBeSolving(new HttpException({ message: 'The AI engine returned an error.' }, 503))).toBe(true);
    expect(engineMayStillBeSolving(new HttpException({ message: 'The AI engine returned an error.' }, 504))).toBe(true);
  });

  it('never after a call that did not connect, failed before it was sent, or that the engine answered', () => {
    expect(engineMayStillBeSolving(new ServiceUnavailableException('The AI engine could not be reached.'))).toBe(false);
    expect(engineMayStillBeSolving(new ServiceUnavailableException('AI engine unavailable.'))).toBe(false);
    expect(engineMayStillBeSolving(new HttpException({ message: 'older', code: 'ENGINE_LACKS_CANDIDATES' }, 503))).toBe(false);
    expect(engineMayStillBeSolving(new HttpException('The AI engine returned an error.', 500))).toBe(false);
    expect(engineMayStillBeSolving(new HttpException({ message: 'Lunch has no room.', code: 'LUNCH_WINDOW_EMPTY' }, 400))).toBe(false);
    expect(engineMayStillBeSolving(new Error('boom'))).toBe(false);
  });
});

describe('OptimizationProxyService', () => {
  let service: OptimizationProxyService;
  let tx: TxMock;
  let http: { post: jest.Mock };

  beforeEach(() => {
    tx = createTxMock();
    http = { post: jest.fn() };

    service = new OptimizationProxyService(
      {} as unknown as PrismaService,
      http as unknown as HttpService,
      makeConfigService(),
    );
  });

  /**
   * `persistMasterLessons` is private, and reaching it through
   * `triggerScheduling` would mean mocking the entire fetch-and-anonymize
   * pipeline. It is exercised directly because what it guards is the most
   * destructive path in the codebase: a delete-and-recreate of a school's
   * timetable. Testing it through six layers of setup would obscure that.
   */
  const persist = (
    response: Partial<AiEngineScheduleResponse>,
    {
      user = testUser(),
      /** The demand the engine was sent, which its answer must match. */
      requirements = [] as { id: string; lessonsPerWeek: number; lessonLengths?: number[] }[],
      requirementAnonMap = new Map<string, string>(),
      /** The posts written at a sent post's times (same-times.ts), in real ids. */
      mirrors = [] as { leaderId: string; followerId: string }[],
      /** Sittings carrying REAL group ids, as realiseLunches hands them over. */
      lunches = [] as AiEngineLunch[],
      headcountByGroup = new Map<string, number>(),
      /**
       * The draft's own masters as the fetch saw them. The default is what an
       * unstubbed findMany answers under the lock, an empty draft, so the
       * GENERATE_STALE check passes unless a test says otherwise.
       */
      draftIds = [] as string[],
    } = {},
  ) =>
    (
      service as unknown as {
        persistMasterLessons: (
          tx: PrismaClient,
          academicYearId: string,
          user: unknown,
          response: AiEngineScheduleResponse,
          demand: { requirementId: string; lessonsPerWeek: number; lessonLengths?: number[] }[],
          mirrors: { leaderId: string; followerId: string }[],
          requirementAnonMap: Map<string, string>,
          roomAnonMap: Map<string, string>,
          lunches: AiEngineLunch[],
          headcountByGroup: Map<string, number>,
          draftIds: string[],
        ) => Promise<unknown>;
      }
    ).persistMasterLessons(
      tx as unknown as PrismaClient,
      ACADEMIC_YEAR,
      user,
      { status: 'FEASIBLE', lessons: [], ...response } as AiEngineScheduleResponse,
      // The demand in real ids, as prepareSchedule hands it over, with each
      // mirrored post's beside its leader's.
      [
        ...requirements.map((requirement) => ({
          requirementId: [...requirementAnonMap].find(([, anon]) => anon === requirement.id)?.[0] ?? `unsent:${requirement.id}`,
          lessonsPerWeek: requirement.lessonsPerWeek,
          ...(requirement.lessonLengths ? { lessonLengths: requirement.lessonLengths } : {}),
        })),
        ...mirrors.flatMap((mirror) => {
          const leader = requirements.find((requirement) => requirementAnonMap.get(mirror.leaderId) === requirement.id);
          return leader ? [{ requirementId: mirror.followerId, lessonsPerWeek: leader.lessonsPerWeek }] : [];
        }),
      ],
      mirrors,
      requirementAnonMap,
      new Map(),
      lunches,
      headcountByGroup,
      draftIds,
    );

  /**
   * The master lessons a write created, in order: one createMany for the lot
   * (no create carries a nested write), so the rows are its data.
   */
  const written = (): Record<string, any>[] =>
    (tx.masterLesson.createMany.mock.calls as [{ data: Record<string, any>[] }][]).flatMap(
      ([call]) => call.data,
    );

  /** A placement of `ANON_REQ`, as the engine words it. */
  const placement = (requirementId = ANON_REQ): AiEngineLesson => ({
    requirementId,
    roomId: null,
    dayOfWeek: 1,
    startTime: '08:00:00',
    endTime: '09:00:00',
  });

  /** One requirement asking for `lessonsPerWeek`, wired anon → real. */
  const oneRequirement = (lessonsPerWeek: number) => {
    tx.teachingRequirement.findMany.mockImplementation(
      table([
        {
          id: REAL_REQ,
          subjectId: 'subject-1',
          studentGroupId: 'group-1',
          teacherId: null,
          coTeacherId: null,
        },
      ]),
    );
    return {
      requirements: [{ id: ANON_REQ, lessonsPerWeek }],
      requirementAnonMap: new Map([[REAL_REQ, ANON_REQ]]),
    };
  };

  describe('persistMasterLessons — destructive-path guards', () => {
    it.each(['INFEASIBLE', 'TIMEOUT'])(
      'writes nothing and deletes nothing when the solver returns %s',
      async (status) => {
        await persist({ status: status as AiEngineScheduleResponse['status'] });

        // The regression this guards: a run that produced no lessons must not
        // wipe the school's existing unlocked timetable on its way out.
        expect(tx.masterLesson.deleteMany).not.toHaveBeenCalled();
        expect(tx.masterLesson.createMany).not.toHaveBeenCalled();
        expect(tx.masterLesson.create).not.toHaveBeenCalled();
      },
    );

    it('refuses to persist when the principal carries no tenant', async () => {
      await expect(
        persist({ status: 'FEASIBLE' }, { user: testUser({ schoolId: undefined }) }),
      ).rejects.toThrow('schoolId missing from JWT');

      expect(tx.masterLesson.deleteMany).not.toHaveBeenCalled();
    });

    it('answers with the lessons it wrote, by their teachers and weekday, or with null when it wrote none', async () => {
      // What the free-day wishes are read against (unkeptFreeDayWishes): the
      // timetable as written, its teachers the requirement's at the time of
      // writing. Null, not an empty list, for a run that left last week's
      // timetable standing: there is nothing new to read a wish against.
      await expect(persist({ status: 'INFEASIBLE' })).resolves.toBeNull();

      tx.calendarLesson.deleteMany.mockResolvedValue({ count: 0 });
      tx.masterLesson.deleteMany.mockResolvedValue({ count: 0 });
      tx.teachingRequirement.findMany.mockResolvedValue([
        { id: REAL_REQ, subjectId: 'subject-1', studentGroupId: 'group-1', teacherId: 'lead-1', coTeacherId: 'co-1' },
      ]);
      await expect(
        persist(
          { status: 'OPTIMAL', lessons: [{ ...placement(), dayOfWeek: 3 }] },
          { requirements: [{ id: ANON_REQ, lessonsPerWeek: 1 }], requirementAnonMap: new Map([[REAL_REQ, ANON_REQ]]) },
        ),
      ).resolves.toEqual([{ teacherId: 'lead-1', coTeacherId: 'co-1', dayOfWeek: 3 }]);
    });

    it('answers with the lessons it kept, as they stand after its delete, beside the ones it wrote', async () => {
      // The kept half is read here, in the write's transaction, after the
      // delete: the solver has been running since the fetch, and the timetable
      // a wish is read against is the one this leaves, not the one the fetch saw.
      const order: string[] = [];
      tx.calendarLesson.deleteMany.mockResolvedValue({ count: 0 });
      tx.masterLesson.deleteMany.mockImplementation(async () => {
        order.push('delete');
        return { count: 0 };
      });
      tx.masterLesson.findMany.mockImplementation(async ({ where }: { where?: Record<string, unknown> } = {}) => {
        // The draft's own lessons, read again under the year lock
        // (GENERATE_STALE): the empty draft the fetch saw.
        if (where?.['NOT']) return [];
        order.push('read');
        return [
          { teacherId: 'hand-1', coTeacherId: null, dayOfWeek: 5, isParked: false },
          { teacherId: 'locked-1', coTeacherId: 'co-2', dayOfWeek: 2, isParked: false },
          // Parked: kept, counted, and on no day.
          { teacherId: 'parked-1', coTeacherId: null, dayOfWeek: 4, isParked: true },
        ];
      });
      tx.masterLesson.createMany.mockImplementation(async () => {
        order.push('create');
        return { count: 1 };
      });
      tx.teachingRequirement.findMany.mockResolvedValue([
        { id: REAL_REQ, subjectId: 'subject-1', studentGroupId: 'group-1', teacherId: 'lead-1', coTeacherId: null },
      ]);

      await expect(
        persist(
          { status: 'OPTIMAL', lessons: [{ ...placement(), dayOfWeek: 3 }] },
          { requirements: [{ id: ANON_REQ, lessonsPerWeek: 1 }], requirementAnonMap: new Map([[REAL_REQ, ANON_REQ]]) },
        ),
      ).resolves.toEqual([
        { teacherId: 'hand-1', coTeacherId: null, dayOfWeek: 5 },
        { teacherId: 'locked-1', coTeacherId: 'co-2', dayOfWeek: 2 },
        { teacherId: 'lead-1', coTeacherId: null, dayOfWeek: 3 },
      ]);
      // After the delete, before the new rows: what the delete kept, and
      // nothing the run wrote counted as kept.
      expect(order).toEqual(['delete', 'read', 'create']);
      // The one read the audit's count is taken from, too.
      expect(tx.masterLesson.count).not.toHaveBeenCalled();
      expect(tx.scheduleChangeLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ after: expect.objectContaining({ lockedPreserved: 3 }) }),
      });
    });

    it('checks the tenant before deleting anything', async () => {
      // Ordering matters: the schoolId guard sits after the status check but
      // before deleteMany, so a tokenless request cannot destroy data either.
      tx.teachingRequirement.findMany.mockResolvedValue([]);

      await expect(
        persist({ status: 'OPTIMAL' }, { user: testUser({ schoolId: undefined }) }),
      ).rejects.toThrow();
      expect(tx.masterLesson.deleteMany).not.toHaveBeenCalled();
    });
  });

  /**
   * The engine places every lesson it is asked for or none at all, so a
   * response that does not match the demand it was sent is not an answer to
   * this request — and must be refused *before* the delete, not dropped after
   * it. Each case below is a well-formed, schema-valid FEASIBLE body: schema
   * validation would pass every one of them, and every one of them used to
   * empty out the year's machine-owned timetable.
   */
  describe('persistMasterLessons — verifying the solution before replacing', () => {
    beforeEach(() => {
      tx.masterLesson.deleteMany.mockResolvedValue({ count: 40 });
      tx.calendarLesson.deleteMany.mockResolvedValue({ count: 0 });
    });

    const expectNothingTouched = () => {
      expect(tx.masterLesson.deleteMany).not.toHaveBeenCalled();
      expect(tx.calendarLesson.deleteMany).not.toHaveBeenCalled();
      expect(tx.masterLesson.createMany).not.toHaveBeenCalled();
      expect(tx.scheduleChangeLog.create).not.toHaveBeenCalled();
    };

    it('refuses an empty solution and leaves the timetable standing', async () => {
      await expect(
        persist({ status: 'FEASIBLE', lessons: [] }, oneRequirement(3)),
      ).rejects.toMatchObject({ status: 502 });

      expectNothingTouched();
    });

    it('names the refusal in the error the caller sees', async () => {
      await expect(
        persist({ status: 'FEASIBLE', lessons: [] }, oneRequirement(1)),
      ).rejects.toThrow('does not match the requested timetable');
    });

    it('refuses a solution that places fewer lessons than were asked for', async () => {
      // Three a week requested, one placed: accepting it would replace the
      // whole year with a third of a timetable.
      await expect(
        persist(
          { status: 'FEASIBLE', lessons: [placement()] },
          oneRequirement(3),
        ),
      ).rejects.toMatchObject({ status: 502 });

      expectNothingTouched();
    });

    it('refuses a solution that places more lessons than were asked for', async () => {
      await expect(
        persist(
          { status: 'OPTIMAL', lessons: [placement(), placement()] },
          oneRequirement(1),
        ),
      ).rejects.toMatchObject({ status: 502 });

      expectNothingTouched();
    });

    it('refuses a solution naming a requirement this request never sent', async () => {
      await expect(
        persist(
          {
            status: 'FEASIBLE',
            lessons: [placement('ffffffff-ffff-4fff-8fff-ffffffffffff')],
          },
          oneRequirement(1),
        ),
      ).rejects.toMatchObject({ status: 502 });

      expectNothingTouched();
    });

    it('refuses a solution that covers the demand and places a lesson for a requirement never sent besides', async () => {
      // Every lesson that was asked for is there, and one more. The count of
      // what matched is right; the lesson that matched nothing is what makes
      // it an answer to some other request.
      await expect(
        persist(
          {
            status: 'OPTIMAL',
            lessons: [placement(), placement('ffffffff-ffff-4fff-8fff-ffffffffffff')],
          },
          oneRequirement(1),
        ),
      ).rejects.toMatchObject({ status: 502 });

      expectNothingTouched();
    });

    it('refuses when a requirement was deleted while the solver ran', async () => {
      const asked = oneRequirement(1);
      // The anon id still resolves, but the row it names is gone from the
      // year: the solution describes a timetable that no longer exists.
      tx.teachingRequirement.findMany.mockResolvedValue([]);

      await expect(
        persist({ status: 'FEASIBLE', lessons: [placement()] }, asked),
      ).rejects.toMatchObject({ status: 502 });

      expectNothingTouched();
    });

    it('replaces the timetable when the solution covers the demand exactly', async () => {
      await persist(
        { status: 'OPTIMAL', lessons: [placement(), placement()] },
        oneRequirement(2),
      );

      expect(tx.masterLesson.deleteMany).toHaveBeenCalledTimes(1);
      expect(written()).toHaveLength(2);
      // Built before the delete, written after it — and every create must land
      // after the delete, or the new lessons would be deleted with the old.
      expect(tx.masterLesson.createMany.mock.invocationCallOrder[0]).toBeGreaterThan(
        tx.masterLesson.deleteMany.mock.invocationCallOrder[0]!,
      );
    });

    it('still clears leftovers when every lesson was already placed by hand', async () => {
      // No requirement reaches the engine, so nothing is demanded and nothing
      // is placed — the one empty solution that is a correct answer.
      await persist({ status: 'FEASIBLE', lessons: [] });

      expect(tx.masterLesson.deleteMany).toHaveBeenCalledTimes(1);
      expect(tx.masterLesson.createMany).not.toHaveBeenCalled();
    });
  });

  describe('persistMasterLessons — the sittings', () => {
    beforeEach(() => {
      tx.masterLesson.deleteMany.mockResolvedValue({ count: 0 });
      tx.calendarLesson.deleteMany.mockResolvedValue({ count: 0 });
      tx.lunchSitting.deleteMany.mockResolvedValue({ count: 0 });
      tx.calendarLunch.deleteMany.mockResolvedValue({ count: 0 });
      // The year's groups, a class and a teaching group. A sitting is written
      // for a class and for nothing else — see the teaching-group test.
      tx.studentGroup.findMany.mockImplementation(
        table([
          { id: 'g-7a', kind: 'CLASS' },
          { id: 'g-ma71', kind: 'TEACHING_GROUP' },
        ]),
      );
    });

    const sitting = (groupId = 'g-7a', dayOfWeek: DayOfWeek = 1): AiEngineLunch => ({
      studentGroupId: groupId,
      dayOfWeek,
      startTime: '11:30:00',
      endTime: '12:00:00',
    });

    /** 7A's Monday meal, placed by the school at `startTime`. */
    const placedByHand = (startTime: string) =>
      tx.lunchSitting.findMany.mockImplementation(
        table([
          {
            id: 'hand-1',
            studentGroupId: 'g-7a',
            dayOfWeek: 1,
            startTime: new Date(`1970-01-01T${startTime}.000Z`),
            isGenerated: false,
          },
        ]),
      );

    it("replaces the solver's sittings and only the solver's", async () => {
      /*
       * A run deletes what it wrote. A meal the school placed by hand went to
       * the engine as a pin on the lunch variable it builds anyway — one
       * reservation, not the fixed lesson beside a live variable that would be
       * two — so it is an instruction to keep, not an output to replace.
       */
      await persist(
        { status: 'OPTIMAL', lessons: [placement()] },
        {
          ...oneRequirement(1),
          lunches: [sitting()],
          headcountByGroup: new Map([['g-7a', 24]]),
        },
      );

      expect(tx.lunchSitting.deleteMany).toHaveBeenCalledWith({
        where: { academicYearId: ACADEMIC_YEAR, isGenerated: true },
      });
      expect(tx.lunchSitting.createMany).toHaveBeenCalledWith({
        data: [
          {
            schoolId: testUser().schoolId,
            academicYearId: ACADEMIC_YEAR,
            studentGroupId: 'g-7a',
            dayOfWeek: 1,
            startTime: new Date('1970-01-01T11:30:00.000Z'),
            endTime: new Date('1970-01-01T12:00:00.000Z'),
            headcount: 24,
            isGenerated: true,
          },
        ],
      });
    });

    it('keeps a meal the school placed by hand, and writes nothing over it', async () => {
      /*
       * The engine reports a pinned meal back like any other, so its answer for
       * a hand-placed day lands on a row that already exists. Creating over it
       * would break LunchSittings_group_day_key inside this transaction, after
       * a solve the school watched succeed. The hand row keeps its start and
       * takes the length and headcount from the answer instead.
       */
      tx.lunchSitting.findMany.mockImplementation(
        table([
          {
            id: 'hand-1',
            studentGroupId: 'g-7a',
            dayOfWeek: 1,
            startTime: new Date('1970-01-01T11:30:00.000Z'),
            isGenerated: false,
          },
          // Last year's meal for a group of the same id space: that year's
          // decision, and not this run's to keep or to drop.
          {
            id: 'hand-last-year',
            academicYearId: OTHER_YEAR,
            studentGroupId: 'g-7a',
            dayOfWeek: 3,
            startTime: new Date('1970-01-01T11:30:00.000Z'),
            isGenerated: false,
          },
        ]),
      );

      await persist(
        { status: 'OPTIMAL', lessons: [placement()] },
        {
          ...oneRequirement(1),
          lunches: [sitting('g-7a', 1), sitting('g-7a', 2)],
          headcountByGroup: new Map([['g-7a', 26]]),
        },
      );

      const created = tx.lunchSitting.createMany.mock.calls[0][0].data;
      expect(created.map((row: { dayOfWeek: number }) => row.dayOfWeek)).toEqual([2]);
      expect(tx.lunchSitting.update).toHaveBeenCalledWith({
        where: { id: 'hand-1' },
        data: { endTime: new Date('1970-01-01T12:00:00.000Z'), headcount: 26 },
      });
      // And no hand-placed row goes: the one the engine answered for stays,
      // and the other year's was never this run's to judge.
      expect(tx.lunchSitting.deleteMany).not.toHaveBeenCalledWith({
        where: { id: { in: expect.anything() } },
      });
    });

    it('stores the headcount the engine was told, not a zero', async () => {
      // Kept so the kitchen's own list needs no re-derivation of a roster that
      // may have changed since the run.
      await persist(
        { status: 'OPTIMAL', lessons: [placement()] },
        {
          ...oneRequirement(1),
          lunches: [sitting()],
          headcountByGroup: new Map([['g-7a', 27]]),
        },
      );

      expect(tx.lunchSitting.createMany.mock.calls[0][0].data[0].headcount).toBe(27);
    });

    it('writes no sitting for a teaching group', async () => {
      // The engine gives a lunch interval to every group carrying a requirement
      // — its own comment says EVERY HOME CLASS EATS EVERY SCHOOL DAY, and the
      // set it walks unions the groups with lessons — so Ma71 arrives with
      // headcount 0 and a sitting every school day. Right in the engine, where
      // the interval keeps a teaching group's lessons out of its members' meal.
      // Wrong in this table, which is the kitchen's list and the pupil's band.
      await persist(
        { status: 'OPTIMAL', lessons: [placement()] },
        {
          ...oneRequirement(1),
          lunches: [sitting(), { ...sitting(), studentGroupId: 'g-ma71' }],
          headcountByGroup: new Map([['g-7a', 24]]),
        },
      );

      const [call] = tx.lunchSitting.createMany.mock.calls;
      expect(call[0].data).toHaveLength(1);
      expect(call[0].data[0].studentGroupId).toBe('g-7a');
    });

    it('drops a meal placed by hand that the run did not honour', async () => {
      /*
       * With lunch switched off the engine builds no meal and pins nothing, so
       * the lessons were placed straight across the hand-placed row. Kept, it
       * would sit on the grid and reach the pupil's calendar on top of one.
       */
      placedByHand('13:00:00');

      await persist(
        { status: 'OPTIMAL', lessons: [placement()] },
        { ...oneRequirement(1), lunches: [] },
      );

      expect(tx.lunchSitting.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['hand-1'] } },
      });
      expect(tx.lunchSitting.update).not.toHaveBeenCalled();
    });

    it('says so loudly when a hand-placed meal came back somewhere else', async () => {
      /*
       * The pin is the whole contract across this seam: the gateway sends the
       * school's start, the engine holds its own lunch variable there. An
       * answer at another start means the two halves have drifted — and the row
       * is still the school's, so it keeps the school's start rather than
       * quietly taking the engine's.
       */
      const logger = (service as unknown as { logger: { error: (message: string) => void } })
        .logger;
      const error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
      placedByHand('13:00:00');

      await persist(
        { status: 'OPTIMAL', lessons: [placement()] },
        { ...oneRequirement(1), lunches: [sitting('g-7a', 1)] },
      );

      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0][0]).toContain('did not bind');
      expect(tx.lunchSitting.update.mock.calls[0][0].data).not.toHaveProperty('startTime');
    });

    it('says nothing when the engine held the meal where it was placed', async () => {
      const logger = (service as unknown as { logger: { error: (message: string) => void } })
        .logger;
      const error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
      placedByHand('11:30:00');

      await persist(
        { status: 'OPTIMAL', lessons: [placement()] },
        { ...oneRequirement(1), lunches: [sitting('g-7a', 1)] },
      );

      expect(error).not.toHaveBeenCalled();
    });

    it("drops the year's already-published meals in the same transaction", async () => {
      // This file's own header states the rule: whoever replaces a generated
      // timetable deletes its future materializations in the same transaction.
      // The half for the lessons was written; the half for the meal was not, so
      // a republished week kept last month's lunch time for ever.
      await persist(
        { status: 'OPTIMAL', lessons: [placement()] },
        { ...oneRequirement(1), lunches: [sitting()] },
      );

      const [call] = tx.calendarLunch.deleteMany.mock.calls;
      // Reached through the group's year rather than a column of its own: a
      // backfilled academicYearId would join on (schoolId, studentGroupId,
      // dayOfWeek) while LunchSittings' unique key includes the year, so a
      // school in its second läsår has two matching rows.
      expect(call[0].where.studentGroup).toEqual({ is: { academicYearId: ACADEMIC_YEAR } });
      expect(call[0].where.date.gte).toBeInstanceOf(Date);
    });

    it("in DRAFT leaves the published meals alone: the regeneration is a draft, the calendar's meals are what families read", async () => {
      tx.$queryRaw.mockResolvedValueOnce([{ mode: 'DRAFT' }]);
      await persist(
        { status: 'OPTIMAL', lessons: [placement()] },
        { ...oneRequirement(1), lunches: [sitting()] },
      );

      // The draft's sittings are written (RLS hides them from non-admins) …
      expect(tx.lunchSitting.createMany).toHaveBeenCalledTimes(1);
      // … and neither the published lessons nor the published meals move.
      expect(tx.calendarLesson.deleteMany).not.toHaveBeenCalled();
      expect(tx.calendarLunch.deleteMany).not.toHaveBeenCalled();
    });

    it('leaves a meal that has already been eaten alone', async () => {
      await persist({ status: 'OPTIMAL', lessons: [placement()] }, oneRequirement(1));

      // Only the future. A meal on a day that has been is a fact about that
      // day, and there is no reason to rewrite it.
      const [call] = tx.calendarLunch.deleteMany.mock.calls;
      const cutoff: Date = call[0].where.date.gte;
      expect(cutoff.getUTCHours()).toBe(0);
      expect(cutoff.getUTCMinutes()).toBe(0);
    });

    it('clears the sittings when a run produces none', async () => {
      // A school that switched lunch off must not keep last term's flow on the
      // grid: the delete runs whether or not there is anything to write.
      await persist({ status: 'OPTIMAL', lessons: [placement()] }, oneRequirement(1));

      expect(tx.lunchSitting.deleteMany).toHaveBeenCalledTimes(1);
      expect(tx.lunchSitting.createMany).not.toHaveBeenCalled();
    });

    it('leaves the sittings alone when the engine found no timetable', async () => {
      // Both verdicts bail out before anything is deleted. A failed run that
      // wiped the flow would leave the kitchen with nothing while the timetable
      // it belongs to is still standing.
      await persist({ status: 'INFEASIBLE', lessons: [] }, { lunches: [sitting()] });

      expect(tx.lunchSitting.deleteMany).not.toHaveBeenCalled();
      expect(tx.lunchSitting.createMany).not.toHaveBeenCalled();
    });

    it('leaves the sittings alone when the solution is rejected', async () => {
      // The 502 path: the whole replacement is built and checked before a
      // single row is deleted, and the sittings are inside that guarantee.
      tx.teachingRequirement.findMany.mockResolvedValue([]);

      await expect(
        persist(
          { status: 'FEASIBLE', lessons: [placement()] },
          { ...oneRequirement(2), lunches: [sitting()] },
        ),
      ).rejects.toMatchObject({ status: 502 });

      expect(tx.lunchSitting.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('persistMasterLessons — non-destructive regeneration', () => {
    beforeEach(() => {
      tx.teachingRequirement.findMany.mockResolvedValue([]);
      tx.masterLesson.deleteMany.mockResolvedValue({ count: 3 });
      tx.calendarLesson.deleteMany.mockResolvedValue({ count: 7 });
    });

    /** A master lesson row, in the columns the preserve rule reads. */
    const lessonRow = (overrides: Record<string, unknown> = {}) => ({
      isGenerated: false,
      isLocked: false,
      extraGroups: [] as unknown[],
      participants: [] as unknown[],
      recurrence: 'ALL_WEEKS',
      startDate: null as Date | null,
      endDate: null as Date | null,
      ...overrides,
    });

    /**
     * The delete's own where-clause, applied to a row as Prisma would apply it.
     *
     * That clause is what decides whether a school's lesson is still there
     * after a regeneration, and asserting its literal shape only proves nobody
     * mistyped it. Four clause kinds are all it may contain; an unrecognised
     * one throws rather than quietly reading as "not preserved", which is the
     * direction that deletes somebody's lesson.
     */
    const survivesRegeneration = (lesson: Record<string, unknown>): boolean => {
      const call = tx.masterLesson.deleteMany.mock.calls[0]![0] as {
        where: { NOT: { OR: Array<Record<string, unknown>> } };
      };
      return call.where.NOT.OR.some((clause) => {
        if ('isGenerated' in clause) return lesson.isGenerated === clause.isGenerated;
        if ('isLocked' in clause) return lesson.isLocked === clause.isLocked;
        if ('extraGroups' in clause) return (lesson.extraGroups as unknown[]).length > 0;
        if ('participants' in clause) return (lesson.participants as unknown[]).length > 0;
        throw new Error(`Unhandled preserve clause: ${JSON.stringify(clause)}`);
      });
    };

    const springTerm = {
      startDate: new Date('2026-01-07T00:00:00.000Z'),
      endDate: new Date('2026-06-11T00:00:00.000Z'),
    };

    it('deletes its own windowed output instead of stacking a copy on it', async () => {
      await persist({ status: 'FEASIBLE', lessons: [] });

      // The whole reason ownership is a column. Inferred from the row looking
      // untouched, this lesson read as handmade — odd weeks, dates set — and so
      // it was preserved, its requirement still counted as unmet, and the next
      // run put a second copy beside it. Every press of generate added one.
      expect(
        survivesRegeneration(
          lessonRow({ isGenerated: true, recurrence: 'ODD_WEEKS', ...springTerm }),
        ),
      ).toBe(false);
    });

    it('keeps a half-term course a half-term course', async () => {
      await persist({ status: 'FEASIBLE', lessons: [] });

      // "Kemi bara på vårterminen", placed by hand. The engine has no week
      // model, so a regenerated replacement always comes back as an ordinary
      // weekly lesson: the course would quietly become a year-long one, with
      // nothing in the audit trail to say a school's decision was reversed.
      // It is the hand that saves it now, not the window.
      expect(survivesRegeneration(lessonRow(springTerm))).toBe(true);
    });

    it('keeps a generated lesson somebody has since taken over', async () => {
      await persist({ status: 'FEASIBLE', lessons: [] });

      // Locking it, adding a second class or naming students are all decisions
      // the solver cannot express and could not put back.
      expect(survivesRegeneration(lessonRow({ isGenerated: true, isLocked: true }))).toBe(true);
      expect(
        survivesRegeneration(lessonRow({ isGenerated: true, extraGroups: [{}] })),
      ).toBe(true);
      expect(
        survivesRegeneration(lessonRow({ isGenerated: true, participants: [{}] })),
      ).toBe(true);
      // …while one nobody has touched is still the machine's to replace.
      expect(survivesRegeneration(lessonRow({ isGenerated: true }))).toBe(false);
    });

    it('preserves locked lessons and manual multi-class constructs', async () => {
      await persist({ status: 'FEASIBLE', lessons: [] });

      const preserved = {
        OR: [
          // Everything the optimizer did not write, whatever it looks like.
          { isGenerated: false },
          { isLocked: true },
          { extraGroups: { some: {} } },
          { participants: { some: {} } },
        ],
      };
      // Machine-owned lessons are replaced; anything a human locked or built
      // by hand is excluded from the delete.
      expect(tx.masterLesson.deleteMany).toHaveBeenCalledWith({
        where: { academicYearId: ACADEMIC_YEAR, NOT: preserved },
      });
      // And what it kept is read back by the same clause, parked lessons and
      // all: the audit counts them, the free-day wishes skip the parked.
      expect(tx.masterLesson.findMany).toHaveBeenCalledWith({
        where: { academicYearId: ACADEMIC_YEAR, ...preserved },
        select: { teacherId: true, coTeacherId: true, dayOfWeek: true, isParked: true },
      });
    });

    it('scopes the delete to the requested academic year only', async () => {
      await persist({ status: 'FEASIBLE', lessons: [] });

      const call = tx.masterLesson.deleteMany.mock.calls[0]![0] as {
        where: { academicYearId: string };
      };
      expect(call.where.academicYearId).toBe(ACADEMIC_YEAR);
    });

    it('takes the dated lessons of the replaced templates with them', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-12T08:00:00.000Z'));
      try {
        await persist({ status: 'FEASIBLE', lessons: [] });
      } finally {
        jest.useRealTimers();
      }

      // Without this the FK sets masterLessonId to null and the rows survive
      // as orphans the publish idempotency set cannot see — the next publish
      // then materializes the same week a second time.
      expect(tx.calendarLesson.deleteMany).toHaveBeenCalledWith({
        where: {
          masterLesson: {
            is: {
              academicYearId: ACADEMIC_YEAR,
              NOT: {
                OR: [
                  { isGenerated: false },
                  { isLocked: true },
                  { extraGroups: { some: {} } },
                  { participants: { some: {} } },
                ],
              },
            },
          },
          status: 'SCHEDULED',
          date: { gte: new Date('2026-08-12T00:00:00.000Z') },
          attendanceRecords: { none: {} },
        },
      });
    });

    it('clears the dated lessons before the templates they hang off', async () => {
      await persist({ status: 'FEASIBLE', lessons: [] });

      // The other order loses them: deleting the template first nulls the
      // link, and the relation filter then matches nothing.
      expect(
        tx.calendarLesson.deleteMany.mock.invocationCallOrder[0]!,
      ).toBeLessThan(tx.masterLesson.deleteMany.mock.invocationCallOrder[0]!);
    });
  });

  /*
   * One wholesale rewrite of a year at a time (regeneration-lock.ts), and no
   * answer written over a draft that changed while the solver ran. Both sit
   * after the INFEASIBLE/TIMEOUT return, so a run with nothing to write waits
   * for nobody, and before the first delete.
   */
  describe('persistMasterLessons — the year lock and a draft that moved', () => {
    beforeEach(() => {
      tx.masterLesson.deleteMany.mockResolvedValue({ count: 0 });
      tx.calendarLesson.deleteMany.mockResolvedValue({ count: 0 });
      tx.masterLesson.count.mockResolvedValue(0);
    });

    it('takes the year lock after the publication lock and before the first delete', async () => {
      await persist({ status: 'FEASIBLE', lessons: [] });

      expect(tx.$executeRaw.mock.calls.map(rawSql)).toEqual([
        "SET LOCAL lock_timeout = '5s'",
        "SELECT pg_advisory_xact_lock(hashtext('grundschema-regenerate'), hashtext(?::uuid::text))",
      ]);
      expect(tx.$executeRaw.mock.calls[1]!.slice(1)).toEqual([ACADEMIC_YEAR]);
      const lockedAt = tx.$executeRaw.mock.invocationCallOrder[1]!;
      // enterGrundschemaWrite is the $queryRaw: publication first, the year second.
      expect(tx.$queryRaw.mock.invocationCallOrder[0]!).toBeLessThan(lockedAt);
      expect(lockedAt).toBeLessThan(tx.calendarLesson.deleteMany.mock.invocationCallOrder[0]!);
    });

    it.each(['INFEASIBLE', 'TIMEOUT'])('waits for nobody when the solver returned %s', async (status) => {
      await persist({ status: status as AiEngineScheduleResponse['status'] });

      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it('answers 409 SCHEDULE_BUSY when another rewrite holds the year past 5 s, and touches nothing', async () => {
      tx.$executeRaw = jest.fn().mockResolvedValueOnce(0).mockRejectedValueOnce(lockTimeout());

      const error = await persist({ status: 'FEASIBLE', lessons: [] }).catch((thrown: unknown) => thrown);

      expect((error as HttpException).getStatus()).toBe(409);
      expect(bodyOf(error)).toMatchObject({ code: 'SCHEDULE_BUSY' });
      expect(tx.calendarLesson.deleteMany).not.toHaveBeenCalled();
      expect(tx.masterLesson.deleteMany).not.toHaveBeenCalled();
      expect(tx.masterLesson.createMany).not.toHaveBeenCalled();
    });

    it('answers a row a hand edit holds past the same 5 s the same way', async () => {
      tx.masterLesson.deleteMany.mockRejectedValue(lockTimeout());

      const error = await persist({ status: 'FEASIBLE', lessons: [] }).catch((thrown: unknown) => thrown);

      expect(bodyOf(error)).toMatchObject({ code: 'SCHEDULE_BUSY' });
    });

    it('reads the draft again under the lock, by the rule the delete uses', async () => {
      await persist({ status: 'FEASIBLE', lessons: [] });

      expect(tx.masterLesson.findMany).toHaveBeenCalledWith({
        where: { academicYearId: ACADEMIC_YEAR, NOT: PRESERVED },
        select: { id: true },
      });
      expect(tx.masterLesson.findMany.mock.invocationCallOrder[0]!).toBeGreaterThan(
        tx.$executeRaw.mock.invocationCallOrder[1]!,
      );
    });

    it('refuses 409 GENERATE_STALE when the draft lost or gained a lesson of its own while the solver ran', async () => {
      // A lesson unlocked by hand during the solve: one more machine-owned
      // lesson than the fetch saw, which this write would delete unseen.
      tx.masterLesson.findMany.mockResolvedValue([{ id: 'b' }, { id: 'c' }, { id: 'a' }]);

      const error = await persist({ status: 'FEASIBLE', lessons: [] }, { draftIds: ['a', 'b'] }).catch(
        (thrown: unknown) => thrown,
      );

      expect((error as HttpException).getStatus()).toBe(409);
      expect(bodyOf(error)).toMatchObject({ code: 'GENERATE_STALE', message: expect.any(String) });
      expect(tx.calendarLesson.deleteMany).not.toHaveBeenCalled();
      expect(tx.masterLesson.deleteMany).not.toHaveBeenCalled();
      expect(tx.masterLesson.createMany).not.toHaveBeenCalled();
      expect(tx.scheduleChangeLog.create).not.toHaveBeenCalled();
    });

    it('writes when the draft is the one the fetch saw, whatever order its rows come in', async () => {
      tx.masterLesson.findMany.mockResolvedValue([{ id: 'b' }, { id: 'a' }]);

      await persist({ status: 'FEASIBLE', lessons: [] }, { draftIds: ['a', 'b'] });

      expect(tx.masterLesson.deleteMany).toHaveBeenCalledTimes(1);
    });

    it('keeps the 502 a mismatched answer has always had, under the lock', async () => {
      await expect(
        persist({ status: 'FEASIBLE', lessons: [placement(), placement()] }, oneRequirement(3)),
      ).rejects.toMatchObject({ status: 502 });
      expect(tx.masterLesson.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('callAiEngine — failure mapping', () => {
    /**
     * Maps a refusal can name something through; empty unless a test fills one.
     *
     * TYPED AS AnonMaps on purpose. Untyped, a map added to the interface was
     * simply missing here — and `deanonymise` iterates the list, so the absent
     * one was `undefined`, the loop threw, and every refusal in this block came
     * back as "AI engine unavailable." Seven tests failed at once and none of
     * them said which field was missing.
     */
    const maps = (): AnonMaps => ({
      requirementAnonMap: new Map<string, string>(),
      roomAnonMap: new Map<string, string>(),
      groupAnonMap: new Map<string, string>(),
      roomTypeAnonMap: new Map<string, string>(),
      constraintAnonMap: new Map<string, string>(),
      workRuleAnonMap: new Map<string, string>(),
      nameById: new Map<string, string>(),
      lessonAnonMap: new Map<string, string>(),
    });

    const call = (payload = {}, anonMaps = maps()) =>
      (
        service as unknown as {
          callAiEngine: (path: string, p: unknown, m: unknown) => Promise<AiEngineScheduleResponse>;
        }
      ).callAiEngine('/v1/schedule', payload, anonMaps);

    it('returns the engine payload on success', async () => {
      http.post.mockReturnValue(
        of({ data: { status: 'OPTIMAL', lessons: [] } }),
      );

      await expect(call()).resolves.toEqual({ status: 'OPTIMAL', lessons: [] });
    });

    it('maps a slow engine to 503 rather than hanging the request', async () => {
      // Emits after the configured 50ms timeout, so the timeout operator wins.
      http.post.mockReturnValue(timer(500).pipe(mergeMap(() => of({ data: {} }))));

      await expect(call()).rejects.toThrow(ServiceUnavailableException);
      await expect(call()).rejects.toThrow('did not respond in time');
    });

    it('says the engine could not be REACHED when nothing answered', async () => {
      /*
       * The ordinary local failure: the engine is a separate service and it is
       * easy to forget to start. An AxiosError with no `response` is a request
       * that never arrived — ECONNREFUSED, or a host that does not resolve.
       *
       * It used to be reported as "The AI engine returned an error" with a 502,
       * which sent whoever read it looking at the engine's own logs. Those are
       * empty, because it was never running.
       */
      const refused = new AxiosError('connect ECONNREFUSED 127.0.0.1:8000');
      refused.code = 'ECONNREFUSED';
      http.post.mockReturnValue(throwError(() => refused));

      await expect(call()).rejects.toThrow(ServiceUnavailableException);
      await expect(call()).rejects.toThrow('could not be reached');
      // And NOT the message that means the engine answered.
      await expect(call()).rejects.not.toThrow('returned an error');
    });

    it('keeps a 500 from the engine a 500, not a 502', async () => {
      // The status is what separates "this request was wrong" from "the engine
      // broke", and flattening both into 502 loses it.
      const broke = new AxiosError('boom');
      broke.response = { status: 500 } as never;
      http.post.mockReturnValue(throwError(() => broke));

      await expect(call()).rejects.toMatchObject({ status: 500 });
    });

    it('propagates the engine status code on an HTTP error', async () => {
      const axiosError = new AxiosError('boom');
      axiosError.response = { status: 422 } as never;
      http.post.mockReturnValue(throwError(() => axiosError));

      await expect(call()).rejects.toThrow(HttpException);
      await expect(call()).rejects.toMatchObject({ status: 422 });
    });

    it('answers 503 and not 502 when the engine never responded', async () => {
      /*
       * This used to assert 502, and 502 was the wrong answer.
       *
       * "Bad Gateway" says the upstream replied with something unusable. An
       * AxiosError carrying no `response` says it replied with nothing at all,
       * which is 503 — and the distinction is the difference between reading
       * the engine's logs and starting the engine.
       */
      http.post.mockReturnValue(throwError(() => new AxiosError('no response')));

      await expect(call()).rejects.toMatchObject({ status: 503 });
      await expect(call()).rejects.toThrow('could not be reached');
    });

    it('forwards the engine\'s own sentence on a 4xx', async () => {
      /*
       * Every named refusal the engine can produce arrived here and was
       * replaced by "The AI engine returned an error." — which is what the
       * generate page then rendered. The messages exist and name the
       * requirement, the group and the day; they were thrown away one layer
       * below the screen that shows them.
       */
      const refused = new AxiosError('boom');
      refused.response = {
        status: 400,
        data: {
          code: 'INVALID_SCHEDULE_INPUT',
          message:
            'An availability rule leaves student group 7A no 30-minute lunch break on day 1.',
        },
      } as never;
      http.post.mockReturnValue(throwError(() => refused));

      await expect(call()).rejects.toThrow('no 30-minute lunch break on day 1');
      await expect(call()).rejects.toMatchObject({ status: 400 });
    });

    it('turns an anonymous id in a refusal back into the real one', async () => {
      /*
       * Every named refusal the engine can produce carries an id the engine
       * minted. Forwarded verbatim it is a uuid that exists in no table, which
       * is the state the conflict MESSAGES are still in — the school reads a
       * precise sentence about something it cannot look up.
       *
       * A substitution, not a second implementation of the rule: rebuilding the
       * lock resolution here to phrase a nicer sentence would be two
       * implementations of one meaning, and the one that drifts is the one
       * nobody runs.
       */
      const anonRequirement = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
      const realRequirement = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
      const refused = new AxiosError('boom');
      refused.response = {
        status: 400,
        data: {
          code: 'INVALID_SCHEDULE_INPUT',
          message: `A room lock leaves requirement ${anonRequirement} nowhere to go.`,
        },
      } as never;
      http.post.mockReturnValue(throwError(() => refused));

      await expect(
        call({}, { ...maps(), requirementAnonMap: new Map([[realRequirement, anonRequirement]]) }),
      ).rejects.toThrow(realRequirement);
    });

    it('translates a room type, which is the part of that sentence a school reads', async () => {
      /*
       * "No room satisfies capacity/type/years for requirement X (…, required
       * type Y, …)" names an anonymised TYPE. Leaving it out left the one piece
       * of that sentence an administrator would actually go and look up as a
       * uuid belonging to nothing.
       */
      const anonType = 'dddddddd-4444-4444-8444-dddddddddddd';
      const realType = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
      const refused = new AxiosError('boom');
      refused.response = {
        status: 400,
        data: { code: 'X', message: `… required type ${anonType}, years 4-4).` },
      } as never;
      http.post.mockReturnValue(throwError(() => refused));

      await expect(
        call({}, { ...maps(), roomTypeAnonMap: new Map([[realType, anonType]]) }),
      ).rejects.toThrow(realType);
    });

    it('turns a lesson id in a room-optimisation refusal back into the real one', async () => {
      // The room route names placed lessons, not requirements; the same
      // translation has to reach them or the refusal names a row in no table.
      const anonLesson = 'aaaaaaaa-6666-4666-8666-aaaaaaaaaaaa';
      const realLesson = 'bbbbbbbb-7777-4777-8777-bbbbbbbbbbbb';
      const refused = new AxiosError('boom');
      refused.response = {
        status: 422,
        data: { code: 'X', message: `Lesson ${anonLesson} names a room not in rooms.` },
      } as never;
      http.post.mockReturnValue(throwError(() => refused));

      await expect(
        call({}, { ...maps(), lessonAnonMap: new Map([[realLesson, anonLesson]]) }),
      ).rejects.toThrow(realLesson);
    });

    it('leaves a uuid it has no mapping for exactly as it was', async () => {
      // Half a translation would be worse than none: an id that looks real and
      // resolves to nothing sends somebody searching.
      const stranger = 'cccccccc-3333-4333-8333-cccccccccccc';
      const refused = new AxiosError('boom');
      refused.response = {
        status: 400,
        data: { code: 'X', message: `Requirement ${stranger} is impossible.` },
      } as never;
      http.post.mockReturnValue(throwError(() => refused));

      await expect(call()).rejects.toThrow(stranger);
    });

    it('keeps the generic sentence for a 5xx, whatever the body says', async () => {
      // An internal failure's detail is ours to read in the logs. Forwarding it
      // would put the engine's stack-trace text in a school's toast.
      const broke = new AxiosError('boom');
      broke.response = {
        status: 500,
        data: { code: 'SOLVER_BUILD_ERROR', message: 'CP-SAT rejected the model: ...' },
      } as never;
      http.post.mockReturnValue(throwError(() => broke));

      await expect(call()).rejects.toThrow('The AI engine returned an error.');
      await expect(call()).rejects.not.toThrow('CP-SAT');
    });

    it('falls back to the generic sentence when the body carries no message', async () => {
      // A proxy or a load balancer can answer 4xx with HTML, or nothing.
      const odd = new AxiosError('boom');
      odd.response = { status: 413, data: '<html>too large</html>' } as never;
      http.post.mockReturnValue(throwError(() => odd));

      await expect(call()).rejects.toThrow('The AI engine returned an error.');
      await expect(call()).rejects.toMatchObject({ status: 413 });
    });

    it('maps an unrecognised transport failure to 503', async () => {
      http.post.mockReturnValue(throwError(() => new Error('socket closed')));

      await expect(call()).rejects.toThrow(ServiceUnavailableException);
      // Not "could not be reached": that sentence is a claim about the
      // connection, and nothing here says the connection was the problem.
      await expect(call()).rejects.toThrow('AI engine unavailable.');
    });

    it('answers 503 when the request fails before it is even sent', async () => {
      http.post.mockImplementation(() => {
        throw new TypeError('the payload could not be serialised');
      });

      await expect(call()).rejects.toThrow(ServiceUnavailableException);
      await expect(call()).rejects.toThrow('AI engine unavailable.');
    });

    it('carries the refusal’s own name and values beside its sentence, their ids turned back', async () => {
      /*
       * The screen says in Swedish what the engine said in English, and needs
       * the refusal's code and values for it. A value naming a group is the
       * engine's anonymous id until it is turned back, and then the school's
       * own name for the group.
       */
      const anonGroup = 'aaaaaaaa-8888-4888-8888-aaaaaaaaaaaa';
      const realGroup = 'bbbbbbbb-9999-4999-8999-bbbbbbbbbbbb';
      const refused = new AxiosError('boom');
      refused.response = {
        status: 400,
        data: {
          message: `Locked lessons leave student group ${anonGroup} no lunch break.`,
          details: {
            code: 'LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK',
            params: { group: anonGroup, minutes: 30 },
          },
        },
      } as never;
      http.post.mockReturnValue(throwError(() => refused));

      const error = await call({}, {
        ...maps(),
        groupAnonMap: new Map([[realGroup, anonGroup]]),
        nameById: new Map([[realGroup, '4A']]),
      }).catch((thrown: unknown) => thrown);

      expect((error as HttpException).getStatus()).toBe(400);
      expect((error as HttpException).getResponse()).toEqual({
        message: `Locked lessons leave student group ${realGroup} no lunch break.`,
        code: 'LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK',
        params: { group: '4A', minutes: 30 },
      });
    });

    describe('in a tioårig läsår (SFS 2025:729)', () => {
      /*
       * The payload states every class span in the nioårig numbering the
       * frames, raster and salar are stated in, so a refusal that echoes a
       * timplanspost's span in `grades` echoes it one down. The school reads
       * its own classes: 10A's row is "åk 10", not the 9 the engine compared.
       */
      const refusal = (code: string, params: Record<string, string | number>) => {
        const refused = new AxiosError('boom');
        refused.response = {
          status: 400,
          data: { message: 'The engine’s own sentence.', details: { code, params } },
        } as never;
        return refused;
      };
      const paramsOf = async (anonMaps: AnonMaps) =>
        ((await call({}, anonMaps).catch((thrown: unknown) => thrown)) as HttpException).getResponse() as {
          code?: string;
          params?: Record<string, string | number>;
        };

      it('names a timplanspost’s span back in the läsår’s own numbering, its ids turned back too', async () => {
        const anonRequirement = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
        const realRequirement = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
        http.post.mockReturnValue(
          throwError(() =>
            refusal('FRAME_NO_WINDOW_FOR_REQUIREMENT', {
              requirement: anonRequirement,
              grades: '7–9',
              minutes: 60,
              remaining: 40,
            }),
          ),
        );

        const response = await paramsOf({
          ...maps(),
          gradeNumbering: 'TIOARIG',
          requirementAnonMap: new Map([[realRequirement, anonRequirement]]),
        });

        expect(response).toMatchObject({
          code: 'FRAME_NO_WINDOW_FOR_REQUIREMENT',
          params: { requirement: realRequirement, grades: '8–10', minutes: 60, remaining: 40 },
        });
      });

      it('leaves a lunch serving’s span as the school stated it', async () => {
        // A sitting's "7–9" is the school's own nioårig row, never a class's.
        http.post.mockReturnValue(
          throwError(() => refusal('LUNCH_SERVING_CANNOT_FEED_STAGE', { grades: '7–9', seats: 60 })),
        );

        expect((await paramsOf({ ...maps(), gradeNumbering: 'TIOARIG' })).params).toEqual({
          grades: '7–9',
          seats: 60,
        });
      });

      it.each<[string, GradeNumbering | undefined]>([
        ['a nioårig läsår', 'NIOARIG'],
        ['a läsår whose numbering nobody passed', undefined],
      ])('leaves %s’s span as the engine said it', async (_label, gradeNumbering) => {
        http.post.mockReturnValue(
          throwError(() => refusal('ROOM_NONE_ELIGIBLE_FOR_REQUIREMENT', { grades: '7–9', roomType: 'any' })),
        );

        expect((await paramsOf({ ...maps(), gradeNumbering })).params).toEqual({
          grades: '7–9',
          roomType: 'any',
        });
      });

      it.each<[string, Record<string, string | number>]>([
        // The rest of CLASS_SPAN_CODES, each with the params scheduler_solver.py
        // raises it with: FRAME_NO_WINDOW is above, ROOM_NONE_ELIGIBLE through
        // the run below. Every one echoes a timplanspost's or a class's span.
        [
          'MARGIN_NO_WINDOW_FOR_REQUIREMENT',
          { grades: '7–9', minutes: 60, before: 10, after: 0, changeover: 5, remaining: 55 },
        ],
        ['RAST_NO_STRETCH_FOR_REQUIREMENT', { grades: '7–9', minutes: 60, remaining: 40, framed: 1 }],
        [
          'RAST_MARGIN_NO_STRETCH_FOR_REQUIREMENT',
          { grades: '7–9', minutes: 90, before: 10, after: 0, changeover: 0, remaining: 80, framed: 1 },
        ],
        ['LESSON_NO_START_FOR_REQUIREMENT', { grades: '7–9', minutes: 60 }],
        ['ROOM_LOCK_LEAVES_NO_ROOM', { grades: '7–9' }],
        [
          'RAST_DEMANDS_A_LESSON_THAT_CANNOT_FIT',
          { day: 1, grades: '7–9', rast: '09:40', opens: '08:00', remaining: 40, minutes: 60, bound: 'closed' },
        ],
      ])('names %s’s class span back too, and nothing else of it', async (code, params) => {
        http.post.mockReturnValue(throwError(() => refusal(code, params)));

        expect((await paramsOf({ ...maps(), gradeNumbering: 'TIOARIG' })).params).toEqual({
          ...params,
          grades: '8–10',
        });
      });

      it('names every tioårig årskurs back as the class it was sent for, twelve as “and above”', () => {
        /*
         * yearGrades is the payload's toNioarig run backwards: åk 1 went as
         * förskoleklassen's 0, specialskolans 11 as 10, and 12 as the 12 the
         * bounds have always run to. Each comes back as the class it was.
         */
        for (let grade = 1; grade <= 12; grade++) {
          const sent = String(toNioarig(grade, 'TIOARIG'));

          expect(yearGrades('ROOM_LOCK_LEAVES_NO_ROOM', { grades: sent }, { gradeNumbering: 'TIOARIG' })).toEqual({
            grades: String(grade),
          });
        }
        expect(
          yearGrades('FRAME_NO_WINDOW_FOR_REQUIREMENT', { grades: '9–12' }, { gradeNumbering: 'TIOARIG' }),
        ).toEqual({ grades: '10–12' });
      });

      it.each(['any', ''])('leaves a span the engine could not state (%j) as it said it', (grades) => {
        // "any" for a timplanspost whose classes have no year, "" for a group
        // or a reservation without one (_grade_span_text): no årskurs to name.
        expect(
          yearGrades('FRAME_NO_WINDOW_FOR_REQUIREMENT', { grades, minutes: 60 }, { gradeNumbering: 'TIOARIG' }),
        ).toEqual({ grades, minutes: 60 });
      });

      /** A reservation's params, as _constraint_params writes them. */
      const reservation = (kind: string, date: string) => ({
        constraint: 'c-1',
        kind,
        resource: '',
        grades: '7–9',
        day: date === '' ? 1 : 0,
        date,
        start: '08:00',
        end: '09:07',
        slotMinutes: 5,
      });
      /** 2028/29 tioårig, every other day nioårig. */
      const numberingOnDay = (day: string): GradeNumbering =>
        day >= '2028-07-01' && day <= '2029-06-30' ? 'TIOARIG' : 'NIOARIG';

      it('names a dated årskursregel’s span back in its own day’s läsår', async () => {
        // A prao for 8–10 on a day of the tioårig läsår was sent as 7–9; the
        // refusal about its off-grid time names the row the admin wrote.
        http.post.mockReturnValue(
          throwError(() =>
            refusal('INPUT_CONSTRAINT_TIME_OFF_GRID', reservation('GRADE_LEVEL', '2029-03-12')),
          ),
        );

        expect(
          (await paramsOf({ ...maps(), gradeNumbering: 'TIOARIG', numberingOnDay })).params,
        ).toMatchObject({ kind: 'GRADE_LEVEL', date: '2029-03-12', grades: '8–10' });
      });

      it.each<[string, Record<string, string | number>]>([
        ['a weekly årskursregel’s', reservation('GRADE_LEVEL', '')],
        ['a dated årskursregel’s from a nioårig läsår', reservation('GRADE_LEVEL', '2028-03-13')],
        ['a teacher’s reservation’s', reservation('TEACHER', '2029-03-12')],
      ])('leaves %s span as the school stated it', async (_label, params) => {
        http.post.mockReturnValue(throwError(() => refusal('INPUT_CONSTRAINT_TIME_OFF_GRID', params)));

        expect(
          (await paramsOf({ ...maps(), gradeNumbering: 'TIOARIG', numberingOnDay })).params,
        ).toMatchObject({ grades: '7–9' });
      });
    });

    it('carries no code when the refusal’s details name none', async () => {
      // Without a name there is nothing to translate, and a code of undefined
      // would read to the screen as a sentence it has no words for.
      const refused = new AxiosError('boom');
      refused.response = {
        status: 400,
        data: { message: 'No lunch break fits.', details: { params: { minutes: 30 } } },
      } as never;
      http.post.mockReturnValue(throwError(() => refused));

      const error = await call().catch((thrown: unknown) => thrown);

      expect((error as HttpException).getResponse()).toEqual({ message: 'No lunch break fits.' });
    });

    describe('a pre-flight about a post’s days', () => {
      const anonPost = 'aaaaaaaa-9999-4999-8999-aaaaaaaaaaaa';
      const realPost = 'bbbbbbbb-9999-4999-8999-bbbbbbbbbbbb';
      const teacher = 'cccccccc-9999-4999-8999-cccccccccccc';
      const refuse = (limit: string) => {
        const refused = new AxiosError('boom');
        refused.response = {
          status: 400,
          data: {
            message: `The teacher's post ${limit} allows teaching on at most 3 days a week …`,
            details: {
              code: 'TEACHER_WORK_DAYS_TOO_FEW_FOR_WEEK',
              params: { limit, days: 3, weekMinutes: 1500 },
            },
          },
        } as never;
        http.post.mockReturnValue(throwError(() => refused));
      };
      const withPost = (): AnonMaps => ({
        ...maps(),
        dayLimitAnonMap: new Map([[realPost, anonPost]]),
        dayLimitTeacherIds: new Map([[realPost, teacher]]),
      });

      it('is thrown without its figure, the post turned back, and its teacher off the body', async () => {
        refuse(anonPost);

        const error = await call({}, withPost()).catch((thrown: unknown) => thrown);

        expect(error).toBeInstanceOf(WorkDaysRefusal);
        expect((error as WorkDaysRefusal).getStatus()).toBe(400);
        expect((error as WorkDaysRefusal).getResponse()).toEqual({
          message: WORK_DAYS_HIDDEN_MESSAGE,
          code: 'TEACHER_WORK_DAYS_TOO_FEW_FOR_WEEK',
          params: { limit: realPost, weekMinutes: 1500 },
        });
        expect((error as WorkDaysRefusal).subjectIds).toEqual([teacher]);
        expect(JSON.stringify((error as WorkDaysRefusal).getResponse())).not.toMatch(new RegExp(`${teacher}|3 days`));
      });

      it('keeps no teacher when it names a post the run did not send', async () => {
        refuse('dddddddd-9999-4999-8999-dddddddddddd');

        const error = await call({}, withPost()).catch((thrown: unknown) => thrown);

        expect((error as WorkDaysRefusal).subjectIds).toEqual([]);
      });

      it('turns the post back in any other sentence that names it', async () => {
        const refused = new AxiosError('boom');
        refused.response = {
          status: 400,
          data: { message: `Post ${anonPost} is named.`, details: { code: 'X', params: {} } },
        } as never;
        http.post.mockReturnValue(throwError(() => refused));

        const error = await call({}, withPost()).catch((thrown: unknown) => thrown);

        expect(error).not.toBeInstanceOf(WorkDaysRefusal);
        expect((error as HttpException).getResponse()).toEqual({ message: `Post ${realPost} is named.`, code: 'X', params: {} });
      });
    });

    /** A call with options, as a schemaförslag run makes it. */
    const callWith = (payload: object, options?: { timeoutMs?: number }) =>
      (
        service as unknown as {
          callAiEngine: (path: string, p: unknown, m: unknown, o?: unknown) => Promise<unknown>;
        }
      ).callAiEngine('/v1/schedule', payload, maps(), options);

    it('waits as long as the call says, past the configured timeout, and tells axios so too', async () => {
      // The configured timeout is 50 ms; this answer takes 120.
      http.post.mockReturnValue(timer(120).pipe(mergeMap(() => of({ data: { status: 'OPTIMAL', lessons: [] } }))));

      await expect(callWith({}, { timeoutMs: 2000 })).resolves.toEqual({ status: 'OPTIMAL', lessons: [] });
      // The module's axios timeout would cut the call off at the default
      // first; the call's own replaces it for this request only.
      expect(http.post.mock.calls[0][2]).toMatchObject({ timeout: 2000 });
    });

    it('gives up at the call’s own deadline', async () => {
      http.post.mockReturnValue(timer(500).pipe(mergeMap(() => of({ data: {} }))));

      await expect(callWith({}, { timeoutMs: 20 })).rejects.toThrow('did not respond in time');
    });

    it('sets no timeout of its own when the call names none: Generera waits as it always has', async () => {
      http.post.mockReturnValue(of({ data: { status: 'OPTIMAL', lessons: [] } }));

      await callWith({});

      expect(Object.keys(http.post.mock.calls[0][2] as object)).toEqual(['headers']);
    });

    /** The engine's refusal of a field its models do not know. */
    const extraForbidden = (loc: string[]) => {
      const refused = new AxiosError('boom');
      refused.response = {
        status: 422,
        data: {
          code: 'VALIDATION_ERROR',
          message: 'Request payload failed schema validation.',
          details: { errors: [{ type: 'extra_forbidden', loc, msg: 'Extra inputs are not permitted' }] },
        },
      } as never;
      return refused;
    };

    it('says an engine older than `search` is one, when the request carried it', async () => {
      http.post.mockReturnValue(throwError(() => extraForbidden(['body', 'search'])));

      const error = await callWith({ search: { seed: 1 } }).catch((thrown: unknown) => thrown);

      expect((error as HttpException).getStatus()).toBe(503);
      expect(bodyOf(error)).toEqual({ message: expect.any(String), code: 'ENGINE_LACKS_CANDIDATES' });
    });

    it('leaves the same refusal of a request without `search` the validation error it is', async () => {
      http.post.mockReturnValue(throwError(() => extraForbidden(['body', 'search'])));

      const error = await callWith({}).catch((thrown: unknown) => thrown);

      expect((error as HttpException).getStatus()).toBe(422);
      expect(bodyOf(error)).not.toHaveProperty('code', 'ENGINE_LACKS_CANDIDATES');
    });

    it('reads only `search` itself as missing: a field refused inside it is this gateway’s mistake', async () => {
      http.post.mockReturnValue(throwError(() => extraForbidden(['body', 'search', 'beam'])));

      const error = await callWith({ search: { seed: 1 } }).catch((thrown: unknown) => thrown);

      expect((error as HttpException).getStatus()).toBe(422);
    });

    it('never leaks the API key in the thrown error', async () => {
      http.post.mockReturnValue(throwError(() => new Error('kkkk')));

      await expect(call()).rejects.not.toThrow(/k{32}/);
    });
  });

  describe('triggerScheduling — PII-stripping pipeline', () => {
    const REQ_ID = '11111111-aaaa-4aaa-8aaa-111111111111';
    const SUBJECT_ID = '22222222-aaaa-4aaa-8aaa-222222222222';
    const GROUP_ID = '33333333-aaaa-4aaa-8aaa-333333333333';
    const TEACHER_ID = '44444444-aaaa-4aaa-8aaa-444444444444';
    const ROOM_ID = '55555555-aaaa-4aaa-8aaa-555555555555';
    const EXTRA_GROUP_ID = '66666666-aaaa-4aaa-8aaa-666666666666';

    const eightAm = new Date('1970-01-01T08:00:00.000Z');
    const nineAm = new Date('1970-01-01T09:00:00.000Z');

    let prisma: PrismaMock;

    beforeEach(() => {
      prisma = createPrismaMock(tx);
      service = new OptimizationProxyService(
        prisma as unknown as PrismaService,
        http as unknown as HttpService,
        makeConfigService(),
      );
    });

    const requirement = (overrides: Record<string, unknown> = {}) => ({
      id: REQ_ID,
      subjectId: SUBJECT_ID,
      studentGroupId: GROUP_ID,
      teacherId: TEACHER_ID,
      coTeacherId: null,
      lessonsPerWeek: 3,
      minutesPerLesson: 60,
      // As the column defaults: a uniform row, whose list is empty. Spelled
      // out because the database answers '{}' for it, and a uniform entry
      // must still leave without the key.
      lessonLengths: [],
      // As the columns default: no ombyte and no dusch. Spelled out for the same
      // reason as the two below — the database cannot produce a row without
      // them, and the map forwards them rather than defaulting them.
      minutesBefore: 0,
      minutesAfter: 0,
      // As the columns default: every week, all year. Spelled out because a row
      // that omits them is not a row the database can produce, and both the
      // subtraction and the lessons the run writes read them.
      recurrence: 'ALL_WEEKS',
      startDate: null,
      endDate: null,
      subject: { requiredRoomTypeId: 'room-type-lab' },
      ...overrides,
    });

    const lockedLesson = (overrides: Record<string, unknown> = {}) => ({
      id: 'locked-1',
      subjectId: SUBJECT_ID,
      studentGroupId: GROUP_ID,
      teacherId: TEACHER_ID,
      coTeacherId: null,
      roomId: ROOM_ID,
      dayOfWeek: 2,
      startTime: eightAm,
      endTime: nineAm,
      // As the column defaults: every week, no period. Spelled out because a
      // row that omits them is not a row the database can produce, and the
      // subtraction below reads them.
      recurrence: 'ALL_WEEKS',
      startDate: null,
      endDate: null,
      extraGroups: [],
      ...overrides,
    });

    const constraintRow = (overrides: Record<string, unknown> = {}) => ({
      id: 'constraint-real-id',
      resourceType: 'TEACHER',
      userId: null,
      roomId: null,
      studentGroupId: null,
      minGradeLevel: null,
      maxGradeLevel: null,
      dayOfWeek: 1,
      date: null,
      startTime: eightAm,
      endTime: nineAm,
      type: 'UNAVAILABLE',
      ...overrides,
    });

    type Arrangement = {
      requirements?: unknown[];
      /** Rows of { id, studentGroupId }: students whose HOME class is the group. */
      homeMembers?: unknown[];
      /** Rows of { studentId, studentGroupId }: teaching-group memberships. */
      teachingMembers?: unknown[];
      lockedLessons?: unknown[];
      unlockedLessons?: unknown[];
      /**
       * The preserved lessons as persistMasterLessons finds them after its
       * delete, when the timetable was edited while the solver ran. By
       * default `lockedLessons`, as the fetch read them.
       */
      keptAfterSolve?: unknown[];
      rooms?: unknown[];
      constraints?: unknown[];
      /**
       * Rows of { id, gradeLevel, kind }. The year each group belongs to, and
       * whether it is a home class — only a CLASS is sent to the engine as a
       * group that eats.
       */
      groups?: unknown[];
      /** Soft room wishes, as stored. */
      roomPreferences?: unknown[];
      /** The school's saved lunch rules, or null when nobody has defined them. */
      lunchSettings?: unknown;
      /** Ramtider, lunch servings and raster, as stored. */
      frames?: unknown[];
      servings?: unknown[];
      rasts?: unknown[];
      /** Meals the school placed by hand. */
      handSittings?: unknown[];
      /** Lärarnas arbetstid, as stored. */
      workRules?: unknown[];
      /** The year's posts (TeacherEmployments), as stored: { id, userId, maxTeachingDaysPerWeek }. */
      posts?: unknown[];
      /** The draft's own (non-preserved) masters, as the draft read selects them. */
      draftLessons?: unknown[];
    };

    const arrange = (overrides: Arrangement = {}) => {
      // Every read below answers as Prisma would — see `table` — so a field
      // the service stops selecting is a field the payload loses.
      tx.teachingRequirement.findMany.mockImplementation(
        table(overrides.requirements ?? [requirement()]),
      );
      // Group sizes and the group-conflict relation both derive from the two
      // membership queries: home-class students and teaching-group rows. They
      // answer for the groups and pupils each query names; who counts as an
      // active pupil is room-eligibility.spec.ts's to prove.
      const homeMembers = (overrides.homeMembers ??
        Array.from({ length: 24 }, (_, i) => ({
          id: `00000000-0000-4000-8000-9000000000${String(i).padStart(2, '0')}`,
          studentGroupId: GROUP_ID,
        }))) as Row[];
      const teachingMembers = (overrides.teachingMembers ?? []) as Row[];
      tx.user.findMany.mockImplementation(async ({ where = {}, select }: Query = {}) => {
        assertSelects(select);
        return homeMembers
          .filter(
            (row) =>
              within(row['studentGroupId'], where['studentGroupId']) &&
              within(row['id'], where['id']),
          )
          .map((row) => selected(row, select));
      });
      tx.studentGroupMember.findMany.mockImplementation(
        async ({ where = {}, select }: Query = {}) => {
          assertSelects(select);
          return teachingMembers
            .filter((row) => within(row['studentGroupId'], where['studentGroupId']))
            .map((row) => selected(row, select));
        },
      );
      const locked = (overrides.lockedLessons ?? []) as Row[];
      const unlocked = (overrides.unlockedLessons ?? []) as Row[];
      const draft = (overrides.draftLessons ?? []) as Row[];
      // Nobody edits the timetable during the solve unless a test says so.
      const kept = (overrides.keptAfterSolve ?? locked) as Row[];
      // fetchAndAnonymize queries masterLesson twice: the locked/manual set
      // (where.OR, unparked) and the previous unlocked placements
      // (where.isLocked=false). The prepare step and the persist read the
      // draft's own lessons (where.NOT the preserved rule) once each: in the
      // fetch, and again under the lock. The shared write reads the kept set
      // once more, after its delete (where.OR, parked or not).
      tx.masterLesson.findMany.mockImplementation(async ({ where, select }: Query = {}) => {
        assertSelects(select);
        const rows = where?.['NOT'] ? draft : where?.['isLocked'] === false ? unlocked : where?.['isParked'] === false ? locked : kept;
        return rows.map((row) => selected(row, select));
      });
      tx.room.findMany.mockImplementation(
        table(overrides.rooms ?? [{ id: ROOM_ID, capacity: 30, type: 'CLASSROOM' }]),
      );
      tx.availabilityConstraint.findMany.mockImplementation(table(overrides.constraints ?? []));
      // Year spans for rooms limited to a stage are derived from these.
      // The default is the one class the default requirement belongs to, so a
      // payload built with no overrides still names somebody who eats.
      tx.studentGroup.findMany.mockImplementation(
        table(overrides.groups ?? [{ id: GROUP_ID, gradeLevel: null, kind: 'CLASS' }]),
      );
      tx.roomPreference.findMany.mockImplementation(table(overrides.roomPreferences ?? []));
      tx.frameTime.findMany.mockImplementation(table(overrides.frames ?? []));
      tx.lunchServing.findMany.mockImplementation(table(overrides.servings ?? []));
      tx.rast.findMany.mockImplementation(table(overrides.rasts ?? []));
      tx.lunchSitting.findMany.mockImplementation(table(overrides.handSittings ?? []));
      // Empty by default, which is every school today: nobody has been able to
      // state a teacher's lunch or rest, so no week may change until they do.
      tx.teacherWorkRule.findMany.mockImplementation(table(overrides.workRules ?? []));
      // And no post limits its days, which is every school until a decider
      // sets one (20261123090000).
      tx.teacherEmployment.findMany.mockImplementation(table(overrides.posts ?? []));
      // One row per school, found by the school: a findUnique without that
      // key is one Prisma refuses.
      tx.lunchSetting.findUnique.mockImplementation(async ({ where, select }: Query = {}) => {
        if (typeof where?.['schoolId'] !== 'string') {
          throw new Error('findUnique needs a unique where');
        }
        assertSelects(select);
        const settings = (overrides.lunchSettings ?? null) as Row | null;
        return settings !== null && where['schoolId'] === THIS_SCHOOL
          ? selected(settings, select)
          : null;
      });
      tx.masterLesson.deleteMany.mockResolvedValue({ count: 2 });
      tx.calendarLesson.deleteMany.mockResolvedValue({ count: 4 });
      tx.masterLesson.count.mockResolvedValue(1);
      tx.masterLesson.createMany.mockResolvedValue({ count: 0 });
      tx.scheduleChangeLog.create.mockResolvedValue({});
    };

    /**
     * Engine echo: places every forwarded requirement in the first room, as
     * many times a week as it asked for. The count is part of the contract —
     * the engine creates one decision variable per lesson-per-week and emits
     * all of them — and a response carrying any other number is refused.
     */
    const echoEngine = (
      status: AiEngineScheduleResponse['status'] = 'OPTIMAL',
    ) => {
      http.post.mockImplementation((_url: string, payload: any) =>
        of({
          data: {
            requestId: payload.requestId,
            status,
            lessons: payload.requirements.flatMap((r: any) =>
              Array.from({ length: r.lessonsPerWeek }, () => ({
                requirementId: r.id,
                roomId: payload.rooms[0]?.id ?? null,
                dayOfWeek: 1,
                startTime: '08:00:00',
                endTime: '09:15:00',
              })),
            ),
            conflicts: null,
          },
        }),
      );
    };

    const postedPayload = (): AiEngineScheduleRequest =>
      http.post.mock.calls[0][1] as AiEngineScheduleRequest;

    /** What the service tells whoever reads its log, silenced and recorded. */
    const warnings = () =>
      jest
        .spyOn((service as unknown as { logger: Logger }).logger, 'warn')
        .mockImplementation(() => undefined);

    /** An engine that finds no timetable, and says why in `conflicts`. */
    const answerWithConflicts = (conflicts: (payload: any) => object) =>
      http.post.mockImplementation((_url: string, payload: any) =>
        of({
          data: {
            requestId: payload.requestId,
            status: 'INFEASIBLE',
            lessons: [],
            conflicts: conflicts(payload),
          },
        }),
      );

    it('reads a requirement’s room needs through the derivation the room optimisation shares', async () => {
      /*
       * The room optimisation may only move a lesson into a room this run
       * could have given it, and that holds only while both read group size,
       * years and room type through one function. A copy inlined here would
       * pass every other test in this file and drift the first time either
       * side is fixed.
       */
      const needs = jest.spyOn(eligibility, 'roomNeedsOf');
      try {
        arrange();
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        expect(needs).toHaveBeenCalledWith(
          expect.anything(),
          { groupIds: [GROUP_ID] },
          expect.anything(),
          'NIOARIG',
        );
        expect(postedPayload().requirements[0].studentGroupSize).toBe(
          needs.mock.results[0]!.value.studentGroupSize,
        );
      } finally {
        needs.mockRestore();
      }
    });

    it('sends a meal the school placed as a pin, under the class\u2019s anonymous id', async () => {
      /*
       * Only the rows the school wrote, and only as a start: the engine pins the
       * lunch variable it builds anyway. The id is the same anonymous id the
       * class carries in \`groups\` — a pin under any other id would have no
       * variable to pin, and a pin under the real one would be a real id
       * reaching the engine.
       */
      arrange({
        handSittings: [
          {
            studentGroupId: GROUP_ID,
            dayOfWeek: 2,
            startTime: new Date('1970-01-01T13:00:00.000Z'),
            isGenerated: false,
          },
          // A meal for a class this week's payload does not carry: there is no
          // lunch variable to pin it to, so it is not sent at all.
          {
            studentGroupId: '99999999-9999-4999-8999-999999999999',
            dayOfWeek: 3,
            startTime: new Date('1970-01-01T12:00:00.000Z'),
            isGenerated: false,
          },
        ],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      const { lunchPlacements, groups } = postedPayload();
      expect(lunchPlacements).toHaveLength(1);
      expect(lunchPlacements[0]).toMatchObject({ dayOfWeek: 2, startTime: '13:00:00' });
      expect(lunchPlacements[0].studentGroupId).not.toBe(GROUP_ID);
      expect(groups.map((group) => group.id)).toContain(lunchPlacements[0].studentGroupId);
      expect(tx.lunchSitting.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ isGenerated: false }) }),
      );
    });

    it('sends each rast as the engine reads it, lesson-before rule included and never its name', async () => {
      /*
       * The engine's Rast forbids unknown fields and wants HH:MM:SS, while
       * Prisma hands a TIME back as a 1970 Date. requiresLessonBefore has to
       * ride along as stored: dropped, the engine's default of false quietly
       * switches off a rule the school turned on, and nothing says so. The two
       * rows carry opposite values, so no constant passes for the mapping.
       *
       * The name stays behind — the engine only subtracts minutes, and a name
       * is one more thing that could identify a school in a payload built to be
       * anonymous. The rows carry one anyway, as they would the day somebody
       * widens the select, so the mapping has to leave it behind on its own.
       */
      arrange();
      tx.rast.findMany.mockResolvedValue([
        {
          name: 'Förmiddagsrast',
          minGradeLevel: 4,
          maxGradeLevel: 6,
          dayOfWeek: null,
          startTime: new Date('1970-01-01T09:40:00.000Z'),
          endTime: new Date('1970-01-01T10:00:00.000Z'),
          requiresLessonBefore: true,
        },
        {
          name: 'Fredagsrast',
          minGradeLevel: 7,
          maxGradeLevel: 9,
          dayOfWeek: 5,
          startTime: new Date('1970-01-01T13:30:00.000Z'),
          endTime: new Date('1970-01-01T13:45:00.000Z'),
          requiresLessonBefore: false,
        },
      ]);
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(postedPayload().rasts).toEqual([
        {
          minGradeLevel: 4,
          maxGradeLevel: 6,
          dayOfWeek: null,
          startTime: '09:40:00',
          endTime: '10:00:00',
          requiresLessonBefore: true,
        },
        {
          minGradeLevel: 7,
          maxGradeLevel: 9,
          dayOfWeek: 5,
          startTime: '13:30:00',
          endTime: '13:45:00',
          requiresLessonBefore: false,
        },
      ]);
      // Through the year's school, as the frames and the sittings are read, so
      // a request naming another school's year cannot pull this school's rows.
      const [query] = tx.rast.findMany.mock.calls[0];
      expect(query.where).toEqual({
        school: { academicYears: { some: { id: ACADEMIC_YEAR } } },
      });
      expect(query.select).not.toHaveProperty('name');
    });

    // -----------------------------------------------------------------------
    // Sittningarna, on their way back
    // -----------------------------------------------------------------------

    /** Engine echo that also answers with a sitting for every group it saw. */
    const echoWithLunches = () => {
      http.post.mockImplementation((_url: string, payload: any) =>
        of({
          data: {
            requestId: payload.requestId,
            status: 'OPTIMAL',
            lessons: payload.requirements.flatMap((r: any) =>
              Array.from({ length: r.lessonsPerWeek }, () => ({
                requirementId: r.id,
                roomId: payload.rooms[0]?.id ?? null,
                dayOfWeek: 1,
                startTime: '08:00:00',
                endTime: '09:15:00',
              })),
            ),
            lunches: payload.groups.map((g: any) => ({
              studentGroupId: g.id,
              dayOfWeek: 1,
              startTime: '11:30:00',
              endTime: '12:00:00',
            })),
            conflicts: null,
          },
        }),
      );
    };

    it('hands the sittings back with real group ids, not anonymous ones', async () => {
      /*
       * The engine only ever sees re-keyed ids, so a caller given the raw reply
       * would get a uuid that exists in no table — the same unactionable shape
       * the engine's conflict messages still have. The assertion is on the
       * exact id, because "contains a uuid" would pass for the anonymous one.
       */
      arrange();
      echoWithLunches();
      const warn = warnings();

      const result = await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      // The engine was asked, so nothing stands in for its sittings.
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('sittings stand'));

      expect(result.lunches).toEqual([
        {
          studentGroupId: GROUP_ID,
          dayOfWeek: 1,
          startTime: '11:30:00',
          endTime: '12:00:00',
        },
      ]);
    });

    it('drops a sitting for a group the payload never carried', async () => {
      // An id the gateway cannot resolve means the engine invented one. A lunch
      // pointing at a group that does not exist is worse than no lunch: it
      // would be stored, drawn, and unexplainable.
      arrange();
      http.post.mockImplementation((_url: string, payload: any) =>
        of({
          data: {
            requestId: payload.requestId,
            status: 'OPTIMAL',
            lessons: payload.requirements.flatMap((r: any) =>
              Array.from({ length: r.lessonsPerWeek }, () => ({
                requirementId: r.id,
                roomId: payload.rooms[0]?.id ?? null,
                dayOfWeek: 1,
                startTime: '08:00:00',
                endTime: '09:15:00',
              })),
            ),
            lunches: [
              {
                studentGroupId: '99999999-9999-4999-8999-999999999999',
                dayOfWeek: 1,
                startTime: '11:30:00',
                endTime: '12:00:00',
              },
            ],
            conflicts: null,
          },
        }),
      );

      const result = await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(result.lunches).toEqual([]);
    });

    it('answers with an empty list when the engine sends no sittings', async () => {
      // An older engine omits the field entirely. `undefined` must not reach a
      // caller that will iterate it.
      arrange();
      echoEngine();

      const result = await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(result.lunches).toEqual([]);
    });

    it('sends the engine no parked lesson as a fixed placement', async () => {
      // A parked lesson is preserved like any hand-made one — regeneration
      // does not own it — but blocking the engine out of a slot nobody is in
      // would be reading its memory of where it was as where it is.
      arrange({ lockedLessons: [lockedLesson()] });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(tx.masterLesson.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ isParked: false, OR: expect.any(Array) }),
        }),
      );
    });

    it('forwards no real database id — every resource is re-keyed anonymously', async () => {
      arrange({
        lockedLessons: [lockedLesson()],
        constraints: [
          constraintRow({ userId: TEACHER_ID, resourceType: 'TEACHER' }),
        ],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      const serialized = JSON.stringify(postedPayload());
      for (const realId of [
        REQ_ID,
        SUBJECT_ID,
        GROUP_ID,
        TEACHER_ID,
        ROOM_ID,
        'constraint-real-id',
        'locked-1',
      ]) {
        expect(serialized).not.toContain(realId);
      }
    });

    it('keeps the non-PII scheduling facts on the anonymized requirement', async () => {
      arrange();
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(postedPayload().requirements[0]).toMatchObject({
        lessonsPerWeek: 3,
        minutesPerLesson: 60,
        studentGroupSize: 24,
        coTeacherId: null,
      });

      // Room types are school-authored words ("Trä- och metallslöjd"), so the
      // token that crosses to the engine must be anonymised like every other
      // id — never the real row id, and never the name.
      const posted = postedPayload().requirements[0].requiredRoomType;
      expect(posted).toEqual(expect.any(String));
      expect(posted).not.toBe('room-type-lab');
    });

    it('forwards the pupil buffers beside the lesson length, not folded into it', async () => {
      // The engine has to be told both, separately: it still places 60 minutes
      // of teaching and still owes the timplan 60, while keeping the CLASS clear
      // for 90. A sum would place a 90-minute lesson and lose which part of it
      // was ombyte — and the engine's own arm for these is the pupil arm alone,
      // which it cannot find if the numbers arrive already added up.
      arrange({
        requirements: [requirement({ minutesBefore: 10, minutesAfter: 20 })],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(postedPayload().requirements[0]).toMatchObject({
        minutesPerLesson: 60,
        minutesBefore: 10,
        minutesAfter: 20,
      });
    });

    it('sends the zeroes of a requirement nobody wrote an ombyte on', async () => {
      // Not omitted and not undefined: the engine's pydantic models forbid an
      // unknown field and the gateway's own contract spec pins both names, so a
      // requirement that simply drops them is a 422 for the whole run.
      arrange();
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(postedPayload().requirements[0]).toMatchObject({
        minutesBefore: 0,
        minutesAfter: 0,
      });
    });

    it('selects the two buffer columns from the requirement table', async () => {
      arrange();
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(tx.teachingRequirement.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({
            minutesBefore: true,
            minutesAfter: true,
          }),
        }),
      );
    });

    it('maps each real resource to one stable anonymous id across the payload', async () => {
      arrange({
        lockedLessons: [lockedLesson()],
        constraints: [
          constraintRow({ userId: TEACHER_ID, resourceType: 'TEACHER' }),
          constraintRow({ roomId: ROOM_ID, resourceType: 'ROOM' }),
        ],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());
      const payload = postedPayload();
      const [req] = payload.requirements;
      const [fixed] = payload.fixedLessons;
      const [room] = payload.rooms;
      const [teacherConstraint, roomConstraint] = payload.constraints;

      // The engine can only respect "same teacher / same room" collisions if
      // one real id always maps to the same anonymous id within a request.
      expect(fixed.teacherId).toBe(req.teacherId);
      expect(fixed.studentGroupId).toBe(req.studentGroupId);
      expect(fixed.roomId).toBe(room.id);
      expect(teacherConstraint.resourceId).toBe(req.teacherId);
      expect(roomConstraint.resourceId).toBe(room.id);
    });

    it('subtracts locked lessons from the weekly demand sent to the engine', async () => {
      arrange({ lockedLessons: [lockedLesson()] });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(postedPayload().requirements[0].lessonsPerWeek).toBe(2);
    });

    it('skips the engine when locked lessons already cover all demand', async () => {
      arrange({
        requirements: [requirement({ lessonsPerWeek: 1 })],
        lockedLessons: [lockedLesson()],
      });

      const result = await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(http.post).not.toHaveBeenCalled();
      expect(result).toMatchObject({ status: 'FEASIBLE', lessons: [] });
      // The persist phase still runs so stale unlocked leftovers are removed.
      expect(tx.masterLesson.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ academicYearId: ACADEMIC_YEAR }),
        }),
      );
    });

    /*
     * A locked lesson only cancels demand it covers for the requirement's
     * whole period.
     *
     * The engine knows nothing about weeks, so a subtraction applies to all of
     * them. Subtracting for a lesson that is absent from part of the period
     * leaves the class one lesson short on those weeks, for the whole year,
     * with nothing anywhere saying so. Over-delivering instead puts an extra
     * lesson on the timetable, where somebody can see it.
     */
    it('does not let an alternating locked lesson cancel a weekly lesson', async () => {
      arrange({ lockedLessons: [lockedLesson({ recurrence: 'ODD_WEEKS' })] });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());
      const payload = postedPayload();

      // Timplanen says three a week; the odd-week lesson covers none of the
      // even weeks, so all three are still the engine's to place.
      expect(payload.requirements[0].lessonsPerWeek).toBe(3);
      // And it is still a fixed placement, so its slot stays blocked in every
      // week — that is what makes over-delivery cost packing room, not a clash.
      expect(payload.fixedLessons).toHaveLength(1);
    });

    it('does not let a part-of-the-year locked lesson cancel a weekly lesson', async () => {
      arrange({
        lockedLessons: [
          lockedLesson({
            startDate: new Date('2026-01-07T00:00:00.000Z'),
            endDate: new Date('2026-06-11T00:00:00.000Z'),
          }),
        ],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      // A subject read for one term is absent for the other one, so it covers
      // no more of a full-year requirement than an alternating lesson does.
      expect(postedPayload().requirements[0].lessonsPerWeek).toBe(3);
    });

    it('does not let a locked lesson cancel demand outside its own window', async () => {
      const autumnStart = new Date('2025-08-18T00:00:00.000Z');
      arrange({
        requirements: [
          requirement({
            startDate: autumnStart,
            endDate: new Date('2026-06-11T00:00:00.000Z'),
          }),
        ],
        lockedLessons: [
          lockedLesson({
            // Autumn term only, against a requirement read all year: the spring
            // half of it has no lesson in it at all. The lesson looks like a
            // perfectly good match on (group, subject) and covers two thirds of
            // what was asked for, which is exactly why the comparison has to be
            // against the requirement's own period rather than the default.
            startDate: autumnStart,
            endDate: new Date('2025-12-19T00:00:00.000Z'),
          }),
        ],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(postedPayload().requirements[0].lessonsPerWeek).toBe(3);
    });

    it('lets a locked lesson matching the requirement period cancel a lesson', async () => {
      const spring = {
        startDate: new Date('2026-01-07T00:00:00.000Z'),
        endDate: new Date('2026-06-11T00:00:00.000Z'),
      };
      arrange({
        requirements: [requirement({ recurrence: 'ODD_WEEKS', ...spring })],
        lockedLessons: [lockedLesson({ recurrence: 'ODD_WEEKS', ...spring })],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      // The counterweight to the refusals above: a rule that never counted
      // anything would send the full demand every time and quietly double a
      // half-term subject on every regeneration.
      expect(postedPayload().requirements[0].lessonsPerWeek).toBe(2);
    });

    it('lets an all-year locked lesson cancel a lesson of a one-term requirement', async () => {
      arrange({
        requirements: [
          requirement({
            startDate: new Date('2026-01-07T00:00:00.000Z'),
            endDate: new Date('2026-06-11T00:00:00.000Z'),
          }),
        ],
        lockedLessons: [lockedLesson()],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      // An absent bound is the open one, so a lesson with neither encloses any
      // period a requirement can name — it is there every week the requirement
      // is, and then some.
      expect(postedPayload().requirements[0].lessonsPerWeek).toBe(2);
    });

    /*
     * Lektionslängder. A split requirement is one entry carrying its lengths;
     * a lock cancels the length it answers (locked-coverage.ts), and a
     * remainder of one length is today's uniform entry, with no list.
     */
    describe('lektionslängder', () => {
      const at = (hours: number, minutes: number): Date =>
        new Date(`1970-01-01T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00.000Z`);
      const idrott = (overrides: Record<string, unknown> = {}) =>
        requirement({ lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40], ...overrides });
      /** An engine that places every sent lesson at the length it was sent. */
      const placeAsSent = (lengthsOf: (r: any) => number[] = (r) => r.lessonLengths ?? Array(r.lessonsPerWeek).fill(r.minutesPerLesson)) =>
        http.post.mockImplementation((_url: string, payload: any) =>
          of({
            data: {
              requestId: payload.requestId,
              status: 'OPTIMAL',
              lessons: payload.requirements.flatMap((r: any) =>
                lengthsOf(r).map((minutes: number, i: number) => ({
                  requirementId: r.id,
                  roomId: payload.rooms[0]?.id ?? null,
                  dayOfWeek: i + 1,
                  startTime: '08:00:00',
                  endTime: `${String(8 + Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00`,
                })),
              ),
            },
          }),
        );

      it('sends a uniform requirement exactly as before: no list key, even though the column holds []', async () => {
        arrange();
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        const sent = postedPayload().requirements[0]!;
        expect(sent).not.toHaveProperty('lessonLengths');
        expect(Object.keys(sent)).toEqual([
          'id', 'subjectId', 'studentGroupId', 'teacherId', 'lessonsPerWeek', 'minutesPerLesson',
          'minutesBefore', 'minutesAfter', 'studentGroupSize', 'minGradeLevel', 'maxGradeLevel',
          'requiredRoomType', 'coTeacherId',
        ]);
      });

      it('sends a split requirement as one entry with its lengths, its count and its longest', async () => {
        arrange({ requirements: [idrott()] });
        placeAsSent();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        expect(postedPayload().requirements).toHaveLength(1);
        expect(postedPayload().requirements[0]).toMatchObject({
          lessonsPerWeek: 2,
          minutesPerLesson: 80,
          lessonLengths: [80, 40],
        });
      });

      it.each<[string, [number, number][], object]>([
        ['a locked 80 leaves the 40, sent uniform', [[8, 80]], { lessonsPerWeek: 1, minutesPerLesson: 40 }],
        ['a locked 40 leaves the 80, sent uniform', [[8, 40]], { lessonsPerWeek: 1, minutesPerLesson: 80 }],
        ['a locked 50 cancels the nearest, the 40', [[8, 50]], { lessonsPerWeek: 1, minutesPerLesson: 80 }],
        ['a locked 60 is a tie, and cancels the shorter', [[8, 60]], { lessonsPerWeek: 1, minutesPerLesson: 80 }],
      ])('%s', async (_case, locks, expected) => {
        arrange({
          requirements: [idrott()],
          lockedLessons: locks.map(([hour, minutes], i) =>
            lockedLesson({ id: `locked-${i}`, startTime: at(hour, 0), endTime: at(hour + Math.floor(minutes / 60), minutes % 60) }),
          ),
        });
        placeAsSent();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        const sent = postedPayload().requirements[0]!;
        expect(sent).toMatchObject(expected);
        expect(sent).not.toHaveProperty('lessonLengths');
      });

      it('drops a split requirement both of whose lengths are locked', async () => {
        arrange({
          requirements: [idrott()],
          lockedLessons: [
            lockedLesson({ id: 'locked-80', startTime: at(8, 0), endTime: at(9, 20) }),
            lockedLesson({ id: 'locked-75', dayOfWeek: 3, startTime: at(8, 0), endTime: at(9, 15) }),
          ],
        });

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        expect(http.post).not.toHaveBeenCalled();
      });

      it('writes each generated lesson at its own length', async () => {
        arrange({ requirements: [idrott()] });
        placeAsSent();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        const minutes = written()
          .map((row) => (row.endTime.getTime() - row.startTime.getTime()) / 60000)
          .sort((a, b) => b - a);
        expect(minutes).toEqual([80, 40]);
      });

      it('refuses an engine that placed the split requirement at the wrong lengths, and touches nothing', async () => {
        arrange({ requirements: [idrott()] });
        // Two lessons, as asked — but both 80: the count passes, the lengths do not.
        placeAsSent(() => [80, 80]);

        await expect(service.triggerScheduling(ACADEMIC_YEAR, testUser())).rejects.toMatchObject({ status: 502 });
        expect(tx.masterLesson.deleteMany).not.toHaveBeenCalled();
        expect(tx.masterLesson.createMany).not.toHaveBeenCalled();
      });

      it('still checks a uniform requirement by count alone, as it always did', async () => {
        // The echo places every lesson 08:00-09:15 for a 60-minute row: a
        // count-only guard accepts it, as before the lengths existed.
        arrange();
        echoEngine();

        await expect(service.triggerScheduling(ACADEMIC_YEAR, testUser())).resolves.toBeDefined();
      });
    });

    it('still asks the engine when only alternating lessons cover the demand', async () => {
      arrange({
        requirements: [requirement({ lessonsPerWeek: 1 })],
        lockedLessons: [lockedLesson({ recurrence: 'EVEN_WEEKS' })],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      // The counterpart of the skip above: demand that only looks covered must
      // not take the shortcut past the solver, or the odd weeks get nothing.
      expect(http.post).toHaveBeenCalled();
      expect(postedPayload().requirements).toHaveLength(1);
      expect(postedPayload().requirements[0].lessonsPerWeek).toBe(1);
    });

    it('forwards locked lessons as fixed placements with HH:MM:SS times', async () => {
      arrange({
        requirements: [
          requirement(),
          requirement({
            id: '88888888-8888-4888-8888-888888888888',
            studentGroupId: EXTRA_GROUP_ID,
          }),
        ],
        lockedLessons: [
          lockedLesson({ extraGroups: [{ studentGroupId: EXTRA_GROUP_ID }] }),
        ],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());
      const payload = postedPayload();
      const [fixed] = payload.fixedLessons;

      expect(fixed).toMatchObject({
        dayOfWeek: 2,
        startTime: '08:00:00',
        endTime: '09:00:00',
      });
      // The second class under the token its own requirement carries, so the
      // engine keeps that class out of another lesson at the same hour.
      expect(fixed.extraGroupIds).toEqual([payload.requirements[1].studentGroupId]);
      expect(fixed.extraGroupIds).not.toContain(EXTRA_GROUP_ID); // anonymized
    });

    it('forwards previous unlocked slots for minimal disruption, dropping orphans', async () => {
      arrange({
        unlockedLessons: [
          {
            subjectId: SUBJECT_ID,
            studentGroupId: GROUP_ID,
            dayOfWeek: 4,
            startTime: eightAm,
          },
          {
            // No requirement exists for this subject — must be skipped.
            subjectId: 'retired-subject',
            studentGroupId: GROUP_ID,
            dayOfWeek: 5,
            startTime: nineAm,
          },
        ],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());
      const payload = postedPayload();

      expect(payload.previousLessons).toEqual([
        {
          requirementId: payload.requirements[0].id,
          dayOfWeek: 4,
          startTime: '08:00:00',
        },
      ]);
    });

    it('forwards weights and rules only when the caller supplied them', async () => {
      arrange();
      echoEngine();

      await service.triggerScheduling(
        ACADEMIC_YEAR,
        testUser(),
        { spread: 7 },
        { lunchMinutes: 30 },
      );
      expect(postedPayload()).toMatchObject({
        weights: { spread: 7 },
        rules: { lunchMinutes: 30 },
      });

      http.post.mockClear();
      await service.triggerScheduling(ACADEMIC_YEAR, testUser(), null, null);
      expect(postedPayload()).not.toHaveProperty('weights');
      expect(postedPayload()).not.toHaveProperty('rules');
    });

    it('authenticates to the engine with the service key at the configured URL', async () => {
      arrange();
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(http.post).toHaveBeenCalledWith(
        'http://solver.test/v1/schedule',
        expect.anything(),
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-API-Key': 'k'.repeat(32),
            'Content-Type': 'application/json',
          }),
        }),
      );
    });

    it('translates the anonymous solution back to real ids before persisting', async () => {
      arrange();
      echoEngine('OPTIMAL');

      await service.triggerScheduling(
        ACADEMIC_YEAR,
        testUser({ schoolId: 'school-A' }),
      );

      // Three lessons a week were asked for, so three come back and three are
      // written — the whole solution, not a sample of it — in ONE statement.
      expect(tx.masterLesson.createMany).toHaveBeenCalledTimes(1);
      expect(written()).toHaveLength(3);
      expect(written()).toContainEqual({
        schoolId: 'school-A',
        academicYearId: ACADEMIC_YEAR,
        subjectId: SUBJECT_ID,
        studentGroupId: GROUP_ID,
        teacherId: TEACHER_ID,
        coTeacherId: null,
        roomId: ROOM_ID,
        dayOfWeek: 1,
        startTime: new Date('1970-01-01T08:00:00.000Z'),
        endTime: new Date('1970-01-01T09:15:00.000Z'),
        recurrence: 'ALL_WEEKS',
        startDate: null,
        endDate: null,
        isGenerated: true,
      });
    });

    it('gives a windowed requirement windowed lessons, stamped as its own', async () => {
      const springStart = new Date('2026-01-07T00:00:00.000Z');
      const springEnd = new Date('2026-06-11T00:00:00.000Z');
      arrange({
        requirements: [
          requirement({
            lessonsPerWeek: 1,
            recurrence: 'ODD_WEEKS',
            startDate: springStart,
            endDate: springEnd,
          }),
        ],
      });
      echoEngine('OPTIMAL');

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      // The engine is never told about weeks — it packs the requirement as if
      // it ran all year — so the period can only be stamped on here, from the
      // requirement. Without it "slöjd udda veckor" comes back weekly and
      // all-year, and the timplan is quietly rewritten by a regeneration.
      expect(written()).toHaveLength(1);
      expect(written()[0]).toMatchObject({
        recurrence: 'ODD_WEEKS',
        startDate: springStart,
        endDate: springEnd,
        // And the row says whose it is, so the next run may delete it. Inferred
        // ownership would read these very columns as a human's handiwork.
        isGenerated: true,
      });
    });

    it('refuses a solution whose anonymous requirement is unknown', async () => {
      // It used to drop the lesson and carry on — having already deleted the
      // year's unlocked timetable to make room for it.
      arrange();
      http.post.mockImplementation(() =>
        of({
          data: {
            requestId: 'r',
            status: 'FEASIBLE',
            lessons: [
              {
                requirementId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
                roomId: null,
                dayOfWeek: 1,
                startTime: '08:00:00',
                endTime: '09:00:00',
              },
            ],
            conflicts: null,
          },
        }),
      );

      await expect(
        service.triggerScheduling(ACADEMIC_YEAR, testUser()),
      ).rejects.toMatchObject({ status: 502 });

      expect(tx.masterLesson.deleteMany).not.toHaveBeenCalled();
      expect(tx.masterLesson.createMany).not.toHaveBeenCalled();
      expect(tx.scheduleChangeLog.create).not.toHaveBeenCalled();
    });

    it('appends a REGENERATE audit entry with the replacement counts', async () => {
      // One lesson the delete kept, read back after it.
      arrange({ keptAfterSolve: [lockedLesson()] });
      echoEngine('OPTIMAL');
      const user = testUser({ schoolId: 'school-A', userId: 'admin-1' });

      await service.triggerScheduling(ACADEMIC_YEAR, user);

      expect(tx.scheduleChangeLog.create).toHaveBeenCalledWith({
        data: {
          schoolId: 'school-A',
          academicYearId: ACADEMIC_YEAR,
          masterLessonId: null,
          actorId: 'admin-1',
          action: 'REGENERATE',
          after: {
            solverStatus: 'OPTIMAL',
            lessonsCreated: 3,
            unlockedReplaced: 2,
            lockedPreserved: 1,
            calendarLessonsRemoved: 4,
          },
        },
      });
    });

    it('runs the fetch and persist phases under the caller RLS session', async () => {
      arrange();
      echoEngine();
      const user = testUser();

      await service.triggerScheduling(ACADEMIC_YEAR, user);

      expect(prisma.withRls).toHaveBeenCalledTimes(2);
      expect(prisma.withRls.mock.calls[0][0]).toBe(user);
      expect(prisma.withRls.mock.calls[1][0]).toBe(user);
    });

    it('defaults an empty group to size 1 rather than zero', async () => {
      arrange({ homeMembers: [], teachingMembers: [] });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(postedPayload().requirements[0].studentGroupSize).toBe(1);
    });

    it('sends a class taught only through teaching groups as a group, with its headcount', async () => {
      /*
       * The school in the screenshot: every lesson on 4ma1, 4sv1, 4no1 — not
       * one on 4.1 itself. Such a class has no requirement and no preserved
       * lesson, so it never reached `groups`, so the engine owed it no lunch;
       * the sittings it DID place, for the teaching groups, were dropped at
       * persist because a pupil eats with their class. Zero rows, and a notice
       * saying no lunch had been placed for the year.
       */
      const MA71 = '99999999-9999-4999-8999-999999999999';
      const pupils = Array.from({ length: 24 }, (_, i) => ({
        id: `00000000-0000-4000-8000-9000000000${String(i).padStart(2, '0')}`,
        studentGroupId: GROUP_ID,
      }));
      arrange({
        requirements: [requirement({ studentGroupId: MA71 })],
        groups: [
          { id: GROUP_ID, gradeLevel: 4, kind: 'CLASS' },
          { id: MA71, gradeLevel: null, kind: 'TEACHING_GROUP' },
        ],
        homeMembers: pupils,
        teachingMembers: pupils.map((pupil) => ({ studentId: pupil.id, studentGroupId: MA71 })),
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      const payload = postedPayload();
      // Exactly one: the class. The teaching group is not sent as a group at
      // all — a second mandatory meal for the same children would reserve
      // thirty minutes of Ma71's day for a lunch nobody takes there.
      expect(payload.groups).toHaveLength(1);
      expect(payload.groups[0]).toMatchObject({ lunchHeadcount: 24, minGradeLevel: 4, maxGradeLevel: 4 });
      // And the class's meal is kept clear of the teaching group's lessons:
      // the shared-pupil pair reaches the payload even though the class has no
      // requirement of its own, because the class got its anonymous id first.
      expect(payload.groupConflicts).toHaveLength(1);
      const [pair] = payload.groupConflicts;
      expect(new Set(pair)).toEqual(new Set([payload.groups[0].id, payload.requirements[0].studentGroupId]));
    });

    it('derives group-conflict pairs from students shared across groups', async () => {
      // Two scheduled groups: home class 7A and teaching group Ma71. Student
      // S1 has 7A as home class AND a Ma71 membership -> exactly one pair.
      const CLASS_7A = GROUP_ID;
      const MA71 = '99999999-9999-4999-8999-999999999999';
      arrange({
        requirements: [
          requirement(),
          requirement({ id: '88888888-8888-4888-8888-888888888888', studentGroupId: MA71 }),
        ],
        homeMembers: [
          { id: 'aaaaaaa1-0000-4000-8000-000000000001', studentGroupId: CLASS_7A },
          { id: 'aaaaaaa2-0000-4000-8000-000000000002', studentGroupId: CLASS_7A },
        ],
        teachingMembers: [
          { studentId: 'aaaaaaa1-0000-4000-8000-000000000001', studentGroupId: MA71 },
        ],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      const payload = postedPayload();
      expect(payload.groupConflicts).toHaveLength(1);
      const [a, b] = payload.groupConflicts[0];
      // The pair uses the SAME anonymous ids as the requirements do…
      const anonGroups = payload.requirements.map((r) => r.studentGroupId);
      expect(anonGroups).toContain(a);
      expect(anonGroups).toContain(b);
      expect(a).not.toBe(b);
      // …and no real id leaks through the pair list.
      const serialized = JSON.stringify(payload.groupConflicts);
      expect(serialized).not.toContain(CLASS_7A);
      expect(serialized).not.toContain(MA71);
    });

    describe('a class split in halves (Halvklasser)', () => {
      // 7A (four pupils) split into 7A:1 and 7A:2; Ma7 holds 7A's first pupil.
      // Each has a requirement, in this order, so requirements[i] is group i.
      const H1 = '7a000001-0000-4000-8000-000000000001';
      const H2 = '7a000002-0000-4000-8000-000000000002';
      const MA7 = '99999999-9999-4999-8999-999999999999';
      const pupil = (n: number) => `aaaaaaa${n}-0000-4000-8000-00000000000${n}`;
      const arrangeHalves = (teachingMembers: Row[]) =>
        arrange({
          requirements: [GROUP_ID, H1, H2, MA7].map((studentGroupId, index) =>
            requirement({ id: `88888888-8888-4888-8888-88888888888${index}`, studentGroupId }),
          ),
          groups: [
            { id: GROUP_ID, gradeLevel: 7, kind: 'CLASS', halfOfId: null },
            { id: H1, gradeLevel: 7, kind: 'TEACHING_GROUP', halfOfId: GROUP_ID },
            { id: H2, gradeLevel: 7, kind: 'TEACHING_GROUP', halfOfId: GROUP_ID },
            { id: MA7, gradeLevel: null, kind: 'TEACHING_GROUP', halfOfId: null },
          ],
          homeMembers: [1, 2, 3, 4].map((n) => ({ id: pupil(n), studentGroupId: GROUP_ID })),
          teachingMembers,
        });
      /** The payload's pairs, read back as indexes into [7A, 7A:1, 7A:2, Ma7]. */
      const pairsByIndex = () => {
        const payload = postedPayload();
        const index = new Map(payload.requirements.map((r, i) => [r.studentGroupId, i]));
        return payload.groupConflicts
          .map(([a, b]) => [index.get(a)!, index.get(b)!].sort().join('-'))
          .sort();
      };

      it('keeps a half off its class and off every group of the class before anyone is placed, and lets the two halves overlap', async () => {
        arrangeHalves([{ studentId: pupil(1), studentGroupId: MA7 }]);
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        // 7A-7A:1, 7A-7A:2, 7A-Ma7, 7A:1-Ma7, 7A:2-Ma7 — and never 7A:1-7A:2.
        expect(pairsByIndex()).toEqual(['0-1', '0-2', '0-3', '1-3', '2-3']);
        // A half planned before placement is sized for its share of the class.
        expect(postedPayload().requirements.map((r) => r.studentGroupSize)).toEqual([4, 2, 2, 1]);
      });

      it('pairs a half with only what its own pupils are in once everyone is placed', async () => {
        arrangeHalves([
          { studentId: pupil(1), studentGroupId: MA7 },
          { studentId: pupil(1), studentGroupId: H1 },
          { studentId: pupil(2), studentGroupId: H1 },
          { studentId: pupil(3), studentGroupId: H2 },
          { studentId: pupil(4), studentGroupId: H2 },
        ]);
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        // Ma7's pupil is in 7A:1: 7A:2 may run beside Ma7 now.
        expect(pairsByIndex()).toEqual(['0-1', '0-2', '0-3', '1-3']);
        expect(postedPayload().requirements.map((r) => r.studentGroupSize)).toEqual([4, 2, 2, 1]);
      });

      it('sends a class whose only lessons are its halves’ as a class that eats', async () => {
        arrange({
          requirements: [requirement({ studentGroupId: H1 })],
          groups: [
            { id: GROUP_ID, gradeLevel: 7, kind: 'CLASS', halfOfId: null },
            { id: H1, gradeLevel: 7, kind: 'TEACHING_GROUP', halfOfId: GROUP_ID },
          ],
          homeMembers: [1, 2].map((n) => ({ id: pupil(n), studentGroupId: GROUP_ID })),
          teachingMembers: [],
        });
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        expect(postedPayload().groups).toEqual([expect.objectContaining({ lunchHeadcount: 2 })]);
      });
    });

    it('emits no pair for groups without shared students', async () => {
      const OTHER = '99999999-9999-4999-8999-999999999999';
      arrange({
        requirements: [
          requirement(),
          requirement({ id: '88888888-8888-4888-8888-888888888888', studentGroupId: OTHER }),
        ],
        homeMembers: [
          { id: 'aaaaaaa1-0000-4000-8000-000000000001', studentGroupId: GROUP_ID },
          { id: 'aaaaaaa2-0000-4000-8000-000000000002', studentGroupId: OTHER },
        ],
        teachingMembers: [],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(postedPayload().groupConflicts).toEqual([]);
    });

    describe('a term split: the spring block on the autumn block’s times (same-times.ts)', () => {
      // 7A's slöjd split by term: in the autumn 7A:1 reads textilslöjd with
      // Tove and 7A:2 trä- och metallslöjd with Tor, in the spring the swap.
      const H1 = '7a000001-0000-4000-8000-000000000001';
      const H2 = '7a000002-0000-4000-8000-000000000002';
      const TX = 'cccccccc-0001-4000-8000-000000000001';
      const TR = 'cccccccc-0002-4000-8000-000000000002';
      const TOVE = 'dddddddd-0001-4000-8000-000000000001';
      const TOR = 'dddddddd-0002-4000-8000-000000000002';
      const TEA = 'dddddddd-0003-4000-8000-000000000003';
      const HT = 'bbbbbbbb-0001-4000-8000-000000000001';
      const VT = 'bbbbbbbb-0002-4000-8000-000000000002';
      const A1 = 'eeeeeeee-0001-4000-8000-000000000001';
      const A2 = 'eeeeeeee-0002-4000-8000-000000000002';
      const S1 = 'eeeeeeee-0003-4000-8000-000000000003';
      const S2 = 'eeeeeeee-0004-4000-8000-000000000004';
      const autumnEnd = new Date('2027-01-10T00:00:00.000Z');
      const springStart = new Date('2027-01-11T00:00:00.000Z');
      const pupil = (n: number) => `aaaaaaa${n}-0000-4000-8000-00000000000${n}`;
      const slojd = (id: string, subjectId: string, studentGroupId: string, term: 'HT' | 'VT', teacherId: string | null, overrides: Row = {}) =>
        requirement({
          id,
          subjectId,
          studentGroupId,
          teacherId,
          lessonsPerWeek: 2,
          blockId: term === 'HT' ? HT : VT,
          startDate: term === 'HT' ? null : springStart,
          endDate: term === 'HT' ? autumnEnd : null,
          subject: subjectId === TX
            ? { requiredRoomTypeId: 'room-type-textil', name: 'Textilslöjd' }
            : { requiredRoomTypeId: 'room-type-tra', name: 'Trä- och metallslöjd' },
          ...overrides,
        });
      const arrangeTerms = (spring: { s1?: Row; s2?: Row } = {}, overrides: Arrangement = {}) => {
        arrange({
          requirements: [
            slojd(A1, TX, H1, 'HT', TOVE),
            slojd(A2, TR, H2, 'HT', TOR),
            slojd(S1, TR, H1, 'VT', TOR, spring.s1),
            slojd(S2, TX, H2, 'VT', TOVE, spring.s2),
          ],
          groups: [
            { id: GROUP_ID, gradeLevel: 7, kind: 'CLASS', halfOfId: null, name: '7A' },
            { id: H1, gradeLevel: 7, kind: 'TEACHING_GROUP', halfOfId: GROUP_ID, name: '7A:1' },
            { id: H2, gradeLevel: 7, kind: 'TEACHING_GROUP', halfOfId: GROUP_ID, name: '7A:2' },
          ],
          // Two pupils in 7A:1 and three in 7A:2.
          homeMembers: [1, 2, 3, 4, 5].map((n) => ({ id: pupil(n), studentGroupId: GROUP_ID })),
          teachingMembers: [
            ...[1, 2].map((n) => ({ studentId: pupil(n), studentGroupId: H1 })),
            ...[3, 4, 5].map((n) => ({ studentId: pupil(n), studentGroupId: H2 })),
          ],
          ...overrides,
        });
        tx.teachingBlock.findMany.mockResolvedValue([
          { id: HT, name: 'Slöjd 7A HT', sameTimesAsBlockId: null },
          { id: VT, name: 'Slöjd 7A VT', sameTimesAsBlockId: HT },
        ]);
      };
      const prepare = () => service.prepareSchedule(tx as unknown as PrismaClient, ACADEMIC_YEAR, testUser());
      const ready = async (): Promise<PreparedSchedule> => {
        const result = await prepare();
        if (!result.ready) throw new Error(`refused: ${result.refusalCode}`);
        return result;
      };
      /** An engine placing the k-th requirement it was sent on weekday k + 1, in the k-th room. */
      const engineByDay = () =>
        http.post.mockImplementation((_url: string, payload: any) =>
          of({
            data: {
              requestId: payload.requestId,
              status: 'OPTIMAL',
              lessons: payload.requirements.flatMap((r: any, k: number) =>
                Array.from({ length: r.lessonsPerWeek }, (_, n) => ({
                  requirementId: r.id,
                  roomId: payload.rooms[k]?.id ?? null,
                  dayOfWeek: k + 1,
                  startTime: `0${8 + n}:00:00`,
                  endTime: `0${8 + n}:50:00`,
                })),
              ),
              conflicts: null,
            },
          }),
        );
      const textilsal = { id: '55555555-0001-4000-8000-000000000001', capacity: 16, roomTypeId: 'room-type-textil' };
      const trasal = { id: '55555555-0002-4000-8000-000000000002', capacity: 16, roomTypeId: 'room-type-tra' };

      it('sends the autumn block alone, each post sized for the larger half, and asks for the spring in the demand', async () => {
        arrangeTerms();

        const prepared = await ready();

        const real = new Map([...prepared.anonMaps.requirementAnonMap].map(([realId, anonId]) => [anonId, realId]));
        const sent = prepared.payload.requirements;
        expect(sent.map((r) => real.get(r.id))).toEqual([A1, A2]);
        expect(new Set(sent.map((r) => r.blockId)).size).toBe(1);
        expect(sent[0]!.blockId).toEqual(expect.any(String));
        // 7A:1 has two pupils and 7A:2 three: the textilsal holds either half.
        expect(sent.map((r) => r.studentGroupSize)).toEqual([3, 3]);
        // The halves swap and the teachers stay: nobody new at the block's times.
        expect(sent.map((r) => r.coTeacherId)).toEqual([null, null]);
        expect(prepared.mirrors).toEqual([
          { leaderId: A2, followerId: S1 },
          { leaderId: A1, followerId: S2 },
        ]);
        expect(prepared.demand).toEqual([
          { requirementId: A1, lessonsPerWeek: 2 },
          { requirementId: A2, lessonsPerWeek: 2 },
          { requirementId: S1, lessonsPerWeek: 2 },
          { requirementId: S2, lessonsPerWeek: 2 },
        ]);
      });

      it('sends each autumn post with the longer buffers of its half and the stricter rule of its subject', async () => {
        // 7A:1's spring trä needs ten minutes of ombyte before it; 7A:2's
        // spring textil at most one lesson a day.
        arrangeTerms({
          s1: { minutesBefore: 10, minutesAfter: 0 },
          s2: { ownDistribution: true, maxLessonsPerDay: 1, minDaysBetween: null },
        });

        const prepared = await ready();

        const [a1, a2] = prepared.payload.requirements;
        // a1 is 7A:1's autumn textil: 7A:1's buffers, textil's rule.
        expect([a1!.minutesBefore, a1!.minutesAfter, a1!.maxLessonsPerDay]).toEqual([10, 0, 1]);
        // a2 is 7A:2's autumn trä: neither.
        expect([a2!.minutesBefore, a2!.maxLessonsPerDay]).toEqual([0, undefined]);
      });

      it('writes each spring post at the times and room of the autumn post in its subject, with its own half, teacher and weeks', async () => {
        arrangeTerms({}, { rooms: [textilsal, trasal] });
        engineByDay();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        const rows = written().map((row) => [
          row.studentGroupId, row.subjectId, row.teacherId, row.roomId, row.dayOfWeek,
          (row.startTime as Date).toISOString().slice(11, 16), row.startDate, row.endDate,
        ]);
        expect(rows).toEqual([
          [H1, TX, TOVE, textilsal.id, 1, '08:00', null, autumnEnd],
          [H1, TX, TOVE, textilsal.id, 1, '09:00', null, autumnEnd],
          [H2, TR, TOR, trasal.id, 2, '08:00', null, autumnEnd],
          [H2, TR, TOR, trasal.id, 2, '09:00', null, autumnEnd],
          // Textil in the spring, on 7A:2, where and when textil was in the autumn.
          [H2, TX, TOVE, textilsal.id, 1, '08:00', springStart, null],
          [H2, TX, TOVE, textilsal.id, 1, '09:00', springStart, null],
          [H1, TR, TOR, trasal.id, 2, '08:00', springStart, null],
          [H1, TR, TOR, trasal.id, 2, '09:00', springStart, null],
        ]);
      });

      it('holds a spring teacher the autumn lacks at the block’s times, beside the autumn post in the subject', async () => {
        const workRule = {
          id: '77777777-0001-4000-8000-000000000001',
          userId: TEA,
          lunchMinutes: 30,
          lunchStartTime: new Date('1970-01-01T10:30:00.000Z'),
          lunchEndTime: new Date('1970-01-01T13:30:00.000Z'),
          minDailyRestMinutes: 660,
          maxTeachingMinutesPerDay: null,
          preferredFreeDayOfWeek: null,
        };
        arrangeTerms({ s2: { teacherId: TEA } }, { workRules: [workRule] });
        engineByDay();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        const payload = postedPayload();
        // Textilslöjd's autumn post carries Tea, the spring's textil teacher.
        expect(payload.requirements[0]!.coTeacherId).toEqual(payload.teacherWorkRules[0]!.teacherId);
        expect(JSON.stringify(payload)).not.toContain(TEA);
        expect(written().filter((row) => row.subjectId === TX && row.studentGroupId === H2).map((row) => row.teacherId)).toEqual([TEA, TEA]);
      });

      /** The refusal prepareSchedule answers, and the 400 Generera throws for it. */
      const refusedWith = async () => {
        const result = await prepare();
        if (result.ready) throw new Error('not refused');
        return result;
      };

      it('refuses two blocks that no longer fit together by their names, before the engine, and writes nothing', async () => {
        arrangeTerms({ s1: { lessonsPerWeek: 3 }, s2: { lessonsPerWeek: 3 } });

        // Answered as the refusals before it are, so a schemaförslag's check
        // and apply read its code, and the fetch's transaction commits.
        const refused = await refusedWith();
        expect(refused.refusalCode).toBe('BLOCK_SAME_TIMES_DIFFER');
        expect(refused.refusal.conflicts).toMatchObject({
          summaryCode: 'BLOCK_SAME_TIMES_DIFFER',
          summaryParams: { block: 'Slöjd 7A VT', other: 'Slöjd 7A HT' },
        });

        // Generera throws it as the engine's 400 for a block it cannot hold.
        arrangeTerms({ s1: { lessonsPerWeek: 3 }, s2: { lessonsPerWeek: 3 } });
        const error = await service.triggerScheduling(ACADEMIC_YEAR, testUser()).catch((thrown: unknown) => thrown);
        expect((error as HttpException).getStatus()).toBe(400);
        expect(bodyOf(error)).toEqual({
          code: 'BLOCK_SAME_TIMES_DIFFER',
          params: { block: 'Slöjd 7A VT', other: 'Slöjd 7A HT' },
          message: expect.stringMatching(/^Slöjd 7A VT takes the times of Slöjd 7A HT, and the two no longer fit together/),
        });
        expect(http.post).not.toHaveBeenCalled();
        expect(tx.masterLesson.deleteMany).not.toHaveBeenCalled();
      });

      it('refuses one teacher on both spring posts as the engine refuses a block, naming the posts', async () => {
        arrangeTerms({ s1: { coTeacherId: TOVE } });

        const refused = await refusedWith();

        expect(refused.refusalCode).toBe('BLOCK_MEMBERS_SHARE_TEACHER');
        expect(bodyOf(refused.error)).toMatchObject({
          code: 'BLOCK_MEMBERS_SHARE_TEACHER',
          params: { block: 'Slöjd 7A VT', requirement: 'Trä- och metallslöjd för 7A:1', other: 'Textilslöjd för 7A:2' },
        });
      });

      it('delade lektioner: refuses a spring post split between teachers, by the post, before the engine', async () => {
        arrangeTerms({ s1: { lessonsPerWeek: 2, shares: [{ teacherId: TEA, lessons: 1, minutes: 60 }] } });

        const refused = await refusedWith();

        expect(refused.refusalCode).toBe('BLOCK_SAME_TIMES_SPLIT_LESSONS');
        expect(bodyOf(refused.error)).toMatchObject({
          code: 'BLOCK_SAME_TIMES_SPLIT_LESSONS',
          params: { block: 'Slöjd 7A VT', other: 'Slöjd 7A HT', requirement: 'Trä- och metallslöjd för 7A:1' },
        });
        expect(http.post).not.toHaveBeenCalled();
      });

      it('refuses spring teachers the autumn posts have no room for', async () => {
        arrangeTerms({ s1: { teacherId: TEA }, s2: { teacherId: 'dddddddd-0004-4000-8000-000000000004', coTeacherId: 'dddddddd-0005-4000-8000-000000000005' } });

        const refused = await refusedWith();

        expect(bodyOf(refused.error)).toMatchObject({ code: 'BLOCK_SAME_TIMES_TEACHERS', params: { block: 'Slöjd 7A VT', other: 'Slöjd 7A HT' } });
      });

      it('refuses an autumn locked while the spring has all its lessons to place, the two named under the partly locked summary', async () => {
        const locked = (id: string, subjectId: string, studentGroupId: string, dayOfWeek: number) =>
          lockedLesson({ id, subjectId, studentGroupId, dayOfWeek, endDate: autumnEnd });
        arrangeTerms({}, {
          lockedLessons: [
            locked('l1', TX, H1, 1), locked('l2', TX, H1, 2), locked('l3', TR, H2, 1), locked('l4', TR, H2, 2),
          ],
        });

        const result = await prepare();

        expect(result).toMatchObject({ ready: false, refusalCode: 'BLOCK_PARTLY_LOCKED_SUMMARY' });
        const conflicts = !result.ready ? result.refusal.conflicts : null;
        expect(conflicts?.conflicts.map((detail) => [detail.code, detail.params, detail.resourceNames])).toEqual([
          ['BLOCK_SAME_TIMES_PARTLY_LOCKED', { block: 'Slöjd 7A HT', other: 'Slöjd 7A VT', locked: 4 }, ['Slöjd 7A HT', 'Slöjd 7A VT']],
        ]);
        expect(http.post).not.toHaveBeenCalled();
      });

      it('places neither block when the school locked both', async () => {
        const locked = (id: string, subjectId: string, studentGroupId: string, term: 'HT' | 'VT', dayOfWeek: number) =>
          lockedLesson({
            id, subjectId, studentGroupId, dayOfWeek,
            startDate: term === 'HT' ? null : springStart,
            endDate: term === 'HT' ? autumnEnd : null,
          });
        arrangeTerms({}, {
          lockedLessons: [
            locked('l1', TX, H1, 'HT', 1), locked('l2', TX, H1, 'HT', 2), locked('l3', TR, H2, 'HT', 1), locked('l4', TR, H2, 'HT', 2),
            locked('l5', TR, H1, 'VT', 1), locked('l6', TR, H1, 'VT', 2), locked('l7', TX, H2, 'VT', 1), locked('l8', TX, H2, 'VT', 2),
          ],
        });

        const prepared = await ready();

        expect([prepared.payload.requirements, prepared.demand, prepared.mirrors]).toEqual([[], [], []]);
      });

      it('mirrors the spring in a schemaförslag candidate too, and its basis sees what the spring posts are written with', async () => {
        arrangeTerms({}, { rooms: [textilsal, trasal] });
        engineByDay();
        const prepared = await ready();

        const solution = await service.solveCandidate(prepared, { timeoutMs: 1000 });

        expect(solution.rejected).toBeUndefined();
        expect(solution.lessons.filter((lesson) => lesson.requirementId === S2)).toEqual([
          { requirementId: S2, roomId: textilsal.id, dayOfWeek: 1, startTime: '08:00', endTime: '08:50' },
          { requirementId: S2, roomId: textilsal.id, dayOfWeek: 1, startTime: '09:00', endTime: '09:50' },
        ]);
        // A spring post's teacher the payload does not carry (Tove teaches the
        // autumn textil either way) still makes a stored candidate stale.
        arrangeTerms({ s2: { teacherId: null } }, { rooms: [textilsal, trasal] });
        const changed = await ready();
        expect(changed.payload.requirements.map((r) => r.teacherId === null)).toEqual([false, false]);
        expect(candidateBasis.changedParts(prepared.basisParts, changed.basisParts)).toEqual(['requirements']);
      });

      it('applies a stored candidate with its spring lessons, and refuses one without them', async () => {
        arrangeTerms({}, { rooms: [textilsal, trasal] });
        engineByDay();
        const prepared = await ready();
        const solution = await service.solveCandidate(prepared, { timeoutMs: 1000 });
        tx.masterLesson.deleteMany.mockResolvedValue({ count: 0 });
        tx.masterLesson.count.mockImplementation(async ({ where }: Query = {}) => (where?.['NOT'] ? 8 : 0));
        const input: CandidateApplyInput = {
          user: testUser({ schoolId: THIS_SCHOOL, userId: 'admin-1' }),
          prepared,
          mode: 'DIRECT',
          lessons: solution.lessons,
          lunches: null,
          solverStatus: 'OPTIMAL',
          snapshot: { versions: { snapshotInTransaction: jest.fn().mockResolvedValue({ id: 'version-1' }) }, name: 'Före schemaförslag 1' },
          after: { source: 'CANDIDATE', runId: 'run-1', ordinal: 1 },
        };

        await service.applyCandidateWrite(tx as unknown as PrismaClient, input);

        expect(written().map((row) => [row.studentGroupId, row.subjectId, row.dayOfWeek, row.startDate])).toEqual(
          expect.arrayContaining([
            [H2, TX, 1, springStart],
            [H1, TR, 2, springStart],
          ]),
        );
        expect(written()).toHaveLength(8);

        // A candidate stored without the spring is not the answer the demand asks for.
        tx.masterLesson.createMany.mockClear();
        const refusal = await service
          .applyCandidateWrite(tx as unknown as PrismaClient, {
            ...input,
            lessons: solution.lessons.filter((lesson) => lesson.requirementId !== S1),
          })
          .catch((thrown: unknown) => thrown);
        expect(bodyOf(refusal)).toMatchObject({ code: 'SCHEDULE_CANDIDATE_STALE' });
        expect(tx.masterLesson.createMany).not.toHaveBeenCalled();
      });
    });

    describe('soft room wishes', () => {
      it('anonymises the subject, type and rooms a wish names', async () => {
        arrange({
          roomPreferences: [
            {
              id: 'pref-1',
              subjectId: SUBJECT_ID,
              roomTypeId: null,
              weight: 200,
              rooms: [{ roomId: ROOM_ID }],
            },
          ],
        });
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        const [wish] = postedPayload().roomPreferences;
        expect(wish.weight).toBe(200);
        // Nothing recognisable leaves the gateway: every id is a stand-in.
        expect(wish.subjectId).not.toBe(SUBJECT_ID);
        expect(JSON.stringify(wish)).not.toContain(ROOM_ID);
      });

      it('maps a wish to the same anonymous room the payload uses', async () => {
        arrange({
          roomPreferences: [
            {
              id: 'pref-1',
              subjectId: SUBJECT_ID,
              roomTypeId: null,
              weight: 50,
              rooms: [{ roomId: ROOM_ID }],
            },
          ],
        });
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        const payload = postedPayload();
        // A wish pointing at an id the rooms list does not contain would be a
        // rule about a room the engine cannot see.
        expect(payload.roomPreferences[0].roomIds).toEqual([payload.rooms[0].id]);
      });

      it('drops a room the payload does not carry', async () => {
        arrange({
          roomPreferences: [
            {
              id: 'pref-1',
              subjectId: SUBJECT_ID,
              roomTypeId: null,
              weight: 50,
              rooms: [{ roomId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }],
            },
          ],
        });
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        expect(postedPayload().roomPreferences[0].roomIds).toEqual([]);
      });

      const GONE_ROOM = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
      const rule = (kind: 'WISH' | 'LOCK', roomIds: string[]) => ({
        id: 'pref-1',
        subjectId: SUBJECT_ID,
        kind,
        minGradeLevel: null,
        maxGradeLevel: null,
        roomTypeId: null,
        weight: 50,
        rooms: roomIds.map((roomId) => ({ roomId })),
      });

      it('speaks of the subject and the kind of room in the timplan’s own tokens', async () => {
        // A wish is about a subject and a kind of room, and the engine can only
        // apply it to the lessons that carry those same tokens.
        arrange({
          roomPreferences: [{ ...rule('WISH', [ROOM_ID]), roomTypeId: 'room-type-lab' }],
        });
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        const payload = postedPayload();
        expect(payload.roomPreferences[0].subjectId).toBe(payload.requirements[0].subjectId);
        expect(payload.roomPreferences[0].roomType).toBe(payload.requirements[0].requiredRoomType);
      });

      it('names a room rule by its own id when the engine refuses over it', async () => {
        arrange({ roomPreferences: [{ ...rule('LOCK', [ROOM_ID]), id: 'pref-lock-7a' }] });
        http.post.mockImplementation((_url: string, payload: any) => {
          const refused = new AxiosError('refused');
          refused.response = {
            status: 400,
            data: {
              message: `A room lock ${payload.roomPreferences[0].id} leaves requirement ${payload.requirements[0].id} nowhere to go.`,
            },
          } as never;
          return throwError(() => refused);
        });

        await expect(service.triggerScheduling(ACADEMIC_YEAR, testUser())).rejects.toThrow(
          `A room lock pref-lock-7a leaves requirement ${REQ_ID} nowhere to go.`,
        );
      });

      it('warns when a lock names a room the payload no longer carries', async () => {
        // Dropped from a wish, a vanished room only weakens a preference. Dropped
        // from a lock it narrows a rule the school reads as wider, so it is said.
        arrange({ roomPreferences: [rule('LOCK', [ROOM_ID, GONE_ROOM])] });
        echoEngine();
        const warn = warnings();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        expect(warn).toHaveBeenCalledWith(expect.stringContaining('Room lock pref-1 names 1 room(s)'));
        expect(postedPayload().roomPreferences[0].roomIds).toEqual([postedPayload().rooms[0].id]);
      });

      it.each([
        ['a wish that has lost a room', rule('WISH', [ROOM_ID, GONE_ROOM])],
        ['a lock whose rooms are all still there', rule('LOCK', [ROOM_ID])],
      ])('says nothing about %s', async (_label, preference) => {
        arrange({ roomPreferences: [preference] });
        echoEngine();
        const warn = warnings();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('Room lock'));
      });

      it('sends an empty list when the school has stated no wishes', async () => {
        arrange();
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        expect(postedPayload().roomPreferences).toEqual([]);
      });
    });

    describe('year spans for stage-limited rooms', () => {
      /** A second group, for the teaching-group cases. */
      const OTHER = '99999999-9999-4999-8999-999999999999';
      const student = (n: number, groupId: string) => ({
        id: `00000000-0000-4000-8000-90000000${String(n).padStart(4, '0')}`,
        studentGroupId: groupId,
      });

      it('derives the span from the students home classes', async () => {
        arrange({
          homeMembers: [student(1, GROUP_ID), student(2, GROUP_ID)],
          groups: [{ id: GROUP_ID, gradeLevel: 5 }],
        });
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        expect(postedPayload().requirements[0]).toMatchObject({
          minGradeLevel: 5,
          maxGradeLevel: 5,
        });
      });

      it('gives a teaching group the years of its members, not its own blank', async () => {
        // The case the whole derivation exists for: Ma71 carries no gradeLevel,
        // but its students are year 7 and it must not be let into a 4-6 room.
        arrange({
          requirements: [requirement({ studentGroupId: OTHER })],
          homeMembers: [student(1, GROUP_ID)],
          teachingMembers: [{ studentId: student(1, GROUP_ID).id, studentGroupId: OTHER }],
          groups: [
            { id: GROUP_ID, gradeLevel: 7 },
            { id: OTHER, gradeLevel: null },
          ],
        });
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        expect(postedPayload().requirements[0]).toMatchObject({
          minGradeLevel: 7,
          maxGradeLevel: 7,
        });
      });

      it('spans every year its members come from', async () => {
        arrange({
          requirements: [requirement({ studentGroupId: OTHER })],
          homeMembers: [student(1, GROUP_ID), student(2, 'gggggggg-0000-4000-8000-000000000003')],
          teachingMembers: [
            { studentId: student(1, GROUP_ID).id, studentGroupId: OTHER },
            {
              studentId: student(2, 'gggggggg-0000-4000-8000-000000000003').id,
              studentGroupId: OTHER,
            },
          ],
          groups: [
            { id: GROUP_ID, gradeLevel: 6 },
            { id: 'gggggggg-0000-4000-8000-000000000003', gradeLevel: 7 },
            { id: OTHER, gradeLevel: null },
          ],
        });
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        expect(postedPayload().requirements[0]).toMatchObject({
          minGradeLevel: 6,
          maxGradeLevel: 7,
        });
      });

      it('falls back to the group own year when no member carries one', async () => {
        arrange({
          homeMembers: [{ id: student(1, GROUP_ID).id, studentGroupId: null }],
          groups: [{ id: GROUP_ID, gradeLevel: 4 }],
        });
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        expect(postedPayload().requirements[0]).toMatchObject({
          minGradeLevel: 4,
          maxGradeLevel: 4,
        });
      });

      it('sends no span at all when nothing carries a year', async () => {
        // Null, not a guess: the engine reads it as "nothing to check against"
        // and lets the group into any room rather than none.
        arrange({ groups: [{ id: GROUP_ID, gradeLevel: null }] });
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        expect(postedPayload().requirements[0]).toMatchObject({
          minGradeLevel: null,
          maxGradeLevel: null,
        });
      });

      it('passes each room own limits through untouched', async () => {
        arrange({
          rooms: [
            {
              id: ROOM_ID,
              capacity: 28,
              roomTypeId: 'room-type-lab',
              minGradeLevel: 4,
              maxGradeLevel: 6,
            },
          ],
        });
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());
        const payload = postedPayload();

        expect(payload.rooms[0]).toMatchObject({
          capacity: 28,
          minGradeLevel: 4,
          maxGradeLevel: 6,
        });
        // Its type under the token a requirement needing that type carries.
        expect(payload.rooms[0].type).toBe(payload.requirements[0].requiredRoomType);
      });
    });

    it('counts a teaching group size as its distinct members, not zero', async () => {
      // Ma71 has no home-class members at all — its size must come from the
      // membership rows, and a student in both kinds must not count twice for
      // the home class either.
      const MA71 = '99999999-9999-4999-8999-999999999999';
      arrange({
        requirements: [
          requirement({ studentGroupId: MA71 }),
        ],
        homeMembers: [],
        teachingMembers: [
          { studentId: 'aaaaaaa1-0000-4000-8000-000000000001', studentGroupId: MA71 },
          { studentId: 'aaaaaaa2-0000-4000-8000-000000000002', studentGroupId: MA71 },
          { studentId: 'aaaaaaa3-0000-4000-8000-000000000003', studentGroupId: MA71 },
        ],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(postedPayload().requirements[0].studentGroupSize).toBe(3);
    });

    it('sends an uppdrag’s slot only to its own läsår, and every slot no uppdrag holds', async () => {
      // A duty is per läsår and its weekly UNAVAILABLE row is not: next
      // year's APT recorded in May must not block this year's re-generation,
      // and last year's rastvakt must not block this one.
      arrange({
        constraints: [
          constraintRow({ id: 'c-plain', userId: TEACHER_ID, dayOfWeek: 1 }),
          constraintRow({ id: 'c-this', userId: TEACHER_ID, dayOfWeek: 2, teacherDutySlot: { teacherDuty: { academicYearId: ACADEMIC_YEAR } } }),
          constraintRow({ id: 'c-next', userId: TEACHER_ID, dayOfWeek: 3, teacherDutySlot: { teacherDuty: { academicYearId: 'next-year' } } }),
          // A dated uppdrag of this year: its time still blocks the weekly
          // master all year (duty-slot-year.ts), only its own läsår.
          constraintRow({
            id: 'c-dated',
            userId: TEACHER_ID,
            dayOfWeek: 4,
            teacherDutySlot: { teacherDuty: { academicYearId: ACADEMIC_YEAR, validFrom: new Date('2027-01-07T00:00:00.000Z') } },
          }),
        ],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(postedPayload().constraints.map((c) => c.dayOfWeek).sort()).toEqual([1, 2, 4]);
    });

    it('formats date-bound constraints as YYYY-MM-DD', async () => {
      arrange({
        constraints: [
          constraintRow({
            userId: TEACHER_ID,
            date: new Date('2026-12-24T00:00:00.000Z'),
          }),
        ],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());
      const [constraint] = postedPayload().constraints;

      expect(constraint).toMatchObject({
        dayOfWeek: 1,
        date: '2026-12-24',
        startTime: '08:00:00',
        endTime: '09:00:00',
        kind: 'UNAVAILABLE',
      });
      expect(constraint.id).not.toBe('constraint-real-id');
    });

    it('sends the school’s saved lunch rules, so every admin generates the same week', async () => {
      // They used to live in one browser's localStorage: a colleague pressing
      // generate ran under different rules and nothing said so.
      arrange({
        lunchSettings: {
          lunchEnabled: true,
          lunchStartTime: eightAm,
          lunchEndTime: nineAm,
          lunchMinutes: 30,
          diningSeats: 180,
          maxLessonsPerDayPerGroup: 7,
        },
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(postedPayload().rules).toEqual({
        lunchStartTime: '08:00:00',
        lunchEndTime: '09:00:00',
        lunchMinutes: 30,
        diningSeats: 180,
        maxLessonsPerDayPerGroup: 7,
      });
    });

    it('reads a switched-off lunch as no lunch rule, not as a zero-minute one', async () => {
      arrange({
        lunchSettings: {
          lunchEnabled: false,
          lunchStartTime: eightAm,
          lunchEndTime: nineAm,
          lunchMinutes: 30,
          diningSeats: 180,
          maxLessonsPerDayPerGroup: null,
        },
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      // Nothing left to say once lunch is off, so no rules key at all rather
      // than an empty object that reads as "considered, came to nothing".
      expect(postedPayload()).not.toHaveProperty('rules');
    });

    it('omits the seat count when the school has no limit worth modelling', async () => {
      arrange({
        lunchSettings: {
          lunchEnabled: true,
          lunchStartTime: eightAm,
          lunchEndTime: nineAm,
          lunchMinutes: 30,
          diningSeats: null,
          maxLessonsPerDayPerGroup: null,
        },
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(postedPayload().rules).not.toHaveProperty('diningSeats');
    });

    it('lets a caller’s own rules win over the stored ones', async () => {
      arrange({
        lunchSettings: {
          lunchEnabled: true,
          lunchStartTime: eightAm,
          lunchEndTime: nineAm,
          lunchMinutes: 30,
          diningSeats: 180,
          maxLessonsPerDayPerGroup: null,
        },
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser(), null, {
        lunchMinutes: 45,
      });

      // Body wins whole, not field by field: two half-specified rule sets
      // combining into a third nobody wrote would be worse than either.
      expect(postedPayload().rules).toEqual({ lunchMinutes: 45 });
    });

    it('counts a home class once for the dining hall and a teaching group not at all', async () => {
      // A child eats once. Ma71's students are already counted in 7A, so
      // sending its size too would fill the hall twice with the same children.
      const MA71 = '99999999-9999-4999-8999-999999999999';
      arrange({
        requirements: [
          requirement(),
          requirement({
            id: '88888888-8888-4888-8888-888888888888',
            studentGroupId: MA71,
          }),
        ],
        homeMembers: [
          { id: 'aaaaaaa1-0000-4000-8000-000000000001', studentGroupId: GROUP_ID },
          { id: 'aaaaaaa2-0000-4000-8000-000000000002', studentGroupId: GROUP_ID },
        ],
        teachingMembers: [
          { studentId: 'aaaaaaa1-0000-4000-8000-000000000001', studentGroupId: MA71 },
        ],
        groups: [
          { id: GROUP_ID, gradeLevel: 7, kind: 'CLASS' },
          { id: MA71, gradeLevel: null, kind: 'TEACHING_GROUP' },
        ],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      // The class alone. The teaching group used to be sent with headcount 0
      // and was then owed a mandatory meal of its own by the engine — thirty
      // minutes reserved on Ma71's day for a lunch nobody takes there. Now it
      // is not a group that eats at all; its lessons keep 7A's meal clear
      // through the shared-pupil pair instead.
      expect(postedPayload().groups.map((g: any) => g.lunchHeadcount)).toEqual([2]);
      // The fact belongs to the group, and is carried in exactly one place.
      expect(postedPayload().requirements[0]).not.toHaveProperty("lunchHeadcount");
    });

    it('counts a class that reaches the payload only through a locked lesson', async () => {
      // Its every lesson is placed by hand, so the subtraction leaves it no
      // requirement at all — and it used to fall out of the payload with them,
      // while its thirty children kept eating.
      const HANDPLACED = '77777777-7777-4777-8777-777777777777';
      arrange({
        requirements: [requirement()],
        lockedLessons: [
          {
            id: 'ml-1',
            subjectId: SUBJECT_ID,
            studentGroupId: HANDPLACED,
            teacherId: null,
            coTeacherId: null,
            roomId: null,
            dayOfWeek: 1,
            startTime: eightAm,
            endTime: nineAm,
            extraGroups: [],
          },
        ],
        homeMembers: [
          { id: 'aaaaaaa1-0000-4000-8000-000000000001', studentGroupId: GROUP_ID },
          { id: 'aaaaaaa2-0000-4000-8000-000000000002', studentGroupId: HANDPLACED },
          { id: 'aaaaaaa3-0000-4000-8000-000000000003', studentGroupId: HANDPLACED },
        ],
        groups: [
          { id: GROUP_ID, gradeLevel: null, kind: 'CLASS' },
          { id: HANDPLACED, gradeLevel: null, kind: 'CLASS' },
        ],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(
        postedPayload()
          .groups.map((g: any) => g.lunchHeadcount)
          .sort(),
      ).toEqual([1, 2]);
    });

    it('sends to the hall only the classes whose pupils have a lesson this week', async () => {
      // The register at Kunskapsskolan: twenty-four home classes, none with a
      // requirement of its own, every lesson on teaching groups drawn from two
      // of them. For one release every class of the year ate — 530 children in
      // 115 seats — and the school was told its dining hall could not feed the
      // two classes it was scheduling. A class is at school when the week has
      // a lesson its pupils sit in, on the class or on a teaching group.
      const TG_ID = '66666666-6666-4666-8666-666666666666';
      const IDLE = '55555555-5555-4555-8555-555555555555';
      const HANDPLACED = '77777777-7777-4777-8777-777777777777';
      arrange({
        requirements: [requirement({ studentGroupId: TG_ID })],
        lockedLessons: [
          {
            id: 'ml-1',
            subjectId: SUBJECT_ID,
            studentGroupId: HANDPLACED,
            teacherId: null,
            coTeacherId: null,
            roomId: null,
            dayOfWeek: 1,
            startTime: eightAm,
            endTime: nineAm,
            extraGroups: [],
          },
        ],
        homeMembers: [
          { id: 'aaaaaaa1-0000-4000-8000-000000000001', studentGroupId: GROUP_ID },
          { id: 'aaaaaaa2-0000-4000-8000-000000000002', studentGroupId: GROUP_ID },
          { id: 'aaaaaaa3-0000-4000-8000-000000000003', studentGroupId: IDLE },
          { id: 'aaaaaaa4-0000-4000-8000-000000000004', studentGroupId: IDLE },
          { id: 'aaaaaaa5-0000-4000-8000-000000000005', studentGroupId: IDLE },
          { id: 'aaaaaaa6-0000-4000-8000-000000000006', studentGroupId: HANDPLACED },
        ],
        // One pupil of the first class sits in the teaching group that has
        // the week's only requirement. That is what puts the class at school.
        teachingMembers: [
          { studentId: 'aaaaaaa1-0000-4000-8000-000000000001', studentGroupId: TG_ID },
        ],
        groups: [
          { id: GROUP_ID, gradeLevel: 4, kind: 'CLASS' },
          { id: IDLE, gradeLevel: 5, kind: 'CLASS' },
          { id: HANDPLACED, gradeLevel: 6, kind: 'CLASS' },
          { id: TG_ID, gradeLevel: null, kind: 'TEACHING_GROUP' },
        ],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      // The class with a pupil in the teaching group (two children) and the
      // hand-placed class (one) eat. The idle class, five children strong, is
      // not at school as far as this week knows, and takes no seat.
      expect(
        postedPayload()
          .groups.map((g: any) => g.lunchHeadcount)
          .sort(),
      ).toEqual([1, 2]);
    });

    it('brings a refusal back with real ids, the school\'s names in the text, and the classes named', async () => {
      // The engine names a class only by its anonymous id — in the summary's
      // text and in resourceIds. Both are turned back here: the text says
      // "student group 4A", and the detail carries resourceNames for the page
      // to show under "the classes named here".
      arrange({
        groups: [{ id: GROUP_ID, gradeLevel: 4, kind: 'CLASS', name: '4A' }],
      });
      http.post.mockImplementation((_url: string, payload: any) =>
        of({
          data: {
            requestId: payload.requestId,
            status: 'INFEASIBLE',
            lessons: [],
            conflicts: {
              summary: `Too many lessons for the hours: student group ${payload.groups[0].id} needs more.`,
              summaryCode: 'DEMAND_CLIQUE_HOURS_SHORT',
              summaryParams: { group: payload.groups[0].id, sharingGroups: 2 },
              conflicts: [
                {
                  category: 'DINING_CAPACITY',
                  code: 'LUNCH_CLASSES_FILL_THE_HALL_DAILY',
                  params: { group: payload.groups[0].id, seats: 115 },
                  message: 'The classes named here bring their students to the hall every school day.',
                  requirementIds: [],
                  roomIds: [],
                  constraintIds: [],
                  resourceIds: [payload.groups[0].id],
                },
              ],
            },
          },
        }),
      );

      const result = await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(result.conflicts?.summary).toBe(
        'Too many lessons for the hours: student group 4A needs more.',
      );
      // The VALUES go through the same substitution as the text: a Swedish
      // sentence renders {group} itself, and an anonymous uuid there would
      // name a row that exists in no table. Numbers are left alone.
      expect(result.conflicts?.summaryParams).toEqual({ group: '4A', sharingGroups: 2 });
      expect(result.conflicts?.conflicts[0]).toMatchObject({
        code: 'LUNCH_CLASSES_FILL_THE_HALL_DAILY',
        params: { group: '4A', seats: 115 },
        resourceIds: [GROUP_ID],
        resourceNames: ['4A'],
      });
    });

    it('names every group of the daily maximum’s one line by the name the school gave it', async () => {
      /*
       * The school rules' maximum applies to every class and teaching group on
       * its own, and the engine says it on one line for every group it holds
       * back, naming them by their anonymous ids in resourceIds: a class and a
       * teaching group here. Each comes back as the group the school knows,
       * and the values, which name no group, as they were sent.
       */
      const TEACHING_GROUP = '77777777-7777-4777-8777-777777777777';
      arrange({
        requirements: [
          requirement(),
          requirement({ id: '88888888-8888-4888-8888-888888888888', studentGroupId: TEACHING_GROUP }),
        ],
        groups: [
          { id: GROUP_ID, gradeLevel: 7, kind: 'CLASS', name: '7A' },
          { id: TEACHING_GROUP, gradeLevel: null, kind: 'TEACHING_GROUP', name: 'Spanska 7' },
        ],
        teachingMembers: [
          { studentId: '00000000-0000-4000-8000-900000000000', studentGroupId: TEACHING_GROUP },
        ],
      });
      const message =
        'The school rules allow at most 2 lessons a day for each class and teaching group. ' +
        'That maximum is what makes the week impossible: without it, a timetable exists that ' +
        'keeps every other rule, and in it the groups named here have more lessons than that on some day.';
      http.post.mockImplementation((_url: string, payload: any) =>
        of({
          data: {
            requestId: payload.requestId,
            status: 'INFEASIBLE',
            lessons: [],
            conflicts: {
              summary: 'No timetable satisfies every rule.',
              summaryCode: 'CONFLICT_CORE_SUMMARY',
              summaryParams: {},
              conflicts: [
                {
                  category: 'REQUIREMENT_DEMAND',
                  code: 'GROUP_DAILY_MAXIMUM_CANNOT_BE_KEPT',
                  params: { maxPerDay: 2, measured: 1 },
                  message,
                  requirementIds: [],
                  roomIds: [],
                  constraintIds: [],
                  resourceIds: payload.requirements.map((row: any) => row.studentGroupId),
                },
              ],
            },
          },
        }),
      );

      const result = await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(result.conflicts?.conflicts).toEqual([
        expect.objectContaining({
          code: 'GROUP_DAILY_MAXIMUM_CANNOT_BE_KEPT',
          params: { maxPerDay: 2, measured: 1 },
          message,
          resourceIds: [GROUP_ID, TEACHING_GROUP],
          resourceNames: ['7A', 'Spanska 7'],
        }),
      ]);
    });

    it('names a teacher’s hours by the timplan rows they give, and never the teacher', async () => {
      /*
       * The hours verdict counts one teacher's lessons against the time their
       * frames, the day and their locked lessons leave. A teacher has no name
       * here to give, by design, so the engine's line names the teacher's rows
       * by their anonymous ids in resourceIds, and each comes back as the row
       * the Timplan page shows. The values are numbers and leave as they came.
       */
      const SVENSKA = '99999999-9999-4999-8999-999999999999';
      arrange({
        requirements: [
          requirement({ subject: { requiredRoomTypeId: null, name: 'Matematik' } }),
          requirement({ id: SVENSKA, subjectId: 'svenska', subject: { requiredRoomTypeId: null, name: 'Svenska' } }),
        ],
        groups: [{ id: GROUP_ID, gradeLevel: 7, kind: 'CLASS', name: '7A' }],
      });
      const params = { requirements: 2, demandMinutes: 440, capacityMinutes: 420, days: 1, weekDays: 5 };
      let anonymousTeacher = '';
      http.post.mockImplementation((_url: string, payload: any) => {
        anonymousTeacher = payload.requirements[0].teacherId;
        const rows = payload.requirements.map((row: any) => row.id);
        return of({
          data: {
            requestId: payload.requestId,
            status: 'INFEASIBLE',
            lessons: [],
            conflicts: {
              summary: "Too many lessons for one teacher's hours.",
              summaryCode: 'DEMAND_TEACHER_HOURS_SHORT',
              summaryParams: { teachers: 1 },
              conflicts: [
                {
                  category: 'REQUIREMENT_DEMAND',
                  code: 'DEMAND_TEACHER_LESSONS_EXCEED_ROOM',
                  params,
                  message: 'One teacher gives the lessons of 2 requirements, and they need 440 minutes a week.',
                  requirementIds: rows,
                  roomIds: [],
                  constraintIds: [],
                  resourceIds: rows,
                },
              ],
            },
          },
        });
      });

      const result = await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(result.conflicts?.summaryCode).toBe('DEMAND_TEACHER_HOURS_SHORT');
      expect(result.conflicts?.summaryParams).toEqual({ teachers: 1 });
      expect(result.conflicts?.conflicts).toEqual([
        expect.objectContaining({
          code: 'DEMAND_TEACHER_LESSONS_EXCEED_ROOM',
          params,
          resourceIds: [REQ_ID, SVENSKA],
          resourceNames: ['Matematik för 7A', 'Svenska för 7A'],
        }),
      ]);
      const sent = JSON.stringify(result.conflicts);
      expect(anonymousTeacher).not.toBe('');
      expect(sent).not.toContain(anonymousTeacher);
      expect(sent).not.toContain(TEACHER_ID);
    });

    it('names the gaps by the class, its timplan rows and the lunch, and never the teacher', async () => {
      /*
       * The gaps verdict says which lessons the gaps cannot take, a line per
       * class, teacher or set of rooms. The class's line carries the class in
       * `group` and resourceIds, both anonymous on the way out, and comes back
       * as 7A; the teacher's and the rooms' lines carry the timplan rows, as
       * the hours verdict's does; the lunch's line follows the line it is
       * about. Every value but `group` is a number or the word that picks the
       * sentence's ending, and leaves as it came.
       */
      const SVENSKA = '99999999-9999-4999-8999-999999999999';
      arrange({
        requirements: [
          requirement({ subject: { requiredRoomTypeId: null, name: 'Matematik' } }),
          requirement({ id: SVENSKA, subjectId: 'svenska', subject: { requiredRoomTypeId: null, name: 'Svenska' } }),
        ],
        groups: [{ id: GROUP_ID, gradeLevel: 7, kind: 'CLASS', name: '7A' }],
      });
      const counted = {
        requirements: 2, lessons: 5, shortestMinutes: 90, demandMinutes: 450, days: 4,
        weekDays: 5, shortOf: 'lessons', fitLessons: 4, capacityMinutes: 360,
      };
      let anonymousTeacher = '';
      let anonymousGroup = '';
      http.post.mockImplementation((_url: string, payload: any) => {
        anonymousTeacher = payload.requirements[0].teacherId;
        anonymousGroup = payload.requirements[0].studentGroupId;
        const rows = payload.requirements.map((row: any) => row.id);
        const rooms = payload.rooms.map((room: any) => room.id);
        const line = (code: string, params: object, resourceIds: string[], roomIds: string[] = []) => ({
          category: 'REQUIREMENT_DEMAND',
          code,
          params,
          message: 'Too many lessons for the gaps.',
          requirementIds: rows,
          roomIds,
          constraintIds: [],
          resourceIds,
        });
        return of({
          data: {
            requestId: payload.requestId,
            status: 'INFEASIBLE',
            lessons: [],
            conflicts: {
              summary: 'Too many lessons for the gaps.',
              summaryCode: 'DEMAND_LESSONS_EXCEED_GAPS',
              summaryParams: { resources: 2 },
              conflicts: [
                line('DEMAND_GROUP_LESSONS_EXCEED_GAPS', { group: anonymousGroup, ...counted }, [anonymousGroup]),
                {
                  ...line('LUNCH_BREAK_IS_THE_DIFFERENCE', { lunchMinutes: 30, freeMinutes: 480 }, [anonymousGroup]),
                  category: 'LUNCH_WINDOW',
                  requirementIds: [],
                },
                line('DEMAND_ROOM_LESSONS_EXCEED_GAPS', { rooms: rooms.length, ...counted }, rows, rooms),
              ],
            },
          },
        });
      });

      const result = await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(result.conflicts?.summaryCode).toBe('DEMAND_LESSONS_EXCEED_GAPS');
      expect(result.conflicts?.summaryParams).toEqual({ resources: 2 });
      expect(result.conflicts?.conflicts).toEqual([
        expect.objectContaining({
          code: 'DEMAND_GROUP_LESSONS_EXCEED_GAPS',
          params: { group: '7A', ...counted },
          resourceIds: [GROUP_ID],
          resourceNames: ['7A'],
        }),
        expect.objectContaining({
          code: 'LUNCH_BREAK_IS_THE_DIFFERENCE',
          params: { lunchMinutes: 30, freeMinutes: 480 },
          resourceIds: [GROUP_ID],
          resourceNames: ['7A'],
        }),
        expect.objectContaining({
          code: 'DEMAND_ROOM_LESSONS_EXCEED_GAPS',
          params: { rooms: 1, ...counted },
          resourceIds: [REQ_ID, SVENSKA],
          resourceNames: ['Matematik för 7A', 'Svenska för 7A'],
        }),
      ]);
      const sent = JSON.stringify(result.conflicts);
      expect(anonymousGroup).not.toBe('');
      expect(sent).not.toContain(anonymousGroup);
      expect(anonymousTeacher).not.toBe('');
      expect(sent).not.toContain(anonymousTeacher);
      expect(sent).not.toContain(TEACHER_ID);
    });

    it('names a timplan row by its subject and group, and a room type by its name', async () => {
      // A refusal that said "Timplansposten 8f2c…" named something a rektor
      // could not look up. A timplan row carries no name of its own, so it is
      // named the way the Timplan page names it — and the subject and the
      // room type ride along on joins the fetch was already making.
      arrange({
        requirements: [
          requirement({ subject: { requiredRoomTypeId: 'room-type-lab', name: 'Matematik', requiredRoomType: { name: 'Slöjdsal' } } }),
        ],
        groups: [{ id: GROUP_ID, gradeLevel: 4, kind: 'CLASS', name: '4A' }],
      });
      http.post.mockImplementation((_url: string, payload: any) =>
        of({
          data: {
            requestId: payload.requestId,
            status: 'INFEASIBLE',
            lessons: [],
            conflicts: {
              summary: `No room fits requirement ${payload.requirements[0].id}.`,
              summaryCode: 'ROOM_NONE_ELIGIBLE_FOR_REQUIREMENT',
              summaryParams: {
                requirement: payload.requirements[0].id,
                roomType: payload.requirements[0].requiredRoomType,
              },
              conflicts: [],
            },
          },
        }),
      );

      const result = await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(result.conflicts?.summaryParams).toEqual({
        requirement: 'Matematik för 4A',
        roomType: 'Slöjdsal',
      });
      expect(result.conflicts?.summary).toBe('No room fits requirement Matematik för 4A.');
    });

    describe('ämnesfördelning', () => {
      const idrott = (subject: Record<string, unknown>, own: Record<string, unknown> = {}) =>
        requirement({
          lessonsPerWeek: 2,
          subject: { requiredRoomTypeId: null, ...subject },
          ...own,
        });

      it('sends no rule and no locked days for a subject without a rule, locks or not', async () => {
        // A school that has written no rule sends the payload it always sent,
        // which is what lets this gateway meet an engine that predates the keys.
        arrange({ requirements: [idrott({})], lockedLessons: [lockedLesson()] });
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        const sent = postedPayload().requirements[0]!;
        expect(sent).not.toHaveProperty('maxLessonsPerDay');
        expect(sent).not.toHaveProperty('minDaysBetween');
        expect(sent).not.toHaveProperty('lockedDays');
      });

      it('sends the subject’s rule and the weekday of EVERY locked lesson of the row', async () => {
        // Tuesday every week covers a lesson of demand and is subtracted; the
        // odd-week Thursday covers none (its weeks are not the row's) and is
        // still on Thursday in the weeks it runs. Both are where the class
        // has idrott, and the engine is told so. Another subject's lock, and
        // another class's lock in the same subject, are no part of the row.
        arrange({
          requirements: [idrott({ maxLessonsPerDay: 1, minDaysBetween: 2 })],
          lockedLessons: [
            lockedLesson({ id: 'tue', dayOfWeek: 2 }),
            lockedLesson({ id: 'thu', dayOfWeek: 4, recurrence: 'ODD_WEEKS' }),
            lockedLesson({ id: 'other-subject', dayOfWeek: 1, subjectId: 'another-subject' }),
            lockedLesson({ id: 'other-class', dayOfWeek: 3, studentGroupId: EXTRA_GROUP_ID }),
          ],
        });
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        expect(postedPayload().requirements[0]).toMatchObject({
          lessonsPerWeek: 1,
          maxLessonsPerDay: 1,
          minDaysBetween: 2,
          lockedDays: [2, 4],
        });
      });

      it('sends a rule with nothing locked without a lockedDays key', async () => {
        arrange({ requirements: [idrott({ minDaysBetween: 2 })] });
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        const sent = postedPayload().requirements[0]!;
        expect(sent).toMatchObject({ minDaysBetween: 2 });
        expect(sent).not.toHaveProperty('maxLessonsPerDay');
        expect(sent).not.toHaveProperty('lockedDays');
      });

      it('a row with its own rule is held to it and not to its subject’s', async () => {
        arrange({
          requirements: [
            idrott(
              { maxLessonsPerDay: 1, minDaysBetween: 2 },
              { ownDistribution: true, maxLessonsPerDay: 2, minDaysBetween: null },
            ),
          ],
        });
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        const sent = postedPayload().requirements[0]!;
        expect(sent).toMatchObject({ maxLessonsPerDay: 2 });
        expect(sent).not.toHaveProperty('minDaysBetween');
      });

      it('a row whose own rule is none sends none, whatever its subject says', async () => {
        arrange({
          requirements: [
            idrott(
              { maxLessonsPerDay: 1, minDaysBetween: 2 },
              { ownDistribution: true, maxLessonsPerDay: null, minDaysBetween: null },
            ),
          ],
          lockedLessons: [lockedLesson()],
        });
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        const sent = postedPayload().requirements[0]!;
        expect(sent).not.toHaveProperty('maxLessonsPerDay');
        expect(sent).not.toHaveProperty('minDaysBetween');
        expect(sent).not.toHaveProperty('lockedDays');
      });
    });

    describe('lärarnas arbetstid', () => {
      /*
       * The teacher's own lunch and rest, which nothing in this payload could
       * express before: an AvailabilityConstraint with resourceKind TEACHER
       * CLOSES hours, and there was no way to say a teacher is OWED anything.
       */
      const WORK_RULE_ID = '77777777-aaaa-4aaa-8aaa-777777777777';
      const workRule = (overrides: Record<string, unknown> = {}) => ({
        id: WORK_RULE_ID,
        userId: TEACHER_ID,
        lunchMinutes: 30,
        lunchStartTime: new Date('1970-01-01T10:30:00.000Z'),
        lunchEndTime: new Date('1970-01-01T13:30:00.000Z'),
        minDailyRestMinutes: 660,
        // As the columns default (20261123090000): no cap and no wish. The
        // database answers null for them, never a missing field.
        maxTeachingMinutesPerDay: null,
        preferredFreeDayOfWeek: null,
        ...overrides,
      });

      it('forwards it with BOTH ids anonymised, the teacher through the teachers\u2019 own map', async () => {
        /*
         * The teacher id has to be the SAME token the requirement carries, or the
         * engine cannot tell that this rule and that lesson concern one person —
         * and it must not be the real one, because `Users` is the PII table and
         * the whole point of this proxy is that no row of it crosses.
         */
        arrange({ workRules: [workRule()] });
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());
        const payload = http.post.mock.calls[0]![1] as any;

        expect(payload.teacherWorkRules).toHaveLength(1);
        expect(payload.teacherWorkRules[0]).toEqual({
          id: expect.any(String),
          teacherId: payload.requirements[0].teacherId,
          lunchMinutes: 30,
          lunchStartTime: '10:30:00',
          lunchEndTime: '13:30:00',
          minDailyRestMinutes: 660,
        });
        expect(payload.teacherWorkRules[0].id).not.toBe(WORK_RULE_ID);
        expect(payload.teacherWorkRules[0].teacherId).not.toBe(TEACHER_ID);
        // Belt and braces: neither real id appears anywhere in the payload.
        expect(JSON.stringify(payload)).not.toContain(TEACHER_ID);
        expect(JSON.stringify(payload)).not.toContain(WORK_RULE_ID);
      });

      it('sends a rule with no lunch as three nulls, not as zeroes', async () => {
        // Null is "this rule does not apply". Zero minutes inside 00:00-00:00 is
        // a lunch the engine would have to place, and place nowhere.
        arrange({
          workRules: [
            workRule({ lunchMinutes: null, lunchStartTime: null, lunchEndTime: null }),
          ],
        });
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());
        const payload = http.post.mock.calls[0]![1] as any;

        expect(payload.teacherWorkRules[0]).toMatchObject({
          lunchMinutes: null,
          lunchStartTime: null,
          lunchEndTime: null,
          minDailyRestMinutes: 660,
        });
      });

      it('leaves out a rule whose teacher this year never mentions', async () => {
        // No requirement, no fixed lesson and no reservation names them, so the
        // engine has no lesson of theirs to hang an assumption on — and minting a
        // teacher token here would send a rule about somebody the payload never
        // mentions, matchable against nothing.
        arrange({
          workRules: [workRule({ id: 'orphan-rule', userId: 'teacher-who-teaches-nothing' })],
        });
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());
        const payload = http.post.mock.calls[0]![1] as any;

        expect(payload.teacherWorkRules).toEqual([]);
      });

      it('reads none of another school\u2019s, through the year -> school hop', async () => {
        arrange({ workRules: [workRule({ schoolId: OTHER_SCHOOL })] });
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());
        const payload = http.post.mock.calls[0]![1] as any;

        expect(payload.teacherWorkRules).toEqual([]);
      });

      it('brings a refusal back naming the rule row, and naming no person', async () => {
        /*
         * The reason `workRuleAnonMap` is kept while the teacher map is thrown
         * away. A refusal here is ABOUT a teacher, and no person's name may enter
         * the stored conflicts — `OptimizationJobs.conflicts` is a denormalised
         * copy no rename or deletion would ever reach. So the rule's id is the
         * one thing the school can look the refusal up by, and forwarded
         * unreversed it is a uuid that exists in no table in either id space.
         */
        arrange({ workRules: [workRule()] });
        http.post.mockImplementation((_url: string, payload: any) =>
          of({
            data: {
              requestId: payload.requestId,
              status: 'INFEASIBLE',
              lessons: [],
              conflicts: {
                summary: 'blocked',
                summaryCode: 'CONFLICT_CORE_SUMMARY',
                summaryParams: {},
                conflicts: [
                  {
                    category: 'AVAILABILITY',
                    code: 'TEACHER_LUNCH_HAS_NOWHERE_TO_GO',
                    params: { rule: payload.teacherWorkRules[0].id, minutes: 30 },
                    message: `Rule ${payload.teacherWorkRules[0].id} leaves no lunch.`,
                    requirementIds: [],
                    roomIds: [],
                    constraintIds: [],
                    resourceIds: [payload.teacherWorkRules[0].id],
                  },
                ],
              },
            },
          }),
        );

        const detail = (await service.triggerScheduling(ACADEMIC_YEAR, testUser()))
          .conflicts!.conflicts[0]!;

        expect(detail.params.rule).toBe(WORK_RULE_ID);
        expect(detail.message).toBe(`Rule ${WORK_RULE_ID} leaves no lunch.`);
        expect(detail.resourceIds).toEqual([WORK_RULE_ID]);
        // And nobody is named. A rule row has no name of its own and the teacher
        // deliberately never reaches `nameById`, so the list stays empty rather
        // than acquiring a person.
        expect(detail.resourceNames).toEqual([]);
      });
    });

    describe('lärarens dag', () => {
      /*
       * The daily cap and the free-day wish ride on the work rule; deltid in
       * days rides on the post, its own list and its own id space, because the
       * number is HR data (work-days.ts). None of the three may change one byte
       * of a school's payload until somebody sets it.
       */
      const WORK_RULE_ID = '77777777-bbbb-4bbb-8bbb-777777777777';
      const POST_ID = '99999999-bbbb-4bbb-8bbb-999999999999';
      const CO_TEACHER = '88888888-bbbb-4bbb-8bbb-888888888888';
      const workRule = (overrides: Record<string, unknown> = {}) => ({
        id: WORK_RULE_ID,
        userId: TEACHER_ID,
        lunchMinutes: null,
        lunchStartTime: null,
        lunchEndTime: null,
        minDailyRestMinutes: null,
        maxTeachingMinutesPerDay: null,
        preferredFreeDayOfWeek: null,
        ...overrides,
      });
      const post = (overrides: Record<string, unknown> = {}) => ({
        id: POST_ID,
        userId: TEACHER_ID,
        maxTeachingDaysPerWeek: 4,
        ...overrides,
      });

      it('sends a rule’s cap and wish under the engine’s names, and a rule holding only them', async () => {
        arrange({ workRules: [workRule({ maxTeachingMinutesPerDay: 270, preferredFreeDayOfWeek: 5 })] });
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());
        const [rule] = postedPayload().teacherWorkRules;

        // No lunch, no rest: the four sent as nulls, as a rule with only a
        // rest sends its lunch, and the two new ones as numbers.
        expect(rule).toEqual({
          id: expect.any(String),
          teacherId: postedPayload().requirements[0]!.teacherId,
          lunchMinutes: null,
          lunchStartTime: null,
          lunchEndTime: null,
          minDailyRestMinutes: null,
          maxTeachingMinutesPerDay: 270,
          preferredFreeDay: 5,
        });
      });

      it('sends neither key, not even as null, for a rule that sets neither', async () => {
        arrange({ workRules: [workRule({ minDailyRestMinutes: 660 })] });
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());
        const [rule] = postedPayload().teacherWorkRules;

        expect(Object.keys(rule!)).not.toContain('maxTeachingMinutesPerDay');
        expect(Object.keys(rule!)).not.toContain('preferredFreeDay');
      });

      it('sends a post’s day limit with both ids anonymised, the teacher through the teachers’ own map', async () => {
        arrange({ posts: [post()] });
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser({ channel: 'WEB' }));
        const payload = postedPayload();

        expect(payload.teacherDayLimits).toEqual([
          {
            id: expect.any(String),
            teacherId: payload.requirements[0]!.teacherId,
            maxTeachingDaysPerWeek: 4,
            lockedWeekdays: [[]],
          },
        ]);
        expect(payload.teacherDayLimits![0]!.id).not.toBe(POST_ID);
        expect(JSON.stringify(payload)).not.toContain(TEACHER_ID);
        expect(JSON.stringify(payload)).not.toContain(POST_ID);
        // Read under the starter's own session, in the year: the where names
        // the year and asks only for posts that set a limit.
        expect(tx.teacherEmployment.findMany).toHaveBeenCalledWith({
          where: { academicYearId: ACADEMIC_YEAR, maxTeachingDaysPerWeek: { not: null } },
          select: { id: true, userId: true, maxTeachingDaysPerWeek: true },
        });
        // A post's days are HR, and this transaction read them: the Läslogg
        // names the teacher, by their Users id.
        expect(recordedReads(tx)).toEqual([{ kind: 'EMPLOYMENT', channel: 'WEB', ids: [TEACHER_ID] }]);
      });

      /*
       * The weekdays the teacher's fixed lessons hold, one set per kind of
       * week (common/teacher-day.ts, lockedWeekdaySets): what the engine holds
       * the limit against now that it no longer reads every weekday any of
       * them holds as spent in every week.
       */
      describe('the weekdays the teacher’s fixed lessons hold, week by week', () => {
        const limit = () => postedPayload().teacherDayLimits![0]!;
        const at = (day: string) => new Date(`${day}T00:00:00.000Z`);

        it('sends one week holding no weekday for a teacher with no fixed lesson', async () => {
          arrange({ posts: [post()] });
          echoEngine();

          await service.triggerScheduling(ACADEMIC_YEAR, testUser());

          expect(limit().lockedWeekdays).toEqual([[]]);
        });

        it('sends the odd weeks’ Monday and Tuesday and the even weeks’ Wednesday and Thursday apart, not as four days', async () => {
          arrange({
            posts: [post({ maxTeachingDaysPerWeek: 2 })],
            lockedLessons: [
              lockedLesson({ id: 'even-thu', dayOfWeek: 4, recurrence: 'EVEN_WEEKS' }),
              lockedLesson({ id: 'odd-mon', dayOfWeek: 1, recurrence: 'ODD_WEEKS' }),
              lockedLesson({ id: 'even-wed', dayOfWeek: 3, recurrence: 'EVEN_WEEKS' }),
              lockedLesson({ id: 'odd-tue', dayOfWeek: 2, recurrence: 'ODD_WEEKS' }),
            ],
          });
          echoEngine();

          await service.triggerScheduling(ACADEMIC_YEAR, testUser());

          expect(limit()).toMatchObject({ maxTeachingDaysPerWeek: 2, lockedWeekdays: [[1, 2], [3, 4]] });
          // The fixed placements themselves still carry no weeks.
          expect(Object.keys(postedPayload().fixedLessons[0]!)).not.toContain('recurrence');
        });

        it('reads the weeks of the läsår only, its dates read when a post has a limit and not otherwise', async () => {
          // An undated Monday and a Tuesday over the whole year, on a post of
          // one day: every week of the year holds both. Unbounded, a week
          // after the year would add Monday alone, inside a set over the
          // limit, and hold the engine to a week the school does not have.
          arrange({
            posts: [post({ maxTeachingDaysPerWeek: 1 })],
            lockedLessons: [
              lockedLesson({ id: 'mon', dayOfWeek: 1 }),
              lockedLesson({ id: 'tue', dayOfWeek: 2, startDate: at('2026-08-17'), endDate: at('2027-06-11') }),
            ],
          });
          tx.academicYear.findUnique.mockResolvedValue({ startDate: at('2026-08-17'), endDate: at('2027-06-11') } as never);
          echoEngine();

          await service.triggerScheduling(ACADEMIC_YEAR, testUser());

          expect(limit().lockedWeekdays).toEqual([[1, 2]]);
          expect(tx.academicYear.findUnique).toHaveBeenCalledWith({
            where: { id: ACADEMIC_YEAR },
            select: { startDate: true, endDate: true },
          });
        });

        it('reads no year for a school whose posts set no days', async () => {
          arrange({ workRules: [workRule({ minDailyRestMinutes: 660 })] });
          echoEngine();

          await service.triggerScheduling(ACADEMIC_YEAR, testUser());

          expect(postedPayload().teacherDayLimits ?? []).toEqual([]);
          expect(tx.academicYear.findUnique).not.toHaveBeenCalledWith(
            expect.objectContaining({ select: { startDate: true, endDate: true } }),
          );
        });

        it('reads a term’s dates off the row: the autumn’s days and the spring’s, never one week', async () => {
          const autumn = { startDate: at('2026-08-17'), endDate: at('2026-12-18') };
          const spring = { startDate: at('2027-01-11'), endDate: at('2027-06-11') };
          arrange({
            posts: [post({ maxTeachingDaysPerWeek: 2 })],
            lockedLessons: [
              lockedLesson({ id: 'mon', dayOfWeek: 1, ...autumn }),
              lockedLesson({ id: 'tue', dayOfWeek: 2, ...autumn }),
              lockedLesson({ id: 'thu', dayOfWeek: 4, ...spring }),
              lockedLesson({ id: 'fri', dayOfWeek: 5, ...spring }),
            ],
          });
          echoEngine();

          await service.triggerScheduling(ACADEMIC_YEAR, testUser());

          expect(limit().lockedWeekdays).toEqual([
            [1, 2],
            [4, 5],
          ]);
        });

        it('counts the lessons the teacher co-teaches, and no colleague’s, nor one that takes no time', async () => {
          arrange({
            // Demand the four do not cover, so the engine is asked.
            requirements: [requirement({ lessonsPerWeek: 10 })],
            posts: [post({ maxTeachingDaysPerWeek: 5 })],
            lockedLessons: [
              lockedLesson({ id: 'led', dayOfWeek: 1 }),
              lockedLesson({ id: 'co', dayOfWeek: 3, teacherId: CO_TEACHER, coTeacherId: TEACHER_ID }),
              lockedLesson({ id: 'colleague', dayOfWeek: 4, teacherId: CO_TEACHER }),
              lockedLesson({ id: 'empty', dayOfWeek: 5, startTime: nineAm, endTime: nineAm }),
            ],
          });
          echoEngine();

          await service.triggerScheduling(ACADEMIC_YEAR, testUser());

          expect(limit().lockedWeekdays).toEqual([[1, 3]]);
        });

        it('holds each post against its own teacher’s lessons and its own number of days', async () => {
          // Monday every week and Tuesday the odd ones, co-taught, and a
          // Friday of the lead's own: the lead's even weeks lie inside the odd
          // ones on a post of three; the co-teacher's even weeks' Monday does
          // not lie inside a set their post of one allows, and is said too.
          arrange({
            requirements: [requirement({ coTeacherId: CO_TEACHER, lessonsPerWeek: 10 })],
            posts: [post({ maxTeachingDaysPerWeek: 3 }), post({ id: 'post-of-co', userId: CO_TEACHER, maxTeachingDaysPerWeek: 1 })],
            lockedLessons: [
              lockedLesson({ id: 'mon', dayOfWeek: 1, coTeacherId: CO_TEACHER }),
              lockedLesson({ id: 'tue', dayOfWeek: 2, coTeacherId: CO_TEACHER, recurrence: 'ODD_WEEKS' }),
              lockedLesson({ id: 'own-fri', dayOfWeek: 5 }),
            ],
          });
          echoEngine();

          await service.triggerScheduling(ACADEMIC_YEAR, testUser());

          expect(postedPayload().teacherDayLimits!.map((sent) => [sent.maxTeachingDaysPerWeek, sent.lockedWeekdays])).toEqual([
            [3, [[1, 2, 5]]],
            [1, [[1], [1, 2]]],
          ]);
        });
      });

      it('reads only this year’s posts that set a limit', async () => {
        arrange({
          posts: [
            post({ id: 'post-without-a-limit', maxTeachingDaysPerWeek: null }),
            post({ id: 'post-of-another-year', academicYearId: OTHER_YEAR }),
          ],
        });
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        expect(Object.keys(postedPayload())).not.toContain('teacherDayLimits');
        expect(recordedReads(tx)).toEqual([]);
      });

      it('sends no key and writes no read when nobody’s post limits their days', async () => {
        arrange();
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        expect(Object.keys(postedPayload())).not.toContain('teacherDayLimits');
        expect(recordedReads(tx)).toEqual([]);
      });

      it('leaves out a limit whose teacher this year never mentions, says so, and logs no read of it', async () => {
        arrange({ posts: [post({ userId: 'teacher-who-teaches-nothing' })] });
        echoEngine();
        const warn = warnings();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        expect(Object.keys(postedPayload())).not.toContain('teacherDayLimits');
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(`day limit on post ${POST_ID}`));
        expect(recordedReads(tx)).toEqual([]);
      });

      it('sends the same limits whoever starts the run, HR-läs or not', async () => {
        // The rule is the same for every reader; only the wording is masked,
        // and that when the run is read.
        const limitsFor = async (user: ReturnType<typeof testUser>) => {
          http.post.mockClear();
          arrange({ posts: [post()] });
          echoEngine();
          await service.triggerScheduling(ACADEMIC_YEAR, user);
          return postedPayload().teacherDayLimits!.map(({ maxTeachingDaysPerWeek }) => maxTeachingDaysPerWeek);
        };

        expect(await limitsFor(testUser({ adminProfile: 'REKTOR' } as never))).toEqual([4]);
        expect(await limitsFor(testUser({ adminProfile: 'SCHEMALAGGARE', hrRead: false } as never))).toEqual([4]);
      });

      describe('a refusal about the days', () => {
        const refuseOverTheDays = (summary?: { code: string; params: (payload: any) => object }) =>
          answerWithConflicts((payload) => ({
            summary: 'blocked',
            summaryCode: summary?.code ?? 'CONFLICT_CORE_SUMMARY',
            summaryParams: summary?.params(payload) ?? {},
            conflicts: [
              {
                category: 'TEACHER_OVERLAP',
                code: 'TEACHER_WORK_DAYS_CANNOT_BE_KEPT',
                params: { limit: payload.teacherDayLimits[0].id, days: 4 },
                message: `The teacher's post ${payload.teacherDayLimits[0].id} allows teaching on at most 4 days a week …`,
                requirementIds: [],
                roomIds: [],
                constraintIds: [],
                resourceIds: [payload.teacherDayLimits[0].id],
              },
              {
                category: 'AVAILABILITY',
                code: 'AVAIL_SOMETHING_ELSE',
                // A sentence about something else that happens to say the post.
                params: { count: 1 },
                message: `See ${payload.teacherDayLimits[0].id}.`,
                requirementIds: [],
                roomIds: [],
                constraintIds: [],
                resourceIds: [],
              },
            ],
          }));

        it('comes back without its figure, the post named as a row, and its teacher kept for the server', async () => {
          arrange({ posts: [post()] });
          refuseOverTheDays();

          const conflicts = (await service.triggerScheduling(ACADEMIC_YEAR, testUser())).conflicts!;
          const [days, other] = conflicts.conflicts;

          expect(days).toMatchObject({
            category: 'TEACHER_OVERLAP',
            code: 'TEACHER_WORK_DAYS_CANNOT_BE_KEPT',
            params: { limit: POST_ID },
            message: WORK_DAYS_HIDDEN_MESSAGE,
            // The resource a deltid sentence is about is the person — never
            // named here, and never stored (the job keeps no ids).
            resourceIds: [TEACHER_ID],
            resourceNames: [],
            subjectIds: [TEACHER_ID],
          });
          expect(JSON.stringify(days)).not.toMatch(/"days"|4 days/);
          // Another sentence is left as it was, the post's id turned back.
          expect(other!.message).toBe(`See ${POST_ID}.`);
          expect(other).not.toHaveProperty('subjectIds');
          expect(conflicts).not.toHaveProperty('summarySubjectIds');
          expect(conflicts.summary).toBe('blocked');
        });

        it('holds a summary about the days to the same rule', async () => {
          arrange({ posts: [post()] });
          refuseOverTheDays({
            code: 'TEACHER_WORK_DAYS_CANNOT_BE_KEPT',
            params: (payload) => ({ limit: payload.teacherDayLimits[0].id, days: 4 }),
          });

          const conflicts = (await service.triggerScheduling(ACADEMIC_YEAR, testUser())).conflicts!;

          expect(conflicts).toMatchObject({
            summary: WORK_DAYS_HIDDEN_MESSAGE,
            summaryCode: 'TEACHER_WORK_DAYS_CANNOT_BE_KEPT',
            summarySubjectIds: [TEACHER_ID],
          });
          expect(conflicts.summaryParams).toEqual({ limit: POST_ID });
        });

        it('keeps no teacher for a sentence naming a post the run did not send', async () => {
          arrange({ posts: [post()] });
          answerWithConflicts(() => ({
            summary: 'blocked',
            summaryCode: 'CONFLICT_CORE_SUMMARY',
            summaryParams: {},
            conflicts: [
              {
                category: 'TEACHER_OVERLAP',
                code: 'TEACHER_WORK_DAYS_CANNOT_BE_KEPT',
                params: { limit: 'cccccccc-3333-4333-8333-cccccccccccc', days: 4 },
                message: '…',
                requirementIds: [],
                roomIds: [],
                constraintIds: [],
                resourceIds: [],
              },
            ],
          }));

          const [days] = (await service.triggerScheduling(ACADEMIC_YEAR, testUser())).conflicts!.conflicts;

          expect(days!.subjectIds).toEqual([]);
          expect(days!.params).toEqual({ limit: 'cccccccc-3333-4333-8333-cccccccccccc' });
        });
      });

      describe('the free-day wishes the run did not keep', () => {
        it('names a wish a generated lesson of theirs breaks', async () => {
          // The echo places every lesson on Monday.
          arrange({ workRules: [workRule({ preferredFreeDayOfWeek: 1 })] });
          echoEngine();

          const { notes } = await service.triggerScheduling(ACADEMIC_YEAR, testUser());

          expect(notes).toEqual([
            expect.objectContaining({
              category: 'AVAILABILITY',
              code: 'TEACHER_FREE_DAY_WISH_NOT_KEPT',
              params: { day: 1 },
              resourceIds: [WORK_RULE_ID],
              resourceNames: [],
              // Whose wish, for the job view to name when the run is read.
              subjectIds: [TEACHER_ID],
            }),
          ]);
        });

        it('names a wish a co-taught lesson breaks', async () => {
          arrange({
            requirements: [requirement({ coTeacherId: CO_TEACHER })],
            workRules: [workRule({ userId: CO_TEACHER, preferredFreeDayOfWeek: 1 })],
          });
          echoEngine();

          const { notes } = await service.triggerScheduling(ACADEMIC_YEAR, testUser());

          // About the co-teacher, whose wish it is, and not the lead.
          expect(notes!.map((note) => note.subjectIds)).toEqual([[CO_TEACHER]]);
        });

        it('names a wish a kept lesson breaks: the lock is the school’s, and so is the day', async () => {
          // lockedLesson() is the teacher's, on Tuesday.
          arrange({ lockedLessons: [lockedLesson()], workRules: [workRule({ preferredFreeDayOfWeek: 2 })] });
          echoEngine();

          const { notes } = await service.triggerScheduling(ACADEMIC_YEAR, testUser());

          expect(notes!.map((note) => note.params)).toEqual([{ day: 2 }]);
        });

        it('names a wish a lesson placed by hand while the solver ran breaks', async () => {
          // The fetch saw no Friday; the timetable the run leaves has one,
          // placed by hand during the solve and kept by the delete.
          arrange({
            workRules: [workRule({ preferredFreeDayOfWeek: 5 })],
            keptAfterSolve: [lockedLesson({ dayOfWeek: 5 })],
          });
          echoEngine();

          const { notes } = await service.triggerScheduling(ACADEMIC_YEAR, testUser());

          expect(notes!.map((note) => note.params)).toEqual([{ day: 5 }]);
        });

        it('says nothing of a kept lesson that is gone from the timetable the run leaves', async () => {
          // Tuesday's lesson was locked when the fetch read it, and unlocked
          // (so deleted by the run) or deleted by hand while the solver ran.
          arrange({
            lockedLessons: [lockedLesson()],
            keptAfterSolve: [],
            workRules: [workRule({ preferredFreeDayOfWeek: 2 })],
          });
          echoEngine();

          await expect(service.triggerScheduling(ACADEMIC_YEAR, testUser())).resolves.toMatchObject({ notes: [] });
        });

        it('reads a parked lesson as on no day', async () => {
          arrange({
            keptAfterSolve: [lockedLesson({ isParked: true })],
            workRules: [workRule({ preferredFreeDayOfWeek: 2 })],
          });
          echoEngine();

          await expect(service.triggerScheduling(ACADEMIC_YEAR, testUser())).resolves.toMatchObject({ notes: [] });
        });

        it('reads a week whose every lesson is hand-placed against its kept lessons', async () => {
          arrange({
            requirements: [requirement({ lessonsPerWeek: 1 })],
            lockedLessons: [lockedLesson()],
            workRules: [workRule({ preferredFreeDayOfWeek: 2 })],
          });

          const { notes } = await service.triggerScheduling(ACADEMIC_YEAR, testUser());

          expect(http.post).not.toHaveBeenCalled();
          expect(notes).toHaveLength(1);
        });

        it('keeps a wish on a day the teacher teaches nothing', async () => {
          arrange({ workRules: [workRule({ preferredFreeDayOfWeek: 5 })] });
          echoEngine();

          await expect(service.triggerScheduling(ACADEMIC_YEAR, testUser())).resolves.toMatchObject({ notes: [] });
        });

        it('says nothing of wishes when the run wrote no timetable', async () => {
          arrange({ workRules: [workRule({ preferredFreeDayOfWeek: 1 })], lockedLessons: [lockedLesson({ dayOfWeek: 1 })] });
          answerWithConflicts(() => ({ summary: 'no', summaryCode: 'CONFLICT_NO_CORE', summaryParams: {}, conflicts: [] }));

          await expect(service.triggerScheduling(ACADEMIC_YEAR, testUser())).resolves.toMatchObject({ notes: [] });
        });
      });
    });

    it('brings a refusal back naming a reservation and a room that are real rows', async () => {
      /*
       * Two ids used to leave this method meaning nothing.
       *
       * The anonymous constraint was minted with a bare randomUUID(), recorded
       * in no map — so the id the engine put in its sentence and in
       * `constraintIds` existed in NO table in either id space, and could not
       * be looked up by the school, by this gateway, or by a developer holding
       * the database. And `resourceIds` was read through the GROUP map alone,
       * although a reservation puts whatever it is about in there: a teacher's
       * or a room's anonymous uuid was handed to the client unchanged.
       */
      arrange({
        constraints: [
          constraintRow({ id: 'constraint-real-id', resourceType: 'ROOM', roomId: ROOM_ID }),
        ],
        rooms: [{ id: ROOM_ID, capacity: 30, type: 'CLASSROOM', name: 'Aulan', roomType: null }],
      });
      http.post.mockImplementation((_url: string, payload: any) =>
        of({
          data: {
            requestId: payload.requestId,
            status: 'INFEASIBLE',
            lessons: [],
            conflicts: {
              summary: 'blocked',
              summaryCode: 'CONFLICT_CORE_SUMMARY',
              summaryParams: {},
              conflicts: [
                {
                  category: 'AVAILABILITY',
                  code: 'AVAIL_CONSTRAINT_BLOCKS_LESSONS',
                  params: {
                    constraint: payload.constraints[0].id,
                    resource: payload.constraints[0].resourceId,
                  },
                  message: `A constraint ${payload.constraints[0].id} on room ${payload.constraints[0].resourceId}.`,
                  requirementIds: [],
                  roomIds: [],
                  constraintIds: [payload.constraints[0].id],
                  resourceIds: [payload.constraints[0].resourceId],
                },
              ],
            },
          },
        }),
      );

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());
      const detail = (await service.triggerScheduling(ACADEMIC_YEAR, testUser()))
        .conflicts!.conflicts[0];

      expect(detail.params.constraint).toBe('constraint-real-id');
      expect(detail.resourceIds).toEqual([ROOM_ID]);
      // And the room, which the school named itself, is named.
      expect(detail.params.resource).toBe('Aulan');
      expect(detail.resourceNames).toEqual(['Aulan']);
    });

    it('sends a class to the hall when one of its pupils attends a lesson as a participant', async () => {
      // A hand-placed lesson may name pupils one by one rather than through a
      // group. Those pupils are in the building for it, and so their home
      // class eats — a panel found it going without, while a class reached
      // through an extra group or a membership ate as it should.
      const CLASS_B = '55555555-5555-4555-8555-555555555555';
      arrange({
        requirements: [requirement()],
        lockedLessons: [
          {
            ...lockedLesson(),
            participants: [{ studentId: 'aaaaaaa2-0000-4000-8000-000000000002' }],
          },
        ],
        homeMembers: [
          { id: 'aaaaaaa1-0000-4000-8000-000000000001', studentGroupId: GROUP_ID },
          { id: 'aaaaaaa2-0000-4000-8000-000000000002', studentGroupId: CLASS_B },
          { id: 'aaaaaaa3-0000-4000-8000-000000000003', studentGroupId: CLASS_B },
        ],
        groups: [
          { id: GROUP_ID, gradeLevel: 4, kind: 'CLASS' },
          { id: CLASS_B, gradeLevel: 5, kind: 'CLASS' },
        ],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(
        postedPayload()
          .groups.map((g: any) => g.lunchHeadcount)
          .sort(),
      ).toEqual([1, 2]);
    });

    it("leaves the previous run's sittings standing when the engine is skipped", async () => {
      // Every requirement hand-placed: nothing to solve, so the engine is not
      // asked — and a reply built here carries no sittings. Wiping the table
      // on that reply left a wholly hand-placed school with no lunch at all.
      arrange({
        requirements: [requirement({ lessonsPerWeek: 1 })],
        lockedLessons: [lockedLesson()],
      });

      const warn = warnings();

      const result = await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(http.post).not.toHaveBeenCalled();
      expect(result.lunches).toEqual([]);
      // Nothing on the generate page says the sittings are last run's; the
      // log does, and names the year it is about.
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`sittings stand.*${ACADEMIC_YEAR}`)),
      );
      expect(tx.lunchSitting.deleteMany).not.toHaveBeenCalled();
      expect(tx.lunchSitting.createMany).not.toHaveBeenCalled();
      expect(tx.calendarLunch.deleteMany).not.toHaveBeenCalled();
      // The lessons' own clean-up still runs, and so does the audit entry.
      expect(tx.masterLesson.deleteMany).toHaveBeenCalled();
      expect(tx.scheduleChangeLog.create).toHaveBeenCalled();
    });

    it('drops a constraint whose declared type names no resource', async () => {
      // This used to be forwarded with a freshly minted uuid, which the engine
      // could never match against anything: the rule was saved, listed and
      // enforced nowhere, with no error at any layer. The API refuses to write
      // such a row now, and a survivor from before it is dropped rather than
      // sent as something the engine will silently ignore.
      arrange({
        constraints: [
          constraintRow({ userId: null, roomId: null, studentGroupId: null }),
        ],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(postedPayload().constraints).toEqual([]);
    });

    it('sends a year-range lock with its bounds and no resource id', async () => {
      // The one target that is not a row anywhere: the engine matches the range
      // against each group's own span, which is how a lock on åk 4-6 also
      // catches a teaching group whose own gradeLevel is null.
      arrange({
        constraints: [
          constraintRow({
            resourceType: 'GRADE_LEVEL',
            userId: null,
            minGradeLevel: 4,
            maxGradeLevel: 6,
          }),
        ],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());
      const [constraint] = postedPayload().constraints;

      expect(constraint).toMatchObject({
        resourceKind: 'GRADE_LEVEL',
        minGradeLevel: 4,
        maxGradeLevel: 6,
      });
      expect(constraint.resourceId).toBeUndefined();
    });

    it('sends a reservation on a class under the class’s own token', async () => {
      arrange({
        constraints: [constraintRow({ resourceType: 'STUDENT_GROUP', studentGroupId: GROUP_ID })],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());
      const payload = postedPayload();

      expect(payload.constraints[0]).toMatchObject({
        resourceKind: 'STUDENT_GROUP',
        resourceId: payload.requirements[0].studentGroupId,
      });
    });

    // -----------------------------------------------------------------------
    // What is read, and from where
    // -----------------------------------------------------------------------

    const frame = (overrides: Record<string, unknown> = {}) => ({
      minGradeLevel: 4,
      maxGradeLevel: 6,
      dayOfWeek: 1,
      startTime: eightAm,
      endTime: new Date('1970-01-01T15:30:00.000Z'),
      changeoverMinutes: 5,
      ...overrides,
    });
    const serving = (overrides: Record<string, unknown> = {}) => ({
      minGradeLevel: 1,
      maxGradeLevel: 3,
      dayOfWeek: null,
      startTime: new Date('1970-01-01T10:45:00.000Z'),
      endTime: new Date('1970-01-01T11:30:00.000Z'),
      seats: 60,
      ...overrides,
    });
    const rast = (overrides: Record<string, unknown> = {}) => ({
      name: 'Förmiddagsrast',
      minGradeLevel: null,
      maxGradeLevel: null,
      dayOfWeek: 2,
      startTime: new Date('1970-01-01T09:40:00.000Z'),
      endTime: new Date('1970-01-01T10:00:00.000Z'),
      requiresLessonBefore: true,
      ...overrides,
    });

    it('sends frames, servings and breaks with their years and clocks, and a break without its name', async () => {
      arrange({ frames: [frame()], servings: [serving()], rasts: [rast()] });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());
      const payload = postedPayload();

      expect(payload.frameTimes).toEqual([
        {
          minGradeLevel: 4,
          maxGradeLevel: 6,
          dayOfWeek: 1,
          startTime: '08:00:00',
          endTime: '15:30:00',
          changeoverMinutes: 5,
        },
      ]);
      expect(payload.lunchServings).toEqual([
        {
          minGradeLevel: 1,
          maxGradeLevel: 3,
          dayOfWeek: null,
          startTime: '10:45:00',
          endTime: '11:30:00',
          seats: 60,
        },
      ]);
      // What the school calls a break is its own word; the engine only
      // subtracts the minutes.
      expect(payload.rasts).toEqual([
        {
          minGradeLevel: null,
          maxGradeLevel: null,
          dayOfWeek: 2,
          startTime: '09:40:00',
          endTime: '10:00:00',
          requiresLessonBefore: true,
        },
      ]);
    });

    it('reads nothing of another year or another school', async () => {
      /*
       * The timplan by the year; rooms, reservations, frames, servings and
       * breaks through the year's own school. RLS confines these reads in
       * production and no mock can exercise it (see prisma-mock.ts), so what
       * is left to prove here is the filter: a dropped one shows up as another
       * school's row in this school's payload.
       */
      const elsewhere = { schoolId: OTHER_SCHOOL };
      arrange({
        requirements: [
          requirement(),
          requirement({
            id: '88888888-8888-4888-8888-8888888888ff',
            academicYearId: OTHER_YEAR,
            subjectId: 'subject-of-another-year',
          }),
        ],
        rooms: [
          { id: ROOM_ID, capacity: 30 },
          { id: 'room-of-another-school', capacity: 30, ...elsewhere },
        ],
        constraints: [
          constraintRow({ userId: TEACHER_ID }),
          constraintRow({ id: 'constraint-of-another-school', userId: TEACHER_ID, ...elsewhere }),
        ],
        frames: [frame(), frame(elsewhere)],
        servings: [serving(), serving(elsewhere)],
        rasts: [rast(), rast(elsewhere)],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());
      const payload = postedPayload();

      expect(payload.requirements).toHaveLength(1);
      expect(payload.rooms).toHaveLength(1);
      expect(payload.constraints).toHaveLength(1);
      expect(payload.frameTimes).toHaveLength(1);
      expect(payload.lunchServings).toHaveLength(1);
      expect(payload.rasts).toHaveLength(1);
      // Two reads leave nothing in the payload to show a dropped filter by. The
      // groups: another year's class has no lesson in this one, so it is owed no
      // lunch and sent nowhere. And the timplan read again before anything is
      // written. There the where clause itself is what names the year.
      expect(tx.studentGroup.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { academicYearId: ACADEMIC_YEAR } }),
      );
      for (const [query] of tx.teachingRequirement.findMany.mock.calls) {
        expect(query.where).toEqual({ academicYearId: ACADEMIC_YEAR });
      }
    });

    it('keeps a co-teacher on the requirement, on the placement and on the lessons written', async () => {
      const CO_TEACHER = '77777777-aaaa-4aaa-8aaa-777777777777';
      arrange({
        requirements: [requirement({ coTeacherId: CO_TEACHER })],
        lockedLessons: [lockedLesson({ coTeacherId: CO_TEACHER })],
      });
      echoEngine('OPTIMAL');

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());
      const payload = postedPayload();

      // One person, one token: the engine keeps a co-teacher out of two rooms at once.
      expect(payload.requirements[0].coTeacherId).toEqual(expect.any(String));
      expect(payload.fixedLessons[0].coTeacherId).toBe(payload.requirements[0].coTeacherId);
      expect(written()[0]!.coTeacherId).toBe(CO_TEACHER);
    });

    describe('groups whose year cannot be derived', () => {
      const S = 'aaaa0001-9999-4999-8999-999999999999';
      const T = 'aaaa0002-9999-4999-8999-999999999999';
      const Y = 'aaaa0003-9999-4999-8999-999999999999';
      const requirementsOn = (...groupIds: string[]) =>
        groupIds.map((studentGroupId, i) =>
          requirement({
            id: `88888888-8888-4888-8888-88888888880${i}`,
            subjectId: `subject-${i}`,
            studentGroupId,
          }),
        );

      it('says how many groups the frames and breaks will not bind, each group once', async () => {
        // S has two requirements and T one, and neither has a pupil or a year
        // of its own; Y carries year 6. Two groups — not three requirements,
        // and not Y.
        arrange({
          requirements: requirementsOn(S, S, T, Y),
          homeMembers: [],
          groups: [
            { id: S, gradeLevel: null, kind: 'TEACHING_GROUP' },
            { id: T, gradeLevel: null, kind: 'TEACHING_GROUP' },
            { id: Y, gradeLevel: 6, kind: 'TEACHING_GROUP' },
          ],
        });
        echoEngine();
        const warn = warnings();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        expect(warn).toHaveBeenCalledWith(
          expect.stringMatching(/^2 group\(s\) with requirements have no derivable year/),
        );
      });

      it('says nothing when every group has a year', async () => {
        arrange({
          requirements: requirementsOn(Y, Y),
          homeMembers: [],
          groups: [{ id: Y, gradeLevel: 6, kind: 'TEACHING_GROUP' }],
        });
        echoEngine();
        const warn = warnings();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('no derivable year'));
      });
    });

    it('names in resourceNames only what the school has a name for', async () => {
      // A teacher is deliberately never named (see nameById), so a detail about
      // a class and a teacher names the class, and keeps no empty place for the
      // teacher.
      arrange({ groups: [{ id: GROUP_ID, gradeLevel: 4, kind: 'CLASS', name: '4A' }] });
      answerWithConflicts((payload) => ({
        summary: 'blocked',
        summaryCode: 'CONFLICT_CORE_SUMMARY',
        summaryParams: {},
        conflicts: [
          {
            category: 'AVAILABILITY',
            code: 'AVAIL_CONSTRAINT_BLOCKS_LESSONS',
            params: {},
            message: 'blocked',
            requirementIds: [],
            roomIds: [],
            constraintIds: [],
            resourceIds: [payload.groups[0].id, payload.requirements[0].teacherId],
          },
        ],
      }));

      const result = await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(result.conflicts?.conflicts[0]!.resourceNames).toStrictEqual(['4A']);
    });

    it('leaves a class the school gave no name as its id, rather than naming it nothing', async () => {
      arrange({ groups: [{ id: GROUP_ID, gradeLevel: 4, kind: 'CLASS', name: '' }] });
      answerWithConflicts((payload) => ({
        summary: `Student group ${payload.groups[0].id} needs more hours.`,
        summaryCode: 'DEMAND_CLIQUE_HOURS_SHORT',
        summaryParams: {},
        conflicts: [
          {
            category: 'DINING_CAPACITY',
            code: 'LUNCH_CLASSES_FILL_THE_HALL_DAILY',
            params: {},
            message: 'The classes named here fill the hall.',
            requirementIds: [],
            roomIds: [],
            constraintIds: [],
            resourceIds: [payload.groups[0].id],
          },
        ],
      }));

      const result = await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(result.conflicts?.summary).toBe(`Student group ${GROUP_ID} needs more hours.`);
      expect(result.conflicts?.conflicts[0]!.resourceNames).toEqual([]);
    });

    it('names a timplan row whose subject needs no particular kind of room', async () => {
      arrange({
        requirements: [
          requirement({
            subject: { requiredRoomTypeId: null, name: 'Svenska', requiredRoomType: null },
          }),
        ],
        groups: [{ id: GROUP_ID, gradeLevel: 4, kind: 'CLASS', name: '4A' }],
      });
      answerWithConflicts((payload) => ({
        summary: `No slot fits requirement ${payload.requirements[0].id}.`,
        summaryCode: 'DEMAND_CLIQUE_HOURS_SHORT',
        summaryParams: {},
        conflicts: [],
      }));

      const result = await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(result.conflicts?.summary).toBe('No slot fits requirement Svenska för 4A.');
    });

    it('names a kind of room that only a room carries', async () => {
      // No requirement needs the gym, so its name reaches the map through the
      // room alone.
      arrange({
        rooms: [
          {
            id: ROOM_ID,
            capacity: 30,
            roomTypeId: 'room-type-gym',
            name: 'Hallen',
            roomType: { name: 'Idrottshall' },
          },
        ],
      });
      answerWithConflicts((payload) => ({
        summary: 'unused',
        summaryCode: 'ROOM_TYPE_UNUSED',
        summaryParams: { roomType: payload.rooms[0].type },
        conflicts: [],
      }));

      const result = await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(result.conflicts?.summaryParams).toEqual({ roomType: 'Idrottshall' });
    });

    it('hands back no sittings, and writes none, when the engine placed none', async () => {
      // Lunch switched off: the engine answers with an empty list — an answer,
      // unlike no list at all — and there is nothing to hand back or to store.
      arrange();
      http.post.mockImplementation((_url: string, payload: any) =>
        of({
          data: {
            requestId: payload.requestId,
            status: 'OPTIMAL',
            lessons: payload.requirements.flatMap((r: any) =>
              Array.from({ length: r.lessonsPerWeek }, () => ({
                requirementId: r.id,
                roomId: payload.rooms[0]?.id ?? null,
                dayOfWeek: 1,
                startTime: '08:00:00',
                endTime: '09:15:00',
              })),
            ),
            lunches: [],
            conflicts: null,
          },
        }),
      );

      const result = await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(result.lunches).toEqual([]);
      expect(tx.lunchSitting.createMany).not.toHaveBeenCalled();
      expect(tx.lunchSitting.deleteMany).toHaveBeenCalledWith({
        where: { academicYearId: ACADEMIC_YEAR, isGenerated: true },
      });
    });

    it.each([
      [
        'as the group of a locked lesson',
        (group: string) => lockedLesson({ studentGroupId: group, subjectId: 'another-subject' }),
        (fixed: AiEngineScheduleRequest['fixedLessons'][number]) => fixed.studentGroupId,
      ],
      [
        'as the second class of a locked lesson',
        (group: string) =>
          lockedLesson({ subjectId: 'another-subject', extraGroups: [{ studentGroupId: group }] }),
        (fixed: AiEngineScheduleRequest['fixedLessons'][number]) => fixed.extraGroupIds?.[0],
      ],
    ])('keeps a class apart from a teaching group it shares a pupil with only %s', async (_label, locked, tokenOf) => {
      // The pupil cannot be in two places: the class's requirement and the
      // teaching group's hand-placed lesson must not overlap, whichever way the
      // teaching group reaches the week.
      const TEACHING_GROUP = '99999999-9999-4999-8999-999999999999';
      const pupil = 'aaaaaaa1-0000-4000-8000-000000000001';
      arrange({
        lockedLessons: [locked(TEACHING_GROUP)],
        homeMembers: [{ id: pupil, studentGroupId: GROUP_ID }],
        teachingMembers: [{ studentId: pupil, studentGroupId: TEACHING_GROUP }],
        groups: [
          { id: GROUP_ID, gradeLevel: 7, kind: 'CLASS' },
          { id: TEACHING_GROUP, gradeLevel: null, kind: 'TEACHING_GROUP' },
        ],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());
      const payload = postedPayload();

      expect(payload.groupConflicts).toHaveLength(1);
      expect(new Set(payload.groupConflicts[0])).toEqual(
        new Set([payload.requirements[0].studentGroupId, tokenOf(payload.fixedLessons[0]!)]),
      );
    });

    it('reports each pair of groups once, however the memberships happen to be read', async () => {
      // Two pupils in the class and both teaching groups, read into them in
      // opposite orders. Three groups make three pairs, each of them once.
      const TG1 = '11111111-9999-4999-8999-999999999999';
      const TG2 = '22222222-9999-4999-8999-999999999999';
      const [p1, p2] = ['aaaaaaa1-0000-4000-8000-000000000001', 'aaaaaaa2-0000-4000-8000-000000000002'];
      arrange({
        requirements: [
          requirement(),
          requirement({ id: '88888888-8888-4888-8888-888888888881', studentGroupId: TG1 }),
          requirement({ id: '88888888-8888-4888-8888-888888888882', studentGroupId: TG2 }),
        ],
        homeMembers: [
          { id: p1, studentGroupId: GROUP_ID },
          { id: p2, studentGroupId: GROUP_ID },
        ],
        teachingMembers: [
          { studentId: p1, studentGroupId: TG1 },
          { studentId: p2, studentGroupId: TG2 },
          { studentId: p1, studentGroupId: TG2 },
          { studentId: p2, studentGroupId: TG1 },
        ],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());
      const payload = postedPayload();

      const unordered = (pair: string[]) => [...pair].sort().join('|');
      const [a, b, c] = payload.requirements.map((r) => r.studentGroupId) as [string, string, string];
      expect(payload.groupConflicts.map(unordered).sort()).toEqual(
        [[a, b], [a, c], [b, c]].map(unordered).sort(),
      );
    });

    it('does not let a locked lesson that starts later than the requirement cancel any of it', async () => {
      // Spring only, against a requirement read from the autumn: the autumn
      // weeks have no lesson in them, whatever the end dates say.
      const end = new Date('2026-06-11T00:00:00.000Z');
      arrange({
        requirements: [requirement({ startDate: new Date('2025-08-18T00:00:00.000Z'), endDate: end })],
        lockedLessons: [lockedLesson({ startDate: new Date('2026-01-07T00:00:00.000Z'), endDate: end })],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(postedPayload().requirements[0].lessonsPerWeek).toBe(3);
    });

    it('counts every locked lesson towards the demand it answers', async () => {
      // Two a week asked for, two placed by hand: nothing is left to solve.
      arrange({
        requirements: [requirement({ lessonsPerWeek: 2 })],
        lockedLessons: [lockedLesson(), lockedLesson({ id: 'locked-2', dayOfWeek: 3 })],
      });

      const result = await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(http.post).not.toHaveBeenCalled();
      expect(result.status).toBe('FEASIBLE');
    });

    it('sends a class to the hall when it attends a locked lesson as its second class', async () => {
      // Its pupils are in the building for that lesson, so the class eats.
      const CLASS_B = '55555555-5555-4555-8555-555555555555';
      arrange({
        requirements: [requirement()],
        lockedLessons: [
          lockedLesson({ subjectId: 'another-subject', extraGroups: [{ studentGroupId: CLASS_B }] }),
        ],
        homeMembers: [
          { id: 'aaaaaaa1-0000-4000-8000-000000000001', studentGroupId: GROUP_ID },
          { id: 'aaaaaaa2-0000-4000-8000-000000000002', studentGroupId: CLASS_B },
          { id: 'aaaaaaa3-0000-4000-8000-000000000003', studentGroupId: CLASS_B },
        ],
        groups: [
          { id: GROUP_ID, gradeLevel: 4, kind: 'CLASS' },
          { id: CLASS_B, gradeLevel: 5, kind: 'CLASS' },
        ],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(
        postedPayload()
          .groups.map((g: any) => g.lunchHeadcount)
          .sort(),
      ).toEqual([1, 2]);
    });

    /*
     * The steps a schemaförslag run and its apply share with Generera
     * (design §3–§5): one fetch, solved several times, written later.
     */
    describe('the shared steps of a schemaförslag', () => {
      const ROOM_2 = '55555555-bbbb-4bbb-8bbb-555555555555';
      const REQ_2 = '11111111-cccc-4ccc-8ccc-111111111111';
      const SUBJECT_2 = '22222222-cccc-4ccc-8ccc-222222222222';

      const prepare = (options?: { coverage?: boolean }) =>
        service.prepareSchedule(tx as unknown as PrismaClient, ACADEMIC_YEAR, testUser(), options);
      const ready = async (options?: { coverage?: boolean }): Promise<PreparedSchedule> => {
        const result = await prepare(options);
        if (!result.ready) throw new Error(`refused: ${result.refusalCode}`);
        return result;
      };

      /** One of the draft's own lessons, as the draft read selects it. */
      const draftRow = (overrides: Record<string, unknown> = {}) => ({
        id: 'draft-1',
        subjectId: SUBJECT_ID,
        studentGroupId: GROUP_ID,
        teacherId: TEACHER_ID,
        coTeacherId: null,
        roomId: ROOM_ID,
        dayOfWeek: 3,
        startTime: eightAm,
        endTime: nineAm,
        recurrence: 'ALL_WEEKS',
        startDate: null,
        endDate: null,
        isParked: false,
        ...overrides,
      });

      it('hands back what a run and an apply need: the demand and rows in real ids, the draft, the basis', async () => {
        arrange({
          lockedLessons: [lockedLesson()],
          draftLessons: [draftRow({ id: 'draft-b' }), draftRow({ id: 'draft-a', dayOfWeek: 4 })],
        });

        const prepared = await ready();

        // Three a week, one of them locked: two to place, by the real id.
        expect(prepared.demand).toEqual([{ requirementId: REQ_ID, lessonsPerWeek: 2 }]);
        expect(prepared.requirementRows).toEqual([
          {
            id: REQ_ID,
            subjectId: SUBJECT_ID,
            studentGroupId: GROUP_ID,
            teacherId: TEACHER_ID,
            coTeacherId: null,
            recurrence: 'ALL_WEEKS',
            startDate: null,
            endDate: null,
          },
        ]);
        expect(prepared.draftIds).toEqual(['draft-a', 'draft-b']);
        expect(prepared.draftLessons).toContainEqual(
          expect.objectContaining({ id: 'draft-a', dayOfWeek: 4, startTime: '08:00', endTime: '09:00', isParked: false }),
        );
        expect(prepared.basis).toMatch(/^[0-9a-f]{64}$/);
        expect(Object.keys(prepared.basisParts).sort()).toEqual(
          ['draft', 'preserved', 'requirements', 'rooms', 'rosters', 'rules'],
        );
        expect(prepared.coverage).toBeNull();
        // The draft is read by the rule the delete uses.
        expect(tx.masterLesson.findMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: { academicYearId: ACADEMIC_YEAR, NOT: PRESERVED } }),
        );
        // A refusal may name no person: the teacher map stays inside the fetch.
        expect(Object.keys(prepared.anonMaps)).not.toContain('teacherAnonMap');
      });

      it('agrees with itself across two reads of an unchanged school, its rows in another order', async () => {
        const rows = {
          requirements: [requirement(), requirement({ id: REQ_2, subjectId: SUBJECT_2, teacherId: null })],
          rooms: [
            { id: ROOM_ID, capacity: 30, roomTypeId: null },
            { id: ROOM_2, capacity: 24, roomTypeId: null },
          ],
          lockedLessons: [
            lockedLesson(),
            lockedLesson({ id: 'locked-2', subjectId: SUBJECT_2, dayOfWeek: 4, roomId: ROOM_2 }),
          ],
          draftLessons: [draftRow({ id: 'draft-a' }), draftRow({ id: 'draft-b', dayOfWeek: 5 })],
          unlockedLessons: [
            { subjectId: SUBJECT_ID, studentGroupId: GROUP_ID, dayOfWeek: 3, startTime: eightAm },
            { subjectId: SUBJECT_2, studentGroupId: GROUP_ID, dayOfWeek: 5, startTime: nineAm },
          ],
        };
        arrange(rows);
        const first = await ready();
        arrange({
          requirements: [...rows.requirements].reverse(),
          rooms: [...rows.rooms].reverse(),
          lockedLessons: [...rows.lockedLessons].reverse(),
          draftLessons: [...rows.draftLessons].reverse(),
          unlockedLessons: [...rows.unlockedLessons].reverse(),
        });
        const second = await ready();

        // Not one anonymous id in common…
        expect(second.payload.requirements.map((r) => r.id)).not.toContain(first.payload.requirements[0]!.id);
        // …and one basis.
        expect(second.basisParts).toEqual(first.basisParts);
        expect(second.basis).toBe(first.basis);
      });

      it('takes a locked lesson by what it is: its id is nothing to the basis, its room is the preserved part', async () => {
        const rooms = [
          { id: ROOM_ID, capacity: 30, roomTypeId: null },
          { id: ROOM_2, capacity: 30, roomTypeId: null },
        ];
        arrange({ rooms, lockedLessons: [lockedLesson({ id: 'locked-x' })] });
        const before = await ready();
        arrange({ rooms, lockedLessons: [lockedLesson({ id: 'locked-y' })] });
        const renamed = await ready();
        arrange({ rooms, lockedLessons: [lockedLesson({ roomId: ROOM_2 })] });
        const moved = await ready();

        expect(renamed.basis).toBe(before.basis);
        expect(candidateBasis.changedParts(before.basisParts, moved.basisParts)).toEqual(['preserved']);
      });

      it('reads no pupil into the basis, though pupils are what sizes, pairs and lunches come from', async () => {
        const PUPIL = '00000000-0000-4000-8000-900000000001';
        const MEMBER = '00000000-0000-4000-8000-900000000007';
        const NAMED = '00000000-0000-4000-8000-900000000013';
        arrange({
          requirements: [requirement(), requirement({ id: REQ_2, studentGroupId: EXTRA_GROUP_ID })],
          teachingMembers: [{ studentId: MEMBER, studentGroupId: EXTRA_GROUP_ID }],
          lockedLessons: [lockedLesson({ participants: [{ studentId: NAMED }] })],
          groups: [
            { id: GROUP_ID, gradeLevel: null, kind: 'CLASS' },
            { id: EXTRA_GROUP_ID, gradeLevel: null, kind: 'TEACHING_GROUP' },
          ],
        });
        const inputs = jest.spyOn(candidateBasis, 'basisPartsOf');

        const prepared = await ready();

        expect(inputs).toHaveBeenCalledTimes(1);
        const hashed = candidateBasis.canonicalJson(inputs.mock.calls[0]![0]);
        // The pupils are there in what was hashed — as a size, a headcount and
        // the pair 7A shares with the teaching group — and not as themselves.
        expect(hashed).toContain('"lunchHeadcount":24');
        expect(prepared.payload.groupConflicts).toHaveLength(1);
        for (const pupil of [PUPIL, MEMBER, NAMED]) {
          expect(hashed).not.toContain(pupil);
          expect(JSON.stringify(prepared, (_key, value: unknown) =>
            value instanceof Map ? [...value] : value,
          )).not.toContain(pupil);
        }
        inputs.mockRestore();
      });

      it('refuses before the payload, as Generera does, when the staffing policy refuses', async () => {
        arrange();
        tx.staffingPolicy.findUnique.mockResolvedValue({ unstaffedGeneration: 'REFUSE' });
        tx.teachingRequirement.findMany.mockImplementation((query: Query) =>
          Promise.resolve(
            query.where && 'teacherId' in query.where
              ? [{ id: REQ_ID, subject: { name: 'Matematik' }, studentGroup: { name: '7A' } }]
              : [],
          ),
        );

        const result = await prepare();

        expect(result).toMatchObject({
          ready: false,
          refusalCode: 'STAFF_UNSTAFFED_REQUIREMENTS',
          refusal: { status: 'INFEASIBLE', lessons: [] },
        });
        expect(tx.masterLesson.findMany).not.toHaveBeenCalled();
      });

      it('refuses a block whose lessons are partly locked, by its code, and Generera answers it as before', async () => {
        const block = {
          requirements: [
            requirement({ blockId: 'block-1' }),
            requirement({ id: REQ_2, subjectId: SUBJECT_2, blockId: 'block-1' }),
          ],
          lockedLessons: [lockedLesson()],
        };
        arrange(block);

        const result = await prepare();

        expect(result).toMatchObject({ ready: false, refusalCode: 'BLOCK_PARTLY_LOCKED_SUMMARY' });

        arrange(block);
        const answer = await service.triggerScheduling(ACADEMIC_YEAR, testUser());
        expect(answer).toMatchObject({ status: 'INFEASIBLE', lessons: [], lunches: [] });
        expect(answer.conflicts?.conflicts[0]).toMatchObject({ code: 'BLOCK_PARTLY_LOCKED' });
        expect(http.post).not.toHaveBeenCalled();
        expect(tx.masterLesson.deleteMany).not.toHaveBeenCalled();
      });

      it('refuses to write a Generera run whose draft changed while it solved, and writes nothing', async () => {
        arrange({ draftLessons: [draftRow({ id: 'draft-a' })] });
        echoEngine();
        const fetchRead = tx.masterLesson.findMany.getMockImplementation()!;
        let draftReads = 0;
        tx.masterLesson.findMany.mockImplementation(async (query: Query = {}) =>
          // The second read is persist's, under the lock: a lesson has been
          // unlocked meanwhile.
          query.where?.['NOT'] && ++draftReads > 1 ? [{ id: 'draft-a' }, { id: 'unlocked-since' }] : fetchRead(query),
        );

        const error = await service.triggerScheduling(ACADEMIC_YEAR, testUser()).catch((thrown: unknown) => thrown);

        expect(bodyOf(error)).toMatchObject({ code: 'GENERATE_STALE' });
        expect(tx.masterLesson.deleteMany).not.toHaveBeenCalled();
        expect(tx.masterLesson.createMany).not.toHaveBeenCalled();
      });

      it('sends Generera’s request without `search`, byte for byte as before', async () => {
        arrange();
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        expect(postedPayload()).not.toHaveProperty('search');
      });

      describe('solveCandidate', () => {
        const options = {
          weights: { disruption: 2, teacherGap: 8 },
          search: { seed: 1, maxSeconds: 30, probes: false, workers: 4 },
          timeoutMs: 95_000,
        };

        it('sends the fetch with the candidate’s weights and search, the school’s rules, its own request id', async () => {
          arrange({
            lunchSettings: {
              lunchEnabled: true,
              lunchStartTime: new Date('1970-01-01T11:00:00.000Z'),
              lunchEndTime: new Date('1970-01-01T13:00:00.000Z'),
              lunchMinutes: 30,
              diningSeats: null,
              maxLessonsPerDayPerGroup: null,
            },
          });
          echoEngine('FEASIBLE');
          const prepared = await ready();

          const solution = await service.solveCandidate(prepared, options);

          const sent = postedPayload();
          expect(sent.search).toEqual(options.search);
          expect(sent.weights).toEqual(options.weights);
          expect(sent.rules).toEqual({ lunchStartTime: '11:00:00', lunchEndTime: '13:00:00', lunchMinutes: 30 });
          expect(sent.requestId).not.toBe(prepared.requestId);
          expect(sent.requirements).toEqual(prepared.payload.requirements);
          // The call's own budget, for the rxjs timeout and axios alike.
          expect(http.post.mock.calls[0][2]).toMatchObject({ timeout: 95_000 });

          expect(solution).toEqual({
            status: 'FEASIBLE',
            lessons: Array.from({ length: 3 }, () => ({
              requirementId: REQ_ID,
              roomId: ROOM_ID,
              dayOfWeek: 1,
              startTime: '08:00',
              endTime: '09:15',
            })),
            // The echo places no meal: the stored sittings would stand.
            lunches: null,
            conflicts: null,
          });
        });

        it('brings the sittings back under real group ids', async () => {
          arrange();
          http.post.mockImplementation((_url: string, payload: any) =>
            of({
              data: {
                requestId: payload.requestId,
                status: 'OPTIMAL',
                lessons: Array.from({ length: 3 }, (_, i) => ({
                  requirementId: payload.requirements[0].id,
                  roomId: null,
                  dayOfWeek: i + 1,
                  startTime: '08:00:00',
                  endTime: '09:00:00',
                })),
                lunches: [
                  { studentGroupId: payload.groups[0].id, dayOfWeek: 1, startTime: '11:30:00', endTime: '12:00:00' },
                ],
              },
            }),
          );

          const solution = await service.solveCandidate(await ready(), options);

          expect(solution.lunches).toEqual([
            { studentGroupId: GROUP_ID, dayOfWeek: 1, startTime: '11:30:00', endTime: '12:00:00' },
          ]);
          expect(solution.lessons.map((lesson) => lesson.roomId)).toEqual([null, null, null]);
        });

        it('rejects an answer that does not carry the demand it was sent, and keeps none of it', async () => {
          arrange();
          http.post.mockImplementation((_url: string, payload: any) =>
            of({
              data: {
                requestId: payload.requestId,
                status: 'OPTIMAL',
                lessons: [placement(payload.requirements[0].id)],
              },
            }),
          );
          warnings();

          const solution = await service.solveCandidate(await ready(), options);

          expect(solution).toMatchObject({ status: 'OPTIMAL', lessons: [], lunches: null, rejected: true });
        });

        it('rejects an answer naming a requirement nobody sent, even beside the whole demand', async () => {
          arrange({ requirements: [requirement({ lessonsPerWeek: 1 })] });
          http.post.mockImplementation((_url: string, payload: any) =>
            of({
              data: {
                requestId: payload.requestId,
                status: 'OPTIMAL',
                lessons: [placement(payload.requirements[0].id), placement('ffffffff-ffff-4fff-8fff-ffffffffffff')],
              },
            }),
          );
          warnings();

          await expect(service.solveCandidate(await ready(), options)).resolves.toMatchObject({ rejected: true });
        });

        it('brings a refusal back realised, with no lessons', async () => {
          arrange();
          answerWithConflicts((payload) => ({
            summary: `Requirement ${payload.requirements[0].id} has nowhere to go.`,
            summaryCode: 'X',
            summaryParams: {},
            conflicts: [],
          }));

          const solution = await service.solveCandidate(await ready(), options);

          expect(solution).toMatchObject({ status: 'INFEASIBLE', lessons: [], lunches: null });
          expect(solution.conflicts?.summary).toContain(REQ_ID);
        });

        it('asks no engine when locks already place everything', async () => {
          arrange({ requirements: [requirement({ lessonsPerWeek: 1 })], lockedLessons: [lockedLesson()] });

          const solution = await service.solveCandidate(await ready(), options);

          expect(http.post).not.toHaveBeenCalled();
          expect(solution).toEqual({ status: 'FEASIBLE', lessons: [], lunches: null, conflicts: null });
        });

        it('hints a refresh with an old candidate’s lessons, under the new fetch’s ids', async () => {
          arrange();
          echoEngine();
          const old = await service.solveCandidate(await ready(), options);
          http.post.mockClear();
          arrange();
          echoEngine();
          const today = await ready();

          const hints = previousLessonsFrom(today, [
            ...old.lessons,
            // A lesson of a timplanspost since deleted is a hint for nothing.
            { requirementId: 'gone', roomId: null, dayOfWeek: 2, startTime: '10:00', endTime: '11:00' },
          ]);
          await service.solveCandidate(today, { ...options, previousLessons: hints });

          const anonymous = today.payload.requirements[0]!.id;
          expect(hints).toEqual(
            Array.from({ length: 3 }, () => ({ requirementId: anonymous, dayOfWeek: 1, startTime: '08:00:00' })),
          );
          expect(postedPayload().previousLessons).toEqual(hints);
        });
      });

      describe('what a timetable leaves unplaced', () => {
        it('counts lines short of the timplan, the preserved lessons held, by the publish gate’s rule', async () => {
          arrange({
            groups: [{ id: GROUP_ID, gradeLevel: 7, kind: 'CLASS', name: '7A' }],
            lockedLessons: [lockedLesson({ participants: [{ studentId: 'pupil-named' }] })],
            draftLessons: [draftRow({ id: 'draft-a' }), draftRow({ id: 'draft-b', dayOfWeek: 4 })],
          });
          tx.academicYear.findUnique.mockResolvedValue({
            startDate: new Date('2026-08-17T00:00:00.000Z'),
            endDate: new Date('2027-06-11T00:00:00.000Z'),
          });
          tx.subject.findMany.mockImplementation(
            table([{ id: SUBJECT_ID, name: 'Matematik', nationalCode: null, countsTowardTimplan: true }]),
          );

          const prepared = await ready({ coverage: true });
          const base = prepared.coverage!;

          // 3 × 60 planned; the lock gives 60 and the draft 120.
          expect(unplacedOf(base, base.draftLessons)).toEqual({ lines: 0, minutes: 0 });
          expect(unplacedOf(base, [])).toEqual({ lines: 1, minutes: 120 });
          const candidate: CandidateLesson[] = [1, 2].map((dayOfWeek) => ({
            requirementId: REQ_ID,
            roomId: null,
            dayOfWeek: dayOfWeek as DayOfWeek,
            startTime: '10:00',
            endTime: '10:30',
          }));
          expect(unplacedOf(base, coverageLessonsOf(prepared, candidate))).toEqual({ lines: 1, minutes: 60 });
          // No pupil rides along, not even a named one.
          expect(base.preservedLessons[0]).toMatchObject({ studentIds: [], extraGroupIds: [] });
        });
      });

      describe('applyCandidateWrite', () => {
        const DRAFT = ['draft-a', 'draft-b'];
        let versions: { snapshotInTransaction: jest.Mock };
        let createdCount: number;

        const lessons = (count = 2): CandidateLesson[] =>
          Array.from({ length: count }, (_, i) => ({
            requirementId: REQ_ID,
            roomId: ROOM_ID,
            dayOfWeek: (i + 1) as DayOfWeek,
            startTime: '08:00',
            endTime: '09:00',
          }));

        const prepareForApply = async (): Promise<PreparedSchedule> => {
          arrange({
            lockedLessons: [lockedLesson()],
            draftLessons: DRAFT.map((id) => draftRow({ id })),
          });
          const prepared = await ready();
          versions = { snapshotInTransaction: jest.fn().mockResolvedValue({ id: 'version-1' }) };
          createdCount = 2;
          tx.masterLesson.deleteMany.mockResolvedValue({ count: DRAFT.length });
          // After the write, the machine's own lessons, which must be exactly
          // the ones just created (the log's preserved count is the kept
          // set's findMany, read after the delete).
          tx.masterLesson.count.mockImplementation(async ({ where }: Query = {}) =>
            where?.['NOT'] ? createdCount : 1,
          );
          return prepared;
        };

        const apply = (prepared: PreparedSchedule, overrides: Partial<CandidateApplyInput> = {}) =>
          service.applyCandidateWrite(tx as unknown as PrismaClient, {
            user: testUser({ schoolId: THIS_SCHOOL, userId: 'admin-1' }),
            prepared,
            mode: 'DIRECT',
            lessons: lessons(),
            lunches: null,
            solverStatus: 'OPTIMAL',
            snapshot: { versions, name: 'Före schemaförslag 2 – Färre håltimmar för lärarna' },
            after: { source: 'CANDIDATE', runId: 'run-1', ordinal: 2, variant: 'TEACHER_GAPS', metrics: { moved: 3 } },
            ...overrides,
          });

        it('saves the safety version first, then deletes exactly the ids the basis saw, dated lessons and masters alike', async () => {
          const prepared = await prepareForApply();
          jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] }).setSystemTime(new Date('2026-08-12T08:00:00.000Z'));
          let result;
          try {
            result = await apply(prepared);
          } finally {
            jest.useRealTimers();
          }

          expect(versions.snapshotInTransaction).toHaveBeenCalledWith(
            tx,
            ACADEMIC_YEAR,
            'Före schemaförslag 2 – Färre håltimmar för lärarna',
            expect.objectContaining({ userId: 'admin-1' }),
          );
          expect(versions.snapshotInTransaction.mock.invocationCallOrder[0]!).toBeLessThan(
            tx.calendarLesson.deleteMany.mock.invocationCallOrder[0]!,
          );
          // One scope for both: the ids, never the rule.
          expect(tx.calendarLesson.deleteMany).toHaveBeenCalledWith({
            where: {
              masterLessonId: { in: DRAFT },
              status: 'SCHEDULED',
              date: { gte: new Date('2026-08-12T00:00:00.000Z') },
              attendanceRecords: { none: {} },
            },
          });
          // And the clause a check counts with is the one the write deleted by.
          expect(tx.calendarLesson.deleteMany).toHaveBeenCalledWith({
            where: calendarSweepWhere(
              { kind: 'IDS', ids: DRAFT },
              ACADEMIC_YEAR,
              new Date('2026-08-12T00:00:00.000Z'),
            ),
          });
          expect(tx.masterLesson.deleteMany).toHaveBeenCalledWith({
            where: { academicYearId: ACADEMIC_YEAR, id: { in: DRAFT } },
          });
          expect(written()).toHaveLength(2);
          expect(written()[0]).toMatchObject({
            schoolId: THIS_SCHOOL,
            subjectId: SUBJECT_ID,
            studentGroupId: GROUP_ID,
            teacherId: TEACHER_ID,
            roomId: ROOM_ID,
            startTime: new Date('1970-01-01T08:00:00.000Z'),
            isGenerated: true,
          });
          expect(result).toEqual({
            versionId: 'version-1',
            lessonsCreated: 2,
            unlockedReplaced: 2,
            lockedPreserved: 1,
            calendarLessonsRemoved: 4,
          });
        });

        it('stamps the lessons from the rows the basis was hashed from, with no second read', async () => {
          const prepared = await prepareForApply();
          const reads = tx.teachingRequirement.findMany.mock.calls.length;

          await apply(prepared);

          expect(tx.teachingRequirement.findMany.mock.calls.length).toBe(reads);
        });

        it('logs the apply as a regeneration that says which candidate it was, and the safety version a restore undoes it by', async () => {
          await apply(await prepareForApply());

          expect(tx.scheduleChangeLog.create).toHaveBeenCalledWith({
            data: {
              schoolId: THIS_SCHOOL,
              academicYearId: ACADEMIC_YEAR,
              masterLessonId: null,
              actorId: 'admin-1',
              action: 'REGENERATE',
              after: {
                source: 'CANDIDATE',
                runId: 'run-1',
                ordinal: 2,
                variant: 'TEACHER_GAPS',
                metrics: { moved: 3 },
                // The version saved first, so a RESTORE of it is known to undo this.
                safetyVersionId: 'version-1',
                solverStatus: 'OPTIMAL',
                lessonsCreated: 2,
                unlockedReplaced: 2,
                lockedPreserved: 1,
                calendarLessonsRemoved: 4,
              },
            },
          });
        });

        it('in DRAFT leaves the calendar to the next publish', async () => {
          await apply(await prepareForApply(), { mode: 'DRAFT' });

          expect(tx.calendarLesson.deleteMany).not.toHaveBeenCalled();
        });

        it('refuses STALE when an id the basis saw is gone, before a lesson is written', async () => {
          const prepared = await prepareForApply();
          tx.masterLesson.deleteMany.mockResolvedValue({ count: 1 });

          const error = await apply(prepared).catch((thrown: unknown) => thrown);

          expect(bodyOf(error)).toMatchObject({ code: 'SCHEDULE_CANDIDATE_STALE', changed: ['draft'] });
          expect(tx.masterLesson.createMany).not.toHaveBeenCalled();
        });

        it('refuses STALE when a machine-owned lesson outlives the write', async () => {
          const prepared = await prepareForApply();
          createdCount = 3;

          const error = await apply(prepared).catch((thrown: unknown) => thrown);

          expect(bodyOf(error)).toMatchObject({ code: 'SCHEDULE_CANDIDATE_STALE', changed: ['draft'] });
          expect(tx.scheduleChangeLog.create).not.toHaveBeenCalled();
        });

        it('refuses STALE when the preserved lessons are no longer the ones it was solved around', async () => {
          const prepared = await prepareForApply();
          const fetchRead = tx.masterLesson.findMany.getMockImplementation()!;
          tx.masterLesson.findMany.mockImplementation(async (query: Query = {}) =>
            query.where?.['isParked'] === false
              ? [{ ...lockedLesson({ roomId: ROOM_2 }), extraGroups: [] }]
              : fetchRead(query),
          );

          const error = await apply(prepared).catch((thrown: unknown) => thrown);

          expect(bodyOf(error)).toMatchObject({ code: 'SCHEDULE_CANDIDATE_STALE', changed: ['preserved'] });
          expect(tx.scheduleChangeLog.create).not.toHaveBeenCalled();
        });

        it('refuses STALE, not 502, for lessons the rebuilt demand does not hold, and deletes nothing', async () => {
          const prepared = await prepareForApply();
          warnings();
          jest.spyOn((service as unknown as { logger: Logger }).logger, 'error').mockImplementation(() => undefined);

          const error = await apply(prepared, { lessons: lessons(1) }).catch((thrown: unknown) => thrown);

          expect((error as HttpException).getStatus()).toBe(409);
          expect(bodyOf(error)).toMatchObject({ code: 'SCHEDULE_CANDIDATE_STALE', changed: ['requirements'] });
          expect(tx.masterLesson.deleteMany).not.toHaveBeenCalled();
        });

        it.each([
          ['a deadlock', 'P2034', undefined],
          ['a room deleted under it', 'P2003', undefined],
          ['a foreign key by its SQLSTATE', 'P2010', '23503'],
        ])('answers %s as SCHEDULE_CANDIDATE_BUSY', async (_case, code, originalCode) => {
          const prepared = await prepareForApply();
          tx.masterLesson.createMany.mockRejectedValue(
            new Prisma.PrismaClientKnownRequestError('write failed', {
              code,
              clientVersion: '7',
              meta: originalCode ? { driverAdapterError: { cause: { originalCode } } } : undefined,
            }),
          );

          const error = await apply(prepared).catch((thrown: unknown) => thrown);

          expect(bodyOf(error)).toMatchObject({ code: 'SCHEDULE_CANDIDATE_BUSY' });
        });
      });
    });

    // -----------------------------------------------------------------------
    // En tioårig läsår (SFS 2025:729)
    // -----------------------------------------------------------------------

    describe('a tioårig läsår (SFS 2025:729)', () => {
      /*
       * From HT 2028 every class is numbered one up: the åldersband that was
       * 9A is 10A. Frames, sittings, raster, salar and salsregler are
       * school-wide and stated in the nioårig numbering for good, so the
       * payload sends each class's span read into it (10A as 9) and the
       * engine compares like with like. The engine contract does not change,
       * and a nioårig läsår's payload is exactly what it was.
       */
      const TEACHING = '99999999-9999-4999-8999-999999999999';
      const CLASS_8 = 'aaaa0008-9999-4999-8999-999999999999';
      const CLASS_1 = 'aaaa0001-9999-4999-8999-999999999999';

      /** The läsår as the database holds it, with its numbering: 2028/29. */
      const SCHEDULED = {
        id: ACADEMIC_YEAR,
        isActive: true,
        predecessorId: null,
        startDate: new Date('2028-07-01T00:00:00.000Z'),
        endDate: new Date('2029-06-30T00:00:00.000Z'),
      };
      /** And the school's earlier läsår, nioårig: 2027/28. */
      const EARLIER = {
        id: OTHER_YEAR,
        isActive: false,
        predecessorId: null,
        startDate: new Date('2027-07-01T00:00:00.000Z'),
        endDate: new Date('2028-06-30T00:00:00.000Z'),
        gradeNumbering: 'NIOARIG' as const,
      };
      const yearNumbered = (gradeNumbering: GradeNumbering) => {
        tx.academicYear.findUnique.mockImplementation(async ({ where, select }: Query = {}) => {
          if (typeof where?.['id'] !== 'string') throw new Error('findUnique needs a unique where');
          assertSelects(select);
          return where['id'] === ACADEMIC_YEAR ? selected({ ...SCHEDULED, gradeNumbering }, select) : null;
        });
        tx.academicYear.findMany.mockImplementation(async ({ where, select }: Query = {}) => {
          // The school's läsår, as dayNumberingOf asks for them.
          expect(where).toEqual({ school: { academicYears: { some: { id: ACADEMIC_YEAR } } } });
          assertSelects(select);
          return [{ ...SCHEDULED, gradeNumbering }, EARLIER].map((row) => selected(row, select));
        });
      };
      /** Högstadiet's rows as the school wrote them: "7–9", nioårig. */
      const highStage = { minGradeLevel: 7, maxGradeLevel: 9 };
      const arrangeHighStage = (gradeLevel: number) =>
        arrange({
          groups: [{ id: GROUP_ID, gradeLevel, kind: 'CLASS' }],
          frames: [frame(highStage)],
          servings: [serving(highStage)],
          rasts: [rast(highStage)],
          rooms: [{ id: ROOM_ID, capacity: 30, roomTypeId: 'room-type-lab', ...highStage }],
          roomPreferences: [
            {
              id: 'pref-1',
              subjectId: SUBJECT_ID,
              kind: 'WISH',
              ...highStage,
              roomTypeId: null,
              weight: 50,
              rooms: [{ roomId: ROOM_ID }],
            },
          ],
        });
      /** Every school-wide span the payload carries: each as the school stated it. */
      const schoolWideSpans = (payload: AiEngineScheduleRequest) => [
        payload.frameTimes[0],
        payload.lunchServings[0],
        payload.rasts[0],
        payload.rooms[0],
        payload.roomPreferences[0],
      ];

      it('sends a class’s span in the nioårig numbering its frames, sittings and salar are stated in', async () => {
        yearNumbered('TIOARIG');
        arrangeHighStage(10);
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());
        const payload = postedPayload();

        // 10A is sent as the 9 a "7–9" frame binds — on the timplanspost and
        // on the group that eats alike.
        expect(payload.requirements[0]).toMatchObject({ minGradeLevel: 9, maxGradeLevel: 9 });
        expect(payload.groups).toEqual([expect.objectContaining({ minGradeLevel: 9, maxGradeLevel: 9 })]);
        for (const span of schoolWideSpans(payload)) {
          expect(span).toMatchObject(highStage);
        }
      });

      it('sends a nioårig läsår’s spans exactly as before', async () => {
        yearNumbered('NIOARIG');
        arrangeHighStage(9);
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());
        const payload = postedPayload();

        expect(payload.requirements[0]).toMatchObject({ minGradeLevel: 9, maxGradeLevel: 9 });
        expect(payload.groups).toEqual([expect.objectContaining({ minGradeLevel: 9, maxGradeLevel: 9 })]);
        for (const span of schoolWideSpans(payload)) {
          expect(span).toMatchObject(highStage);
        }
      });

      it('reads a teaching group over its members’ classes, and åk 1 as the förskoleklass it was', async () => {
        /*
         * A teaching group of 8B and 10A pupils spans nioårig 7–9; the new
         * åk 1 is the åldersband an "F–3" (0–3) frame was written for.
         */
        const pupilOf = (n: number, studentGroupId: string) => ({
          id: `00000000-0000-4000-8000-90000000${String(n).padStart(4, '0')}`,
          studentGroupId,
        });
        yearNumbered('TIOARIG');
        arrange({
          requirements: [
            requirement({ studentGroupId: TEACHING }),
            requirement({ id: '88888888-8888-4888-8888-888888888801', studentGroupId: CLASS_1 }),
          ],
          homeMembers: [pupilOf(1, GROUP_ID), pupilOf(2, CLASS_8), pupilOf(3, CLASS_1)],
          teachingMembers: [
            { studentId: pupilOf(1, GROUP_ID).id, studentGroupId: TEACHING },
            { studentId: pupilOf(2, CLASS_8).id, studentGroupId: TEACHING },
          ],
          groups: [
            { id: GROUP_ID, gradeLevel: 10, kind: 'CLASS' },
            { id: CLASS_8, gradeLevel: 8, kind: 'CLASS' },
            { id: CLASS_1, gradeLevel: 1, kind: 'CLASS' },
            { id: TEACHING, gradeLevel: null, kind: 'TEACHING_GROUP' },
          ],
        });
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());
        const [teaching, firstGrade] = postedPayload().requirements;

        expect(teaching).toMatchObject({ minGradeLevel: 7, maxGradeLevel: 9 });
        expect(firstGrade).toMatchObject({ minGradeLevel: 0, maxGradeLevel: 0 });
      });

      it('sends a weekly årskursregel as stored and reads a dated one over from the läsår’s numbering', async () => {
        /*
         * A weekly rule is school-wide and nioårig already: "7–9 closed on
         * Monday mornings" means högstadiet in any läsår. A dated one — a prao
         * day, a studiedag — the admin wrote for that day in the classes as the
         * läsår numbers them, so 8–10's prao is sent as the 7–9 the groups'
         * spans are in. Twelve is "and above" in both.
         */
        yearNumbered('TIOARIG');
        arrange({
          groups: [{ id: GROUP_ID, gradeLevel: 10, kind: 'CLASS' }],
          constraints: [
            constraintRow({ id: 'c-weekly', resourceType: 'GRADE_LEVEL', minGradeLevel: 7, maxGradeLevel: 9 }),
            constraintRow({
              id: 'c-prao',
              resourceType: 'GRADE_LEVEL',
              minGradeLevel: 8,
              maxGradeLevel: 10,
              dayOfWeek: null,
              date: new Date('2029-03-12T00:00:00.000Z'),
            }),
            constraintRow({
              id: 'c-studiedag',
              resourceType: 'GRADE_LEVEL',
              minGradeLevel: 1,
              maxGradeLevel: 12,
              dayOfWeek: null,
              date: new Date('2029-04-03T00:00:00.000Z'),
            }),
          ],
        });
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());
        const spans = postedPayload().constraints.map((c) => [c.date, c.minGradeLevel, c.maxGradeLevel]);

        expect(spans).toEqual([
          [null, 7, 9],
          ['2029-03-12', 7, 9],
          ['2029-04-03', 0, 12],
        ]);
      });

      it('reads each dated årskursregel by the läsår its own day falls in', async () => {
        /*
         * The read has no date window: last spring's prao, written for 7–9 in
         * the nioårig läsår it fell in, is in the payload beside this year's,
         * written for 8–10. Each is read by its own day's läsår, so both reach
         * the engine as the 7–9 they mean — not last year's as 6–8.
         */
        yearNumbered('TIOARIG');
        arrange({
          groups: [{ id: GROUP_ID, gradeLevel: 10, kind: 'CLASS' }],
          constraints: [
            constraintRow({
              id: 'c-last-prao',
              resourceType: 'GRADE_LEVEL',
              minGradeLevel: 7,
              maxGradeLevel: 9,
              dayOfWeek: null,
              date: new Date('2028-03-13T00:00:00.000Z'),
            }),
            constraintRow({
              id: 'c-this-prao',
              resourceType: 'GRADE_LEVEL',
              minGradeLevel: 8,
              maxGradeLevel: 10,
              dayOfWeek: null,
              date: new Date('2029-03-12T00:00:00.000Z'),
            }),
            constraintRow({
              id: 'c-outside',
              resourceType: 'GRADE_LEVEL',
              minGradeLevel: 4,
              maxGradeLevel: 6,
              dayOfWeek: null,
              date: new Date('2031-01-15T00:00:00.000Z'),
            }),
          ],
        });
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());
        const spans = postedPayload().constraints.map((c) => [c.date, c.minGradeLevel, c.maxGradeLevel]);

        // A day no läsår of the school holds is nioårig: as written.
        expect(spans).toEqual([
          ['2028-03-13', 7, 9],
          ['2029-03-12', 7, 9],
          ['2031-01-15', 4, 6],
        ]);
      });

      it('sends a nioårig läsår’s dated årskursregel as stored', async () => {
        yearNumbered('NIOARIG');
        arrange({
          groups: [{ id: GROUP_ID, gradeLevel: 9, kind: 'CLASS' }],
          constraints: [
            constraintRow({
              resourceType: 'GRADE_LEVEL',
              minGradeLevel: 7,
              maxGradeLevel: 9,
              dayOfWeek: null,
              date: new Date('2028-03-13T00:00:00.000Z'),
            }),
          ],
        });
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        expect(postedPayload().constraints[0]).toMatchObject({
          date: '2028-03-13',
          minGradeLevel: 7,
          maxGradeLevel: 9,
        });
      });

      /** An engine that refuses the payload by name, about its first timplanspost. */
      const refuseFirstRequirement = (code: string, grades: (payload: any) => string) =>
        http.post.mockImplementation((_url: string, payload: any) =>
          throwError(() => {
            const refused = new AxiosError('boom');
            refused.response = {
              status: 400,
              data: {
                message: `No room fits requirement ${payload.requirements[0].id}.`,
                details: {
                  code,
                  params: {
                    requirement: payload.requirements[0].id,
                    groupSize: 24,
                    roomType: 'any',
                    grades: grades(payload),
                  },
                },
              },
            } as never;
            return refused;
          }),
        );
      const refusedParams = async () =>
        (
          (await service.triggerScheduling(ACADEMIC_YEAR, testUser()).catch((thrown: unknown) => thrown)) as HttpException
        ).getResponse() as { code: string; params: Record<string, string | number> };

      it.each<[GradeNumbering, number, string]>([
        ['TIOARIG', 10, '10'],
        ['NIOARIG', 9, '9'],
      ])('names a refused timplanspost’s årskurs as a %s läsår numbers it', async (numbering, gradeLevel, said) => {
        /*
         * The engine echoes the span it was sent. Through the run itself, so
         * the läsår's numbering is the one fetchAndAnonymize read and handed
         * to the relay, not one a test put in a map: "Kemi för 10A (åk 10)",
         * never "Kemi för 10A (åk 9)".
         */
        yearNumbered(numbering);
        arrange({
          requirements: [requirement({ subject: { name: 'Kemi', requiredRoomTypeId: 'room-type-lab' } })],
          groups: [{ id: GROUP_ID, gradeLevel, kind: 'CLASS', name: `${gradeLevel}A` }],
        });
        refuseFirstRequirement('ROOM_NONE_ELIGIBLE_FOR_REQUIREMENT', (payload) =>
          String(payload.requirements[0].minGradeLevel),
        );

        // The English message names the row by its real id (deanonymise);
        // only the params are named for the Swedish sentence.
        expect(await refusedParams()).toEqual({
          message: `No room fits requirement ${REQ_ID}.`,
          code: 'ROOM_NONE_ELIGIBLE_FOR_REQUIREMENT',
          params: { requirement: `Kemi för ${gradeLevel}A`, groupSize: 24, roomType: 'any', grades: said },
        });
      });

      it.each<[string, string, string]>([
        ['of the tioårig läsår', '2029-03-12', '8–10'],
        ['of last year, nioårig', '2028-03-13', '7–9'],
      ])('names a dated årskursregel %s back through the run as its admin wrote it', async (_label, day, said) => {
        /*
         * Through triggerScheduling, so the maps are the run's own: the
         * numbering of each day's läsår has to reach the relay from
         * fetchAndAnonymize, not from a map a test built. The engine echoes
         * the span it was sent (7–9 both times).
         */
        yearNumbered('TIOARIG');
        arrange({
          groups: [{ id: GROUP_ID, gradeLevel: 10, kind: 'CLASS' }],
          constraints: [
            constraintRow({
              resourceType: 'GRADE_LEVEL',
              minGradeLevel: day.startsWith('2029') ? 8 : 7,
              maxGradeLevel: day.startsWith('2029') ? 10 : 9,
              dayOfWeek: null,
              date: new Date(`${day}T00:00:00.000Z`),
            }),
          ],
        });
        http.post.mockImplementation((_url: string, payload: any) =>
          throwError(() => {
            const constraint = payload.constraints[0];
            const refused = new AxiosError('boom');
            refused.response = {
              status: 400,
              data: {
                message: `Constraint ${constraint.id} is off the grid.`,
                details: {
                  code: 'INPUT_CONSTRAINT_TIME_OFF_GRID',
                  params: {
                    constraint: constraint.id,
                    kind: constraint.resourceKind,
                    resource: '',
                    grades: `${constraint.minGradeLevel}–${constraint.maxGradeLevel}`,
                    day: 0,
                    date: constraint.date,
                    start: '08:00',
                    end: '09:07',
                    slotMinutes: 5,
                  },
                },
              },
            } as never;
            return refused;
          }),
        );

        expect((await refusedParams()).params).toMatchObject({ kind: 'GRADE_LEVEL', date: day, grades: said });
      });

      it('names a class span back on a conflict too, and leaves a sitting’s as stated', async () => {
        // The INFEASIBLE route reads its conflicts through the same yearGrades
        // as the 4xx relay above.
        yearNumbered('TIOARIG');
        arrange({ groups: [{ id: GROUP_ID, gradeLevel: 10, kind: 'CLASS' }] });
        answerWithConflicts((payload) => ({
          summary: 'blocked',
          summaryCode: 'CONFLICT_CORE_SUMMARY',
          summaryParams: {},
          conflicts: [
            {
              category: 'AVAILABILITY',
              code: 'RAST_DEMANDS_A_LESSON_THAT_CANNOT_FIT',
              params: { grades: String(payload.groups[0].minGradeLevel), minutes: 60 },
              message: 'A rast demands a lesson.',
              requirementIds: [],
              roomIds: [],
              constraintIds: [],
              resourceIds: [],
            },
            {
              category: 'AVAILABILITY',
              code: 'LUNCH_SERVING_CANNOT_FEED_STAGE',
              params: { grades: '7–9', seats: 60 },
              message: 'A sitting cannot feed its stage.',
              requirementIds: [],
              roomIds: [],
              constraintIds: [],
              resourceIds: [],
            },
          ],
        }));

        const { conflicts } = (await service.triggerScheduling(ACADEMIC_YEAR, testUser())).conflicts!;

        expect(conflicts.map((detail) => detail.params)).toEqual([
          { grades: '10', minutes: 60 },
          { grades: '7–9', seats: 60 },
        ]);
      });

      /** A pupil whose home class is `studentGroupId`. */
      const pupil = (n: number, studentGroupId: string) => ({
        id: `00000000-0000-4000-8000-90000000${String(n).padStart(4, '0')}`,
        studentGroupId,
      });
      /** One timplanspost, for a teaching group of one pupil from each of two classes. */
      const arrangeAcross = (classes: [number, number]) =>
        arrange({
          requirements: [
            requirement({
              studentGroupId: TEACHING,
              subject: { name: 'Kemi', requiredRoomTypeId: 'room-type-lab' },
            }),
          ],
          homeMembers: [pupil(1, GROUP_ID), pupil(2, CLASS_8)],
          teachingMembers: [
            { studentId: pupil(1, GROUP_ID).id, studentGroupId: TEACHING },
            { studentId: pupil(2, CLASS_8).id, studentGroupId: TEACHING },
          ],
          groups: [
            { id: GROUP_ID, gradeLevel: classes[0], kind: 'CLASS' },
            { id: CLASS_8, gradeLevel: classes[1], kind: 'CLASS' },
            { id: TEACHING, gradeLevel: null, kind: 'TEACHING_GROUP' },
          ],
        });
      /** A span as the engine writes it (_grade_span_text): "9", "7–9". */
      const spanText = (payload: any) => {
        const { minGradeLevel: min, maxGradeLevel: max } = payload.requirements[0];
        return min === max ? String(min) : `${min}–${max}`;
      };

      it.each<[GradeNumbering, [number, number], string, string]>(
        [
          'FRAME_NO_WINDOW_FOR_REQUIREMENT',
          'MARGIN_NO_WINDOW_FOR_REQUIREMENT',
          'RAST_NO_STRETCH_FOR_REQUIREMENT',
          'RAST_MARGIN_NO_STRETCH_FOR_REQUIREMENT',
          'LESSON_NO_START_FOR_REQUIREMENT',
          'ROOM_NONE_ELIGIBLE_FOR_REQUIREMENT',
          'ROOM_LOCK_LEAVES_NO_ROOM',
          'RAST_DEMANDS_A_LESSON_THAT_CANNOT_FIT',
        ].flatMap((code): [GradeNumbering, [number, number], string, string][] => [
          ['TIOARIG', [10, 8], code, '8–10'],
          ['NIOARIG', [9, 7], code, '7–9'],
        ]),
      )('names a %s läsår’s group across classes %j back on a %s conflict as %s', async (numbering, classes, code, said) => {
        /*
         * The same pupils in either läsår — 10A's and 8B's, or 9A's and 7B's —
         * are sent as nioårig 7–9, and the INFEASIBLE route names the span
         * back at both ends, for each code whose `grades` is a class span.
         */
        yearNumbered(numbering);
        arrangeAcross(classes);
        answerWithConflicts((payload) => ({
          summary: 'blocked',
          summaryCode: 'CONFLICT_CORE_SUMMARY',
          summaryParams: {},
          conflicts: [
            {
              category: 'AVAILABILITY',
              code,
              params: { grades: spanText(payload), minutes: 60 },
              message: 'blocked',
              requirementIds: [],
              roomIds: [],
              constraintIds: [],
              resourceIds: [],
            },
          ],
        }));

        const { conflicts } = (await service.triggerScheduling(ACADEMIC_YEAR, testUser())).conflicts!;

        expect(conflicts.map((detail) => detail.params)).toEqual([{ grades: said, minutes: 60 }]);
      });

      it('sends specialskolans åk 11 as 10 and twelve as twelve, and names the span back as the läsår numbers it', async () => {
        /*
         * Twelve is "and above" in both numberings, so only the bottom of a
         * group of åk 11 and åk 12 pupils moves: 10–12 to the engine, each
         * class on its own as 10 and 12, and 11–12 back to the school.
         */
        yearNumbered('TIOARIG');
        arrangeAcross([12, 11]);
        refuseFirstRequirement('ROOM_NONE_ELIGIBLE_FOR_REQUIREMENT', spanText);

        const refused = await refusedParams();
        const payload = postedPayload();

        expect(payload.requirements[0]).toMatchObject({ minGradeLevel: 10, maxGradeLevel: 12 });
        expect(payload.groups.map((group) => [group.minGradeLevel, group.maxGradeLevel]).sort()).toEqual([
          [10, 10],
          [12, 12],
        ]);
        expect(refused).toMatchObject({ code: 'ROOM_NONE_ELIGIBLE_FOR_REQUIREMENT', params: { grades: '11–12' } });
      });

      it('sends a class no year can be derived for without one, not one guessed down', async () => {
        // Unknown is unrestricted to the engine, and still unknown here.
        yearNumbered('TIOARIG');
        arrange({ homeMembers: [], groups: [{ id: GROUP_ID, gradeLevel: null, kind: 'CLASS' }] });
        echoEngine();
        const warn = warnings();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());
        const payload = postedPayload();

        expect(payload.requirements[0]).toMatchObject({ minGradeLevel: null, maxGradeLevel: null });
        expect(payload.groups).toEqual([expect.objectContaining({ minGradeLevel: null, maxGradeLevel: null })]);
        expect(warn).toHaveBeenCalledWith(
          expect.stringMatching(/^1 group\(s\) with requirements have no derivable year/),
        );
      });

      it('sends a salslås and the spans that run to twelve as the school stated them', async () => {
        /*
         * A lock is a salsregel like a wish, and a frame, a sitting, a rast or
         * a room for 10–12 is nioårig 10–12: none is read one down. Each would
         * move if it were, since toNioarig takes 10 to 9.
         */
        const upper = { minGradeLevel: 10, maxGradeLevel: 12 };
        yearNumbered('TIOARIG');
        arrange({
          groups: [{ id: GROUP_ID, gradeLevel: 11, kind: 'CLASS' }],
          frames: [frame(upper)],
          servings: [serving(upper)],
          rasts: [rast(upper)],
          rooms: [{ id: ROOM_ID, capacity: 30, roomTypeId: 'room-type-lab', ...upper }],
          roomPreferences: [
            {
              id: 'lock-1',
              subjectId: SUBJECT_ID,
              kind: 'LOCK',
              ...upper,
              roomTypeId: null,
              weight: 50,
              rooms: [{ roomId: ROOM_ID }],
            },
          ],
        });
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());
        const payload = postedPayload();

        expect(payload.requirements[0]).toMatchObject({ minGradeLevel: 10, maxGradeLevel: 10 });
        expect(payload.roomPreferences[0]).toMatchObject({ kind: 'LOCK', ...upper });
        for (const span of schoolWideSpans(payload)) {
          expect(span).toMatchObject(upper);
        }
      });
    });
  });



  /*
   * The generate pre-flight. A school whose staffing policy refuses to
   * generate around a teacherless timplanspost is answered before the payload
   * is built: the engine is not called, nothing is written, and the refusal
   * comes back through realiseConflicts like an engine refusal, naming the
   * rows by subject and group and never a person.
   */
  describe('triggerScheduling — the staffing pre-flight', () => {
    let prisma: PrismaMock;
    const MA_7A = '11111111-bbbb-4bbb-8bbb-111111111111';
    const SV_7B = '11111111-bbbb-4bbb-8bbb-222222222222';

    beforeEach(() => {
      prisma = createPrismaMock(tx);
      service = new OptimizationProxyService(
        prisma as unknown as PrismaService,
        http as unknown as HttpService,
        makeConfigService(),
      );
    });

    const policy = (unstaffedGeneration: 'ALLOW' | 'REFUSE' | null) =>
      tx.staffingPolicy.findUnique.mockResolvedValue(
        unstaffedGeneration === null ? null : { unstaffedGeneration },
      );
    const unstaffed = () =>
      tx.teachingRequirement.findMany.mockImplementation((query: Query) =>
        Promise.resolve(
          query.where && 'teacherId' in query.where
            ? [
                { id: SV_7B, subject: { name: 'Svenska' }, studentGroup: { name: '7B' } },
                { id: MA_7A, subject: { name: 'Matematik' }, studentGroup: { name: '7A' } },
              ]
            : [],
        ),
      );
    const refusalOf = (schoolId = THIS_SCHOOL) =>
      (
        service as unknown as {
          unstaffedRefusal: (
            tx: PrismaClient,
            academicYearId: string,
            schoolId: string,
            requestId: string,
          ) => Promise<AiEngineScheduleResponse | null>;
        }
      ).unstaffedRefusal(tx as unknown as PrismaClient, ACADEMIC_YEAR, schoolId, 'req-1');

    it('REFUSE with teacherless rows: no engine, no write, and the rows named by subject and group', async () => {
      policy('REFUSE');
      unstaffed();

      const response = await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(http.post).not.toHaveBeenCalled();
      expect(prisma.withRls).toHaveBeenCalledTimes(1);
      expect(tx.masterLesson.deleteMany).not.toHaveBeenCalled();
      expect(tx.masterLesson.createMany).not.toHaveBeenCalled();
      expect(response.status).toBe('INFEASIBLE');
      expect(response.lessons).toEqual([]);
      expect(response.conflicts).toMatchObject({
        summaryCode: 'STAFF_UNSTAFFED_REQUIREMENTS',
        summaryParams: { count: 2 },
        conflicts: [
          {
            code: 'STAFF_UNSTAFFED_REQUIREMENTS',
            params: { count: 2 },
            // Back in real id space, in the order the names sort.
            resourceIds: [MA_7A, SV_7B],
            resourceNames: ['Matematik för 7A', 'Svenska för 7B'],
          },
        ],
      });
      expect(response.conflicts?.summary).toMatch(/^2 requirements have no teacher/);
    });

    it('asks only the policy when it allows generation without a teacher', async () => {
      policy('ALLOW');
      unstaffed();

      await expect(refusalOf()).resolves.toBeNull();
      expect(tx.teachingRequirement.findMany).not.toHaveBeenCalled();
    });

    it('a school with no policy row generates as it always has', async () => {
      policy(null);
      unstaffed();

      await expect(refusalOf()).resolves.toBeNull();
    });

    it('REFUSE with every row staffed goes on to the engine', async () => {
      policy('REFUSE');
      tx.teachingRequirement.findMany.mockResolvedValue([]);

      await expect(refusalOf()).resolves.toBeNull();
      expect(tx.teachingRequirement.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { academicYearId: ACADEMIC_YEAR, teacherId: null } }),
      );
    });

    it('reads the caller’s own school’s policy', async () => {
      policy('ALLOW');

      await refusalOf();

      expect(tx.staffingPolicy.findUnique).toHaveBeenCalledWith({
        where: { schoolId: THIS_SCHOOL },
        select: { unstaffedGeneration: true },
      });
    });
  });
});
