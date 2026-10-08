import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { LessonRecurrence, PrismaClient } from '@prisma/client';
import { AxiosError } from 'axios';
import { of, throwError } from 'rxjs';
import {
  createPrismaMock,
  createTxMock,
  testUser,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import { ScheduleVersionsService } from '../calendar/schedule-versions.service';
import type { PrismaService } from '../database/prisma.service';
import type { RealtimeService } from '../realtime/realtime.service';
import type {
  OptimizeRoomsRequest,
  OptimizeRoomsResponse,
  Walk,
} from './interfaces/room-walks.interface';
import { OptimizationProxyService } from './optimization-proxy.service';
import * as eligibility from './room-eligibility';
import {
  ROOM_CLASH,
  ROOM_PROPOSAL_STALE,
  ROOM_SNAPSHOT_NAME,
  RoomOptimizationService,
  type RoomMove,
} from './room-optimization.service';

const YEAR = '44444444-4444-4444-8444-444444444444';
const SCHOOL = '33333333-3333-4333-8333-333333333333';
const VERSION = '55555555-5555-4555-8555-555555555555';
const SUBJECT = '66666666-6666-4666-8666-666666666666';
/** A year of another school, whose rows must never reach this school's proposal. */
const OTHER_YEAR = '44444444-4444-4444-8444-4444444444ff';
const OTHER_SCHOOL = '33333333-3333-4333-8333-3333333333ff';

// Rooms: two on different floors of the main house, one in the annex.
const ROOM_1 = 'a0000000-0000-4000-8000-000000000001';
const ROOM_10 = 'a0000000-0000-4000-8000-000000000010';
const ROOM_ANNEX = 'a0000000-0000-4000-8000-0000000000ff';

const ELIN = 'b0000000-0000-4000-8000-00000000e11e';
const ALEXANDER = 'b0000000-0000-4000-8000-0000000a1e70';
const OTHER_TEACHER = 'b0000000-0000-4000-8000-000000000077';
const GROUP_7A = 'c0000000-0000-4000-8000-0000000007aa';
const GROUP_7B = 'c0000000-0000-4000-8000-0000000007bb';
const GROUP_7C = 'c0000000-0000-4000-8000-0000000007cc';

// The school's own case: Elin 1 → 10 and Alexander 10 → 1 at the same bell.
const ELIN_FIRST = 'd0000000-0000-4000-8000-0000000000e1';
const ELIN_SECOND = 'd0000000-0000-4000-8000-0000000000e2';
const ALEX_FIRST = 'd0000000-0000-4000-8000-0000000000a1';
const ALEX_SECOND = 'd0000000-0000-4000-8000-0000000000a2';
const EXTRA = 'd0000000-0000-4000-8000-0000000000ff';
const EXTRA_TWO = 'd0000000-0000-4000-8000-0000000000fe';

const clockAt = (h: number, m = 0) => new Date(Date.UTC(1970, 0, 1, h, m));

type LessonFixture = {
  id: string;
  /** This school's year unless a test says otherwise; never selected. */
  academicYearId?: string;
  subjectId: string;
  studentGroupId: string;
  teacherId: string | null;
  coTeacherId: string | null;
  roomId: string | null;
  dayOfWeek: number;
  startTime: Date;
  endTime: Date;
  recurrence: LessonRecurrence;
  startDate: Date | null;
  endDate: Date | null;
  isLocked: boolean;
  isParked: boolean;
  extraGroups: { studentGroupId: string }[];
  participants: { studentId: string }[];
  subject: { requiredRoomTypeId: string | null; name?: string };
};

const lesson = (id: string, overrides: Partial<LessonFixture> = {}): LessonFixture => ({
  id,
  subjectId: SUBJECT,
  studentGroupId: GROUP_7A,
  teacherId: ELIN,
  coTeacherId: null,
  roomId: ROOM_1,
  dayOfWeek: 1,
  startTime: clockAt(8),
  endTime: clockAt(9),
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  isLocked: false,
  isParked: false,
  extraGroups: [],
  participants: [],
  subject: { requiredRoomTypeId: null },
  ...overrides,
});

const elinAndAlexander = (): LessonFixture[] => [
  lesson(ELIN_FIRST, { roomId: ROOM_1 }),
  lesson(ELIN_SECOND, { roomId: ROOM_10, startTime: clockAt(9), endTime: clockAt(10) }),
  lesson(ALEX_FIRST, { teacherId: ALEXANDER, studentGroupId: GROUP_7B, roomId: ROOM_10 }),
  lesson(ALEX_SECOND, {
    teacherId: ALEXANDER,
    studentGroupId: GROUP_7B,
    roomId: ROOM_1,
    startTime: clockAt(9),
    endTime: clockAt(10),
  }),
];

type RoomFixture = {
  id: string;
  /** This school unless a test says otherwise; never selected. */
  schoolId?: string;
  capacity: number | null;
  roomTypeId: string | null;
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
  building: string | null;
  floor: number | null;
  name?: string;
};

const standardRooms = (): RoomFixture[] => [
  // Names ride along on the fixture so a leak would be visible; the service
  // never selects them.
  { id: ROOM_1, capacity: 30, roomTypeId: null, minGradeLevel: null, maxGradeLevel: null, building: 'Hus A', floor: 1, name: 'Sal 1' },
  { id: ROOM_10, capacity: 30, roomTypeId: null, minGradeLevel: null, maxGradeLevel: null, building: 'Hus A', floor: 2, name: 'Sal 10' },
  { id: ROOM_ANNEX, capacity: 30, roomTypeId: null, minGradeLevel: null, maxGradeLevel: null, building: 'Annexet', floor: null, name: 'Paviljongen' },
];

/** A published lesson, as the calendar holds it. */
type CalendarFixture = {
  id: string;
  masterLessonId: string;
  roomId: string | null;
  date: Date;
  startsAt: Date;
  status: 'SCHEDULED' | 'CANCELLED';
  attended: boolean;
};

/** Far enough either side of any day these tests run on. */
const FUTURE = new Date('2099-03-02T00:00:00.000Z');
const PAST = new Date('2001-03-05T00:00:00.000Z');

const published = (
  id: string,
  masterLessonId: string,
  roomId: string | null,
  overrides: Partial<CalendarFixture> = {},
): CalendarFixture => {
  const date = overrides.date ?? FUTURE;
  return {
    id,
    masterLessonId,
    roomId,
    date,
    // Eight in the morning UTC of its day, unless a row says otherwise.
    startsAt: new Date(date.getTime() + 8 * 3_600_000),
    status: 'SCHEDULED',
    attended: false,
    ...overrides,
  };
};

const walkOf = (roomChanges: number, floorChanges = 0, buildingChanges = 0): Walk => ({
  roomChanges,
  floorChanges,
  buildingChanges,
});
const still = () => ({ before: walkOf(0), after: walkOf(0) });

/** A room rule, as RoomPreferences holds it. */
type WishFixture = {
  id: string;
  subjectId: string;
  kind: 'WISH' | 'LOCK';
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
  roomTypeId: string | null;
  weight: number;
  rooms: { roomId: string }[];
};
const wish = (id: string, overrides: Partial<WishFixture> = {}): WishFixture => ({
  id,
  subjectId: SUBJECT,
  kind: 'WISH',
  minGradeLevel: null,
  maxGradeLevel: null,
  roomTypeId: null,
  weight: 5,
  rooms: [{ roomId: ROOM_1 }],
  ...overrides,
});

/** A reservation, as AvailabilityConstraints holds it: by default room 10 closed on Wednesdays. */
type ClosureFixture = {
  id: string;
  schoolId: string;
  resourceType: string;
  type: string;
  roomId: string | null;
  dayOfWeek: number | null;
  date: Date | null;
  startTime: Date;
  endTime: Date;
};
const closure = (id: string, overrides: Partial<ClosureFixture> = {}): ClosureFixture => ({
  id,
  schoolId: SCHOOL,
  resourceType: 'ROOM',
  type: 'UNAVAILABLE',
  roomId: ROOM_10,
  dayOfWeek: 3,
  date: null,
  startTime: clockAt(12),
  endTime: clockAt(13),
  ...overrides,
});

type GroupFixture = { id: string; gradeLevel: number | null; academicYearId?: string };
type Person = { id: string; role: 'STUDENT' | 'TEACHER'; isActive: boolean; studentGroupId: string | null };
const student = (id: string, studentGroupId: string): Person => ({
  id,
  role: 'STUDENT',
  isActive: true,
  studentGroupId,
});

type Row = Record<string, unknown>;
type Selection = Record<string, unknown> | undefined;
type Query = { where?: Row; select?: Selection };

/*
 * The tables answer as Prisma does. A select returns the fields it names and
 * nothing else, a relation only through its own select, scalars only when no
 * select is given — and a select naming nothing is refused, as the engine
 * refuses it (EmptySelection). A field the service stops selecting is a field
 * its code no longer gets.
 */
const isRelation = (value: unknown): boolean =>
  Array.isArray(value) ||
  (value !== null && typeof value === 'object' && !(value instanceof Date));
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

/** The school a year belongs to, for the year -> school hop the reads take. */
const schoolOfYear = (yearId: string): string => (yearId === YEAR ? SCHOOL : OTHER_SCHOOL);

/**
 * A where clause as Prisma applies it, for the filters these reads use. An
 * empty filter object is no condition, as in Prisma; a filter this does not
 * know is refused, so a new condition cannot pass here by being ignored.
 */
const matches = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([key, filter]) => {
    const value = filter as Record<string, any>;
    switch (key) {
      case 'academicYearId':
        return (row['academicYearId'] ?? YEAR) === filter;
      case 'school': {
        const yearId: string | undefined = value?.academicYears?.some?.id;
        return yearId === undefined || (row['schoolId'] ?? SCHOOL) === schoolOfYear(yearId);
      }
      case 'roomId':
        return !('not' in value) || row['roomId'] !== value['not'];
      case 'studentGroupId':
      case 'id':
        return value['in'] === undefined || (value['in'] as unknown[]).includes(row[key]);
      case 'resourceType':
      case 'type':
      case 'date':
      case 'role':
      case 'isActive':
        return row[key] === filter;
      default:
        throw new Error(`unexpected filter ${key}`);
    }
  });

describe('RoomOptimizationService', () => {
  let tx: TxMock;
  let prisma: PrismaMock;
  let http: { post: jest.Mock };
  let versions: ScheduleVersionsService;
  let realtime: { notifyMasterTimetableChanged: jest.Mock };
  let service: RoomOptimizationService;
  /** The MasterLessons table: read by findMany, written by updateMany. */
  let rows: LessonFixture[];
  let rooms: RoomFixture[];
  /** The CalendarLessons table: written by updateMany. */
  let calendar: CalendarFixture[];
  let executeRaw: jest.Mock;
  /** RoomPreferences, AvailabilityConstraints, StudentGroups: empty unless a test fills them. */
  let preferences: WishFixture[];
  let closures: ClosureFixture[];
  let groups: GroupFixture[];
  /** Users and StudentGroupMembers, for the rosters a lesson's room needs come from. */
  let people: Person[];
  let memberships: { studentId: string; studentGroupId: string }[];
  let sent: OptimizeRoomsRequest | undefined;
  const user = testUser();

  /** Reconstructs the SQL text of a tagged-template $executeRaw call. */
  const rawSql = (call: unknown[]): string => (call[0] as readonly string[]).join('?');

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    http = { post: jest.fn() };
    const config = {
      getOrThrow: jest.fn().mockReturnValue({
        baseUrl: 'http://solver.test',
        apiKey: 'k'.repeat(32),
        timeoutMs: 50,
      }),
    };
    const proxy = new OptimizationProxyService(
      prisma as unknown as PrismaService,
      http as never,
      config as never,
    );
    // The real versions service over the same mock: the apply's snapshot is
    // part of what is under test, not something to stub away.
    versions = new ScheduleVersionsService(prisma as unknown as PrismaService);
    realtime = { notifyMasterTimetableChanged: jest.fn() };
    service = new RoomOptimizationService(
      prisma as unknown as PrismaService,
      proxy,
      versions,
      realtime as unknown as RealtimeService,
    );

    rows = elinAndAlexander();
    rooms = standardRooms();
    calendar = [];
    preferences = [];
    closures = [];
    groups = [];
    people = [];
    memberships = [];
    sent = undefined;

    // The proxy vivifies models, not raw statements: the year's lock needs a
    // callable of its own.
    executeRaw = jest.fn().mockResolvedValue(0);
    Object.assign(tx, { $executeRaw: executeRaw });

    tx.academicYear.findUnique.mockImplementation(async ({ where, select }: Query = {}) => {
      // Prisma refuses a findUnique that names no unique field.
      if (typeof where?.['id'] !== 'string') throw new Error('findUnique needs a unique where');
      assertSelects(select);
      return where['id'] === YEAR ? selected({ id: YEAR, schoolId: SCHOOL }, select) : null;
    });
    const table =
      (read: () => Row[]) =>
      async ({ where, select }: Query = {}) => {
        assertSelects(select);
        return read()
          .filter((row) => matches(row, where))
          .map((row) => selected(row, select));
      };
    tx.masterLesson.findMany.mockImplementation(table(() => rows));
    tx.room.findMany.mockImplementation(table(() => rooms));
    tx.roomPreference.findMany.mockImplementation(table(() => preferences));
    tx.availabilityConstraint.findMany.mockImplementation(table(() => closures));
    tx.studentGroup.findMany.mockImplementation(table(() => groups));
    tx.user.findMany.mockImplementation(table(() => people));
    // A membership counts when its pupil passes the `student` filter.
    tx.studentGroupMember.findMany.mockImplementation(async ({ where = {}, select }: Query = {}) => {
      assertSelects(select);
      const { student: ofStudent, ...own } = where;
      return memberships
        .filter((row) => matches(row, own))
        .filter((row) => {
          const person = people.find((candidate) => candidate.id === row.studentId);
          return person !== undefined && matches(person, ofStudent as Row | undefined);
        })
        .map((row) => selected(row, select));
    });
    // A faithful little table: every filter the service passes is honoured,
    // so a dropped filter moves lessons it should not.
    tx.masterLesson.updateMany.mockImplementation(
      async ({ where, data }: { where: Record<string, any>; data: { roomId: string } }) => {
        let count = 0;
        rows = rows.map((row) => {
          const matches =
            (where.id === undefined || where.id.in.includes(row.id)) &&
            (where.academicYearId === undefined || where.academicYearId === YEAR) &&
            (!('roomId' in where) || where.roomId === row.roomId);
          if (!matches) return row;
          count++;
          return { ...row, roomId: data.roomId };
        });
        return { count };
      },
    );
    // The same for the calendar, and it refuses a filter it does not know, so
    // a new condition cannot pass here by being ignored.
    tx.calendarLesson.updateMany.mockImplementation(
      async ({ where, data }: { where: Record<string, any>; data: { roomId: string } }) => {
        const known = ['masterLessonId', 'status', 'date', 'startsAt', 'attendanceRecords', 'roomId'];
        for (const key of Object.keys(where)) {
          if (!known.includes(key)) throw new Error(`unexpected calendar filter ${key}`);
        }
        let count = 0;
        calendar = calendar.map((row) => {
          const lessonIds: string[] | undefined =
            where.masterLessonId === undefined
              ? undefined
              : typeof where.masterLessonId === 'string'
                ? [where.masterLessonId]
                : where.masterLessonId.in;
          const matches =
            (lessonIds === undefined || lessonIds.includes(row.masterLessonId)) &&
            (where.status === undefined || where.status === row.status) &&
            (where.date === undefined || row.date.getTime() >= where.date.gte.getTime()) &&
            (where.startsAt === undefined || row.startsAt.getTime() > where.startsAt.gt.getTime()) &&
            (where.attendanceRecords === undefined || !row.attended) &&
            (!('roomId' in where) || where.roomId === row.roomId);
          if (!matches) return row;
          count++;
          return { ...row, roomId: data.roomId };
        });
        return { count };
      },
    );
    tx.scheduleVersion.create.mockResolvedValue({
      id: VERSION,
      academicYearId: YEAR,
      name: ROOM_SNAPSHOT_NAME,
      lessonCount: 4,
      createdAt: new Date('2026-09-11T10:00:00.000Z'),
    });
    tx.scheduleChangeLog.createMany.mockResolvedValue({ count: 0 });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** The engine: answers with what `answer` builds from the payload it got. */
  const engine = (
    answer: (payload: OptimizeRoomsRequest) => Partial<OptimizeRoomsResponse> = () => ({}),
  ) => {
    http.post.mockImplementation((_url: string, payload: OptimizeRoomsRequest) => {
      sent = payload;
      return of({
        data: {
          requestId: payload.requestId,
          status: 'OPTIMAL',
          changes: [],
          teachers: still(),
          groups: still(),
          missedWishes: { before: 0, after: 0 },
          walkers: [],
          frozenLessonIds: [],
          ...answer(payload),
        },
      });
    });
  };

  /**
   * A lesson's anonymous id, by its real one. The payload lists the lessons it
   * sends in the order they were read, parked ones left out.
   */
  const anonLesson = (payload: OptimizeRoomsRequest, realId: string): string => {
    const sendable = rows.filter(
      (row) => !row.isParked && row.endTime.getTime() > row.startTime.getTime(),
    );
    const index = sendable.findIndex((row) => row.id === realId);
    if (index < 0) throw new Error(`lesson ${realId} was not sent`);
    return payload.lessons[index]!.id;
  };
  const anonRoom = (payload: OptimizeRoomsRequest, realId: string): string =>
    payload.rooms[rooms.findIndex((room) => room.id === realId)]!.id;
  const sentLesson = (realId: string) =>
    sent!.lessons.find((entry) => entry.id === anonLesson(sent!, realId))!;

  /** The swap the school asked for: each teacher stays in one room. */
  const swap = (payload: OptimizeRoomsRequest): Partial<OptimizeRoomsResponse> => ({
    changes: [
      { lessonId: anonLesson(payload, ELIN_SECOND), roomId: anonRoom(payload, ROOM_1) },
      { lessonId: anonLesson(payload, ALEX_SECOND), roomId: anonRoom(payload, ROOM_10) },
    ],
    teachers: { before: walkOf(2, 2), after: walkOf(0) },
  });

  const propose = () => service.propose({ academicYearId: YEAR, walkers: 'TEACHERS' }, user);

  /** The basis of the timetable as it stands, as the page would hold it. */
  const basisNow = async () => {
    engine();
    return (await propose()).basis;
  };

  const reversed = (changes: RoomMove[]): RoomMove[] =>
    changes.map((change) => ({
      lessonId: change.lessonId,
      fromRoomId: change.toRoomId,
      toRoomId: change.fromRoomId,
    }));

  describe('propose — the payload', () => {
    it('posts to the engine’s room route', async () => {
      engine();
      await propose();

      expect(http.post).toHaveBeenCalledWith(
        'http://solver.test/api/v1/optimize-rooms',
        expect.anything(),
        expect.anything(),
      );
    });

    it('sends no names and no real ids, and buildings only as tokens', async () => {
      rows[0]!.subject = { requiredRoomTypeId: null, name: 'Matematik' };
      engine();

      await propose();

      const text = JSON.stringify(sent);
      for (const leak of [
        'Sal 1',
        'Sal 10',
        'Paviljongen',
        'Matematik',
        'Hus A',
        'Annexet',
        ROOM_1,
        ROOM_10,
        ELIN,
        ALEXANDER,
        GROUP_7A,
        SUBJECT,
        ELIN_FIRST,
      ]) {
        expect(text).not.toContain(leak);
      }
      // The engine only needs equality: the two rooms of Hus A share one
      // token, the annex has another, and floors pass through as they are.
      const [first, tenth, annex] = sent!.rooms;
      expect(first!.building).toBe(tenth!.building);
      expect(annex!.building).not.toBe(first!.building);
      expect(first!.building).toEqual(expect.any(String));
      expect(sent!.rooms.map((room) => room.floor)).toEqual([1, 2, null]);
      // And the queries never asked for a name in the first place.
      expect(tx.room.findMany.mock.calls[0][0].select).not.toHaveProperty('name');
    });

    it('sends a room with no building as none, not as a token', async () => {
      rooms[2]!.building = null;
      engine();

      await propose();

      expect(sent!.rooms[2]!.building).toBeNull();
    });

    it('sends the walkers the school chose', async () => {
      engine();

      await service.propose({ academicYearId: YEAR, walkers: 'BOTH' }, user);

      expect(sent!.walkers).toBe('BOTH');
    });

    it('sends a locked lesson as immovable and every other as movable', async () => {
      rows[1]!.isLocked = true;
      engine();

      await propose();

      expect(sentLesson(ELIN_SECOND).movable).toBe(false);
      expect(sentLesson(ELIN_FIRST).movable).toBe(true);
    });

    it('leaves a parked lesson out altogether', async () => {
      rows.push(lesson(EXTRA, { isParked: true, roomId: ROOM_ANNEX }));
      engine();

      await propose();

      expect(sent!.lessons).toHaveLength(4);
      expect(() => anonLesson(sent!, EXTRA)).toThrow('was not sent');
    });

    it('sends a roomless lesson with no room, so it still breaks a walk', async () => {
      rows.push(lesson(EXTRA, { roomId: null, startTime: clockAt(10), endTime: clockAt(11) }));
      engine();

      await propose();

      expect(sent!.lessons).toHaveLength(5);
      expect(sentLesson(EXTRA)).toMatchObject({ roomId: null, movable: true });
    });

    it('leaves out a lesson that ends before it starts', async () => {
      rows.push(lesson(EXTRA, { startTime: clockAt(11), endTime: clockAt(10) }));
      engine();

      await propose();

      expect(sent!.lessons).toHaveLength(4);
    });

    it('sends minutes as HH:MM:SS, the lesson’s weeks and both its teachers', async () => {
      rows[0] = lesson(ELIN_FIRST, {
        startTime: clockAt(8, 5),
        endTime: clockAt(8, 50),
        recurrence: 'ODD_WEEKS',
        startDate: new Date('2026-08-17T00:00:00.000Z'),
        endDate: new Date('2027-06-11T00:00:00.000Z'),
        coTeacherId: ALEXANDER,
      });
      engine();

      await propose();

      expect(sentLesson(ELIN_FIRST)).toMatchObject({
        dayOfWeek: 1,
        startTime: '08:05:00',
        endTime: '08:50:00',
        recurrence: 'ODD_WEEKS',
        startDate: '2026-08-17',
        endDate: '2027-06-11',
      });
      // Alexander beside Elin is the Alexander who teaches 7B: one walker, one token.
      expect(sentLesson(ELIN_FIRST).coTeacherId).toBe(sentLesson(ALEX_FIRST).teacherId);
    });

    it('sizes a lesson by every pupil in it, once, and spans their years', async () => {
      /*
       * 7A holds S1, S2 and S3; the teaching group Ma holds S2 again and S3;
       * one pupil from 8A is named on the lesson alone. Four chairs, years 7-8
       * — and year 8 only through the pupil named, whose home class is read
       * for that reason. The room must hold all of them and suit every year
       * among them.
       */
      const MA = 'c0000000-0000-4000-8000-00000000000a';
      const GROUP_8A = 'c0000000-0000-4000-8000-0000000008aa';
      const LAB_TYPE = 'f0000000-0000-4000-8000-000000000001';
      const [s1, s2, s3, named] = [1, 2, 3, 4].map(
        (n) => `e0000000-0000-4000-8000-00000000000${n}`,
      ) as [string, string, string, string];
      rows = [
        lesson(ELIN_FIRST, {
          extraGroups: [{ studentGroupId: MA }],
          participants: [{ studentId: named }],
          subject: { requiredRoomTypeId: LAB_TYPE },
        }),
      ];
      rooms.push({
        id: EXTRA,
        capacity: 24,
        roomTypeId: LAB_TYPE,
        minGradeLevel: 7,
        maxGradeLevel: 9,
        building: null,
        floor: null,
      });
      groups = [
        { id: GROUP_7A, gradeLevel: 7 },
        { id: MA, gradeLevel: null },
        { id: GROUP_8A, gradeLevel: 8 },
      ];
      people = [
        student(s1, GROUP_7A),
        student(s2, GROUP_7A),
        student(s3, GROUP_7A),
        student(named, GROUP_8A),
      ];
      memberships = [
        { studentId: s2, studentGroupId: MA },
        { studentId: s3, studentGroupId: MA },
      ];
      engine();

      await propose();

      const sentOne = sent!.lessons[0]!;
      expect(sentOne).toMatchObject({
        studentGroupSize: 4,
        minGradeLevel: 7,
        maxGradeLevel: 8,
      });
      expect(sentOne.extraGroupIds).toHaveLength(1);
      // The same token the lab room carries, and not the school's id for it.
      expect(sentOne.requiredRoomType).toBe(sent!.rooms[3]!.type);
      expect(sentOne.requiredRoomType).not.toBe(LAB_TYPE);
      // And the lab's own limits, as the school set them.
      expect(sent!.rooms[3]).toMatchObject({ capacity: 24, minGradeLevel: 7, maxGradeLevel: 9 });
    });

    it('derives each lesson’s room needs through the generator’s own derivation', async () => {
      /*
       * "May only move into a room the generator would allow" holds only while
       * both read size, years and room type through one function. A copy
       * inlined here would pass every other test and drift the first time
       * either side is fixed.
       */
      const needs = jest.spyOn(eligibility, 'roomNeedsOf');
      engine();

      await propose();

      expect(needs).toHaveBeenCalledTimes(4);
      expect(needs).toHaveBeenCalledWith(
        expect.anything(),
        { groupIds: [GROUP_7A], studentIds: [] },
        { requiredRoomTypeId: null },
      );
    });

    it('sends only a room closed on a weekday, under the room’s token', async () => {
      closures = [closure('f1000000-0000-4000-8000-000000000001')];
      engine();

      await propose();

      expect(tx.availabilityConstraint.findMany.mock.calls[0][0].where).toMatchObject({
        resourceType: 'ROOM',
        type: 'UNAVAILABLE',
        date: null,
        roomId: { not: null },
      });
      expect(sent!.constraints).toEqual([
        {
          id: expect.any(String),
          resourceKind: 'ROOM',
          resourceId: anonRoom(sent!, ROOM_10),
          dayOfWeek: 3,
          date: null,
          startTime: '12:00:00',
          endTime: '13:00:00',
          kind: 'UNAVAILABLE',
        },
      ]);
    });

    it('sends a room wish under the same subject and room tokens as the lessons', async () => {
      preferences = [wish('f2000000-0000-4000-8000-000000000001')];
      engine();

      await propose();

      expect(sent!.roomPreferences[0]).toMatchObject({
        subjectId: sentLesson(ELIN_FIRST).subjectId,
        roomIds: [anonRoom(sent!, ROOM_1)],
        kind: 'WISH',
        weight: 5,
      });
    });
  });

  describe('propose — what is read', () => {
    const LAB_TYPE = 'f0000000-0000-4000-8000-000000000001';
    const GONE_ROOM = 'a0000000-0000-4000-8000-0000000000dd';

    it('reads nothing of another school’s year', async () => {
      /*
       * The lessons by the year, the rooms through the year's own school: a
       * proposal asked for this year must not be drawn up over another
       * school's rooms, or move a lesson of another year.
       */
      rows.push(
        lesson(EXTRA, {
          academicYearId: OTHER_YEAR,
          roomId: ROOM_ANNEX,
          startTime: clockAt(13),
          endTime: clockAt(14),
        }),
      );
      rooms.push({
        id: 'a0000000-0000-4000-8000-0000000000aa',
        schoolId: OTHER_SCHOOL,
        capacity: 30,
        roomTypeId: null,
        minGradeLevel: null,
        maxGradeLevel: null,
        building: null,
        floor: null,
      });
      engine();

      const proposal = await propose();

      expect(sent!.lessons).toHaveLength(4);
      expect(sent!.rooms).toHaveLength(3);
      expect(proposal.roomsTotal).toBe(3);
      // The years the groups carry are read for this year alone too.
      expect(tx.studentGroup.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { academicYearId: YEAR } }),
      );
    });

    it('sends a lesson’s other class under the token that class’s own lessons carry', async () => {
      // The engine follows a class from room to room by its token, so 7C on
      // Elin's lesson and 7C on its own lesson have to be one walker.
      rows[0]!.extraGroups = [{ studentGroupId: GROUP_7C }];
      rows.push(
        lesson(EXTRA, {
          teacherId: OTHER_TEACHER,
          studentGroupId: GROUP_7C,
          roomId: ROOM_ANNEX,
          startTime: clockAt(10),
          endTime: clockAt(11),
        }),
      );
      engine();

      await propose();

      expect(sentLesson(ELIN_FIRST).extraGroupIds).toEqual([sentLesson(EXTRA).studentGroupId]);
    });

    it('sends a room rule with the rooms that still exist, under the payload’s own tokens', async () => {
      // A rule naming a room since removed names nothing the engine could put
      // a lesson in. It goes without that room, not with an id the engine
      // cannot resolve.
      rooms[1]!.roomTypeId = LAB_TYPE;
      preferences = [
        wish('f2000000-0000-4000-8000-000000000001', {
          kind: 'LOCK',
          minGradeLevel: 7,
          maxGradeLevel: 9,
          roomTypeId: LAB_TYPE,
          rooms: [{ roomId: ROOM_1 }, { roomId: GONE_ROOM }],
        }),
      ];
      engine();

      await propose();

      expect(sent!.rooms[1]!.type).toEqual(expect.any(String));
      expect(sent!.roomPreferences).toStrictEqual([
        {
          id: expect.any(String),
          subjectId: sentLesson(ELIN_FIRST).subjectId,
          kind: 'LOCK',
          minGradeLevel: 7,
          maxGradeLevel: 9,
          roomType: sent!.rooms[1]!.type,
          roomIds: [anonRoom(sent!, ROOM_1)],
          weight: 5,
        },
      ]);
    });

    it('leaves out a closure of a room the payload does not carry', async () => {
      // Sent, it would be a reservation naming no resource the engine was given.
      closures = [closure('f1000000-0000-4000-8000-000000000001', { roomId: GONE_ROOM })];
      engine();

      await propose();

      expect(sent!.constraints).toEqual([]);
    });

    it('turns the ids in an engine refusal back into rows the school can find', async () => {
      /*
       * The room route refuses a payload by naming what is wrong in the ids it
       * was sent. Read back through the maps this request minted — lessons,
       * room rules in the requirement slot, closures — the sentence names real
       * rows instead of uuids that exist in no table.
       */
      const RULE = 'f2000000-0000-4000-8000-000000000001';
      const CLOSED = 'f1000000-0000-4000-8000-000000000001';
      preferences = [wish(RULE)];
      closures = [closure(CLOSED)];
      http.post.mockImplementation((_url: string, payload: OptimizeRoomsRequest) => {
        const refused = new AxiosError('refused');
        refused.response = {
          status: 422,
          data: {
            message:
              `Lesson ${anonLesson(payload, ELIN_FIRST)} breaks rule ` +
              `${payload.roomPreferences[0]!.id} and closure ${payload.constraints[0]!.id}.`,
          },
        } as never;
        return throwError(() => refused);
      });

      const error = await propose().catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(422);
      expect((error as HttpException).message).toBe(
        `Lesson ${ELIN_FIRST} breaks rule ${RULE} and closure ${CLOSED}.`,
      );
    });
  });

  describe('propose — the answer', () => {
    it('writes nothing', async () => {
      engine(swap);

      await propose();

      expect(tx.masterLesson.updateMany).not.toHaveBeenCalled();
      expect(tx.masterLesson.update).not.toHaveBeenCalled();
      expect(tx.calendarLesson.updateMany).not.toHaveBeenCalled();
      expect(tx.scheduleVersion.create).not.toHaveBeenCalled();
      expect(tx.scheduleChangeLog.createMany).not.toHaveBeenCalled();
      expect(rows).toEqual(elinAndAlexander());
    });

    it('names every change in real ids, with the room it moves from', async () => {
      engine(swap);

      const proposal = await propose();

      expect(proposal.status).toBe('OPTIMAL');
      expect(proposal.changes).toEqual([
        { lessonId: ELIN_SECOND, fromRoomId: ROOM_10, toRoomId: ROOM_1 },
        { lessonId: ALEX_SECOND, fromRoomId: ROOM_1, toRoomId: ROOM_10 },
      ]);
      expect(proposal.teachers).toEqual({ before: walkOf(2, 2), after: walkOf(0) });
    });

    it('turns walkers and frozen lessons back into real ids, dropping unknown ones', async () => {
      engine((payload) => ({
        walkers: [
          {
            kind: 'TEACHER',
            id: anonLesson(payload, ELIN_FIRST) && payload.lessons[0]!.teacherId!,
            before: walkOf(1, 1),
            after: walkOf(0),
          },
          {
            kind: 'GROUP',
            id: payload.lessons[2]!.studentGroupId,
            before: walkOf(1),
            after: walkOf(0),
          },
          { kind: 'TEACHER', id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', before: walkOf(1), after: walkOf(0) },
        ],
        frozenLessonIds: [anonLesson(payload, ALEX_FIRST), 'not-a-lesson'],
      }));

      const proposal = await propose();

      expect(proposal.walkers).toEqual([
        { kind: 'TEACHER', id: ELIN, before: walkOf(1, 1), after: walkOf(0) },
        { kind: 'GROUP', id: GROUP_7B, before: walkOf(1), after: walkOf(0) },
      ]);
      expect(proposal.frozenLessonIds).toEqual([ALEX_FIRST]);
    });

    it('keeps the engine’s order of the walkers, most improved first', async () => {
      /*
       * The page lists the walkers in the order it gets them and does not sort
       * them again. So the order is pinned here in one no key would reproduce:
       * neither by kind, nor by id either way — only the engine's weighting
       * (a building is 12, a floor 4, a room 1) puts Alexander, 7B, Elin.
       */
      engine((payload) => ({
        walkers: [
          { kind: 'TEACHER', id: payload.lessons[2]!.teacherId!, before: walkOf(1, 0, 1), after: walkOf(0) },
          { kind: 'GROUP', id: payload.lessons[2]!.studentGroupId, before: walkOf(1, 1), after: walkOf(0) },
          { kind: 'TEACHER', id: payload.lessons[0]!.teacherId!, before: walkOf(1), after: walkOf(0) },
        ],
      }));

      const proposal = await propose();

      expect(proposal.walkers.map((walker) => [walker.kind, walker.id])).toEqual([
        ['TEACHER', ALEXANDER],
        ['GROUP', GROUP_7B],
        ['TEACHER', ELIN],
      ]);
    });

    it('counts the rooms and those with no floor, for the page’s hint', async () => {
      engine();

      await expect(propose()).resolves.toMatchObject({
        roomsTotal: 3,
        roomsWithoutFloor: 1,
      });
    });

    it.each([
      ['a locked lesson', (payload: OptimizeRoomsRequest) => {
        rows[1]!.isLocked = true;
        return { lessonId: anonLesson(payload, ELIN_SECOND), roomId: anonRoom(payload, ROOM_1) };
      }],
      ['a lesson it never sent', (payload: OptimizeRoomsRequest) => ({
        lessonId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        roomId: anonRoom(payload, ROOM_1),
      })],
      ['a room it never sent', (payload: OptimizeRoomsRequest) => ({
        lessonId: anonLesson(payload, ELIN_SECOND),
        roomId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      })],
      ['the room the lesson is already in', (payload: OptimizeRoomsRequest) => ({
        lessonId: anonLesson(payload, ELIN_SECOND),
        roomId: anonRoom(payload, ROOM_10),
      })],
    ])('refuses an answer that moves %s', async (_label, change) => {
      if (_label === 'a locked lesson') rows[1]!.isLocked = true;
      engine((payload) => ({ changes: [change(payload)] }));

      const error = await propose().catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(HttpStatus.BAD_GATEWAY);
      expect((error as HttpException).message).toBe(
        'The AI engine returned a room proposal that does not match the request.',
      );
    });

    it('refuses an answer that moves a roomless lesson', async () => {
      rows.push(lesson(EXTRA, { roomId: null, startTime: clockAt(10), endTime: clockAt(11) }));
      engine((payload) => ({
        changes: [{ lessonId: anonLesson(payload, EXTRA), roomId: anonRoom(payload, ROOM_1) }],
      }));

      await expect(propose()).rejects.toThrow(HttpException);
    });

    it('refuses an answer that moves a lesson it also calls frozen', async () => {
      engine((payload) => ({
        changes: [{ lessonId: anonLesson(payload, ELIN_SECOND), roomId: anonRoom(payload, ROOM_1) }],
        frozenLessonIds: [anonLesson(payload, ELIN_SECOND)],
      }));

      await expect(propose()).rejects.toThrow(HttpException);
    });

    it('answers without the engine when the school has no rooms', async () => {
      rooms = [];
      rows = rows.map((row) => ({ ...row, roomId: null }));

      const proposal = await propose();

      expect(http.post).not.toHaveBeenCalled();
      expect(proposal).toMatchObject({
        status: 'OPTIMAL',
        changes: [],
        teachers: still(),
        groups: still(),
        missedWishes: { before: 0, after: 0 },
        walkers: [],
        frozenLessonIds: [],
        roomsTotal: 0,
      });
    });

    it('answers without the engine when every lesson is parked', async () => {
      rows = rows.map((row) => ({ ...row, isParked: true }));

      await expect(propose()).resolves.toMatchObject({ changes: [] });
      expect(http.post).not.toHaveBeenCalled();
    });

    it('404s an academic year it cannot see, rather than calling it tidy', async () => {
      tx.academicYear.findUnique.mockResolvedValue(null);

      await expect(propose()).rejects.toThrow(NotFoundException);
      await expect(propose()).rejects.toThrow('Academic year not found.');
      expect(http.post).not.toHaveBeenCalled();
    });
  });

  describe('basis', () => {
    beforeEach(() => {
      preferences = [
        wish('f2000000-0000-4000-8000-000000000001', {
          rooms: [{ roomId: ROOM_1 }, { roomId: ROOM_10 }],
        }),
        wish('f2000000-0000-4000-8000-000000000002'),
      ];
      closures = [
        closure('f1000000-0000-4000-8000-000000000001'),
        closure('f1000000-0000-4000-8000-000000000002', { roomId: ROOM_1 }),
      ];
    });

    it('is the same whatever order the rows come back in', async () => {
      rows[0]!.extraGroups = [{ studentGroupId: GROUP_7B }, { studentGroupId: GROUP_7C }];
      const first = await basisNow();
      // Every list, and every list inside a row: the database promises no order for either.
      rows.reverse();
      rooms.reverse();
      preferences.reverse();
      closures.reverse();
      for (const row of rows) row.extraGroups.reverse();
      for (const rule of preferences) rule.rooms.reverse();

      expect(await basisNow()).toBe(first);
    });

    it('changes when a lesson’s other class is swapped for another', async () => {
      rows[0]!.extraGroups = [{ studentGroupId: GROUP_7B }];
      const before = await basisNow();
      rows[0]!.extraGroups = [{ studentGroupId: GROUP_7C }];

      expect(await basisNow()).not.toBe(before);
    });

    it.each([
      ['a room’s floor', () => { rooms[0]!.floor = 3; }],
      ['a room’s building', () => { rooms[0]!.building = 'Hus B'; }],
      ['a lesson’s room', () => { rows[0]!.roomId = ROOM_ANNEX; }],
      ['a lesson’s lock', () => { rows[0]!.isLocked = true; }],
      ['a lesson’s parking', () => { rows[0]!.isParked = true; }],
      ['a lesson’s teacher', () => { rows[0]!.teacherId = OTHER_TEACHER; }],
      ['a lesson’s weeks', () => { rows[0]!.recurrence = 'EVEN_WEEKS'; }],
      ['a room wish’s weight', () => { preferences[0]!.weight = 9; }],
      ['the rooms a wish names', () => { preferences[0]!.rooms = [{ roomId: ROOM_1 }, { roomId: ROOM_ANNEX }]; }],
      ['a room closure’s hours', () => { closures[0]!.endTime = clockAt(14); }],
    ])('changes when %s changes', async (_label, change) => {
      const before = await basisNow();
      change();

      expect(await basisNow()).not.toBe(before);
    });
  });

  describe('apply', () => {
    const applyProposal = async () => {
      engine(swap);
      const proposal = await propose();
      const result = await service.apply(
        { academicYearId: YEAR, basis: proposal.basis, changes: proposal.changes },
        user,
      );
      return { proposal, result };
    };

    it('moves the listed lessons, and only those', async () => {
      const { result } = await applyProposal();

      expect(result.updated).toBe(2);
      expect(rows.map((row) => [row.id, row.roomId])).toEqual([
        [ELIN_FIRST, ROOM_1],
        [ELIN_SECOND, ROOM_1],
        [ALEX_FIRST, ROOM_10],
        [ALEX_SECOND, ROOM_10],
      ]);
      // Every write carries the room it moves from.
      for (const [{ where }] of tx.masterLesson.updateMany.mock.calls) {
        expect(where).toHaveProperty('roomId');
        expect(where).toHaveProperty('academicYearId', YEAR);
      }
    });

    it('changes nothing but the room', async () => {
      const before = rows.map(({ roomId: _room, ...rest }) => rest);

      await applyProposal();

      expect(rows.map(({ roomId: _room, ...rest }) => rest)).toEqual(before);
      for (const [{ data }] of tx.masterLesson.updateMany.mock.calls) {
        expect(Object.keys(data)).toEqual(['roomId']);
      }
    });

    it('refuses a stale basis with ROOM_PROPOSAL_STALE and writes nothing', async () => {
      engine(swap);
      const proposal = await propose();
      rooms[1]!.floor = 3; // somebody renumbered a floor meanwhile

      const error = await service
        .apply({ academicYearId: YEAR, basis: proposal.basis, changes: proposal.changes }, user)
        .catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(ConflictException);
      // The literal, not the constant: the page compares against this string
      // (web/components/schedule/room-optimization-dialog.tsx) to recompute
      // rather than show an error, and the sentence is what it shows otherwise.
      expect((error as ConflictException).getResponse()).toEqual({
        code: 'ROOM_PROPOSAL_STALE',
        message: 'Grundschemat har ändrats sedan förslaget beräknades. Beräkna ett nytt förslag.',
      });
      expect(tx.scheduleVersion.create).not.toHaveBeenCalled();
      expect(tx.masterLesson.updateMany).not.toHaveBeenCalled();
      expect(tx.calendarLesson.updateMany).not.toHaveBeenCalled();
    });

    it.each([
      ['a subject now needs a room type', () => {
        rows[1]!.subject = { requiredRoomTypeId: 'f0000000-0000-4000-8000-000000000001' };
      }],
      ['a class gains pupils', () => {
        people = [
          student('e0000000-0000-4000-8000-000000000001', GROUP_7A),
          student('e0000000-0000-4000-8000-000000000002', GROUP_7A),
        ];
      }],
      ['a class moves up a year', () => {
        groups = [{ id: GROUP_7A, gradeLevel: 8 }];
      }],
      ['a lesson names pupils of its own', () => {
        rows[1]!.participants = [
          { studentId: 'e0000000-0000-4000-8000-000000000001' },
          { studentId: 'e0000000-0000-4000-8000-000000000002' },
        ];
      }],
    ])('refuses as stale when %s in between — the rooms it fits were what the proposal chose from', async (_label, change) => {
      engine(swap);
      const proposal = await propose();
      change();

      await expect(
        service.apply(
          { academicYearId: YEAR, basis: proposal.basis, changes: proposal.changes },
          user,
        ),
      ).rejects.toMatchObject({ response: { code: ROOM_PROPOSAL_STALE } });
      expect(tx.masterLesson.updateMany).not.toHaveBeenCalled();
    });

    it('takes the year’s lock before it reads anything, and only for the transaction', async () => {
      /*
       * withRls is READ COMMITTED. Without the lock two applies from one basis
       * both read the same state and both commit; with it the second reads
       * after the first has committed and is refused as stale. So it has to
       * come before the read the basis is taken from, not after it.
       */
      const basis = await basisNow();
      tx.academicYear.findUnique.mockClear();
      tx.masterLesson.findMany.mockClear();

      await service.apply(
        {
          academicYearId: YEAR,
          basis,
          changes: [{ lessonId: ELIN_SECOND, fromRoomId: ROOM_10, toRoomId: ROOM_ANNEX }],
        },
        user,
      );

      const locks = executeRaw.mock.calls.filter((call) =>
        rawSql(call).includes('pg_advisory_xact_lock'),
      );
      expect(locks).toHaveLength(1);
      expect(locks[0]!.slice(1)).toEqual([YEAR]);
      const lockedAt = executeRaw.mock.invocationCallOrder[executeRaw.mock.calls.indexOf(locks[0]!)]!;
      expect(lockedAt).toBeLessThan(tx.academicYear.findUnique.mock.invocationCallOrder[0]!);
      expect(lockedAt).toBeLessThan(tx.masterLesson.findMany.mock.invocationCallOrder[0]!);
    });

    it('snapshots the year in the same transaction, before moving anything', async () => {
      const snapshot = jest.spyOn(versions, 'snapshotInTransaction');

      const { result } = await applyProposal();

      // propose opened one transaction, apply exactly one more.
      expect(prisma.withRls).toHaveBeenCalledTimes(2);
      expect(snapshot).toHaveBeenCalledWith(tx, YEAR, ROOM_SNAPSHOT_NAME, user);
      expect(snapshot).toHaveBeenCalledWith(tx, YEAR, 'Före salsoptimering', user);
      expect(tx.scheduleVersion.create.mock.invocationCallOrder[0]).toBeLessThan(
        tx.masterLesson.updateMany.mock.invocationCallOrder[0]!,
      );
      expect(result.versionId).toBe(VERSION);
    });

    it('keeps a parked lesson parked in the version it saves first', async () => {
      /*
       * "Före salsoptimering" can be restored from the version dialog like any
       * other version. The apply never sends a parked lesson and never moves
       * one, but it is part of the year: saved without its flag, restoring the
       * version would put it back at the slot it only remembers, over whatever
       * took that slot once it was set aside. The shared snapshot rule is what
       * carries the flag here; a snapshot of the optimisation's own would not.
       */
      rows.push(
        lesson(EXTRA, {
          teacherId: OTHER_TEACHER,
          studentGroupId: GROUP_7C,
          roomId: ROOM_ANNEX,
          startTime: clockAt(9),
          endTime: clockAt(10),
          isParked: true,
        }),
      );
      const basis = await basisNow();

      await service.apply(
        {
          academicYearId: YEAR,
          basis,
          changes: [{ lessonId: ELIN_SECOND, fromRoomId: ROOM_10, toRoomId: ROOM_ANNEX }],
        },
        user,
      );

      const { lessons } = tx.scheduleVersion.create.mock.calls[0]![0].data;
      expect(
        lessons.map((saved: { teacherId: string | null; isParked?: boolean }) => [
          saved.teacherId,
          saved.isParked,
        ]),
      ).toEqual([
        [ELIN, false],
        [ELIN, false],
        [ALEXANDER, false],
        [ALEXANDER, false],
        [OTHER_TEACHER, true],
      ]);
    });

    it('refuses a move whose lesson has left the room the proposal found it in', async () => {
      // The page's moves are for another timetable than this one.
      const basis = await basisNow();

      await expect(
        service.apply(
          {
            academicYearId: YEAR,
            basis,
            changes: [{ lessonId: ELIN_SECOND, fromRoomId: ROOM_ANNEX, toRoomId: ROOM_1 }],
          },
          user,
        ),
      ).rejects.toMatchObject({ response: { code: ROOM_PROPOSAL_STALE } });
      expect(tx.masterLesson.updateMany).not.toHaveBeenCalled();
    });

    it('lets the write itself refuse a lesson that moved after it was read', async () => {
      /*
       * The read says ELIN_SECOND is in room 10; by the time the write runs it
       * is in the annex. Only the from-room on the UPDATE can see that.
       */
      engine(swap);
      const proposal = await propose();
      const asRead = rows.map((row) => ({ ...row }));
      tx.masterLesson.findMany.mockImplementationOnce(async () => asRead);
      rows = rows.map((row) => (row.id === ELIN_SECOND ? { ...row, roomId: ROOM_ANNEX } : row));

      await expect(
        service.apply(
          { academicYearId: YEAR, basis: proposal.basis, changes: proposal.changes },
          user,
        ),
      ).rejects.toMatchObject({ response: { code: ROOM_PROPOSAL_STALE } });
      expect(rows.find((row) => row.id === ELIN_SECOND)!.roomId).toBe(ROOM_ANNEX);
    });

    it('refuses a move that would put two lessons in one room, before writing anything', async () => {
      const basis = await basisNow();

      const attempt = service.apply(
        {
          academicYearId: YEAR,
          basis,
          // Elin's 08:00 into room 10, where Alexander teaches at 08:00.
          changes: [{ lessonId: ELIN_FIRST, fromRoomId: ROOM_1, toRoomId: ROOM_10 }],
        },
        user,
      );

      // Out of the transaction's callback, so the real transaction rolls back.
      await expect(attempt).rejects.toBeInstanceOf(ConflictException);
      await expect(attempt).rejects.toMatchObject({
        response: {
          code: ROOM_CLASH,
          message: 'Salsbytet skulle krocka med en annan lektion i samma sal. Inget ändrades.',
        },
      });
      expect(tx.scheduleVersion.create).not.toHaveBeenCalled();
      expect(tx.masterLesson.updateMany).not.toHaveBeenCalled();
      expect(tx.calendarLesson.updateMany).not.toHaveBeenCalled();
      expect(rows).toEqual(elinAndAlexander());
    });

    it('refuses the same clash with the two lessons the other way round', async () => {
      // Alexander's 08:00 into room 1, where Elin's 08:00 is. Which of the two
      // the read happened to return first cannot decide whether it is a clash.
      const basis = await basisNow();

      await expect(
        service.apply(
          {
            academicYearId: YEAR,
            basis,
            changes: [{ lessonId: ALEX_FIRST, fromRoomId: ROOM_10, toRoomId: ROOM_1 }],
          },
          user,
        ),
      ).rejects.toMatchObject({ response: { code: ROOM_CLASH } });
      expect(tx.masterLesson.updateMany).not.toHaveBeenCalled();
    });

    it('sees a clash between lessons that start and end off the hour', async () => {
      // 08:50–09:10 in the annex, and 09:05–09:30 moved in beside it: five
      // minutes of overlap, there only when minutes are counted as minutes.
      rows.push(
        lesson(EXTRA, {
          teacherId: OTHER_TEACHER,
          studentGroupId: GROUP_7C,
          roomId: ROOM_ANNEX,
          startTime: clockAt(8, 50),
          endTime: clockAt(9, 10),
        }),
        lesson(EXTRA_TWO, {
          teacherId: ALEXANDER,
          studentGroupId: GROUP_7C,
          roomId: ROOM_10,
          startTime: clockAt(9, 5),
          endTime: clockAt(9, 30),
        }),
      );
      const basis = await basisNow();

      await expect(
        service.apply(
          {
            academicYearId: YEAR,
            basis,
            changes: [{ lessonId: EXTRA_TWO, fromRoomId: ROOM_10, toRoomId: ROOM_ANNEX }],
          },
          user,
        ),
      ).rejects.toMatchObject({ response: { code: ROOM_CLASH } });
    });

    it('lets lessons on opposite weeks share a room', async () => {
      rows[0]!.recurrence = 'EVEN_WEEKS';
      rows[2]!.recurrence = 'ODD_WEEKS';
      const basis = await basisNow();

      await service.apply(
        {
          academicYearId: YEAR,
          basis,
          changes: [{ lessonId: ELIN_FIRST, fromRoomId: ROOM_1, toRoomId: ROOM_10 }],
        },
        user,
      );

      expect(rows[0]!.roomId).toBe(ROOM_10);
    });

    it('lets a lesson take a room the minute the last one leaves it', async () => {
      // Half-open: 08:00-09:00 and 09:00-10:00 do not overlap.
      rows.push(
        lesson(EXTRA, {
          teacherId: OTHER_TEACHER,
          studentGroupId: GROUP_7C,
          roomId: ROOM_ANNEX,
        }),
      );
      const basis = await basisNow();

      await service.apply(
        {
          academicYearId: YEAR,
          basis,
          changes: [{ lessonId: ELIN_SECOND, fromRoomId: ROOM_10, toRoomId: ROOM_ANNEX }],
        },
        user,
      );

      expect(rows.find((row) => row.id === ELIN_SECOND)!.roomId).toBe(ROOM_ANNEX);
    });

    it('does not count a parked lesson as holding its old room', async () => {
      rows.push(
        lesson(EXTRA, {
          teacherId: OTHER_TEACHER,
          studentGroupId: GROUP_7C,
          roomId: ROOM_ANNEX,
          startTime: clockAt(9),
          endTime: clockAt(10),
          isParked: true,
        }),
      );
      const basis = await basisNow();

      await service.apply(
        {
          academicYearId: YEAR,
          basis,
          changes: [{ lessonId: ELIN_SECOND, fromRoomId: ROOM_10, toRoomId: ROOM_ANNEX }],
        },
        user,
      );

      expect(rows.find((row) => row.id === ELIN_SECOND)!.roomId).toBe(ROOM_ANNEX);
    });

    it.each([
      ['ends the minute it starts', clockAt(9, 30), clockAt(9, 30)],
      ['ends before it starts', clockAt(9, 50), clockAt(9, 10)],
    ])('does not count a lesson that %s as holding its room', async (_label, startTime, endTime) => {
      /*
       * Such a row is never sent, so the engine offers its room freely. Were
       * the guard to count it, every apply of that offer would be refused and
       * every recompute would make it again.
       */
      rows.push(
        lesson(EXTRA, {
          teacherId: OTHER_TEACHER,
          studentGroupId: GROUP_7C,
          roomId: ROOM_ANNEX,
          startTime,
          endTime,
        }),
      );
      const basis = await basisNow();

      await service.apply(
        {
          academicYearId: YEAR,
          basis,
          changes: [{ lessonId: ELIN_SECOND, fromRoomId: ROOM_10, toRoomId: ROOM_ANNEX }],
        },
        user,
      );

      expect(rows.find((row) => row.id === ELIN_SECOND)!.roomId).toBe(ROOM_ANNEX);
    });

    it('does not call a clash new when the two lessons already shared a room', async () => {
      // A shared hall at 13:00, moved as one. Not resolved, not made worse.
      rows.push(
        lesson(EXTRA, { roomId: ROOM_ANNEX, startTime: clockAt(13), endTime: clockAt(14) }),
        lesson(EXTRA_TWO, {
          teacherId: OTHER_TEACHER,
          studentGroupId: GROUP_7C,
          roomId: ROOM_ANNEX,
          startTime: clockAt(13),
          endTime: clockAt(14),
        }),
      );
      const basis = await basisNow();

      await service.apply(
        {
          academicYearId: YEAR,
          basis,
          changes: [
            { lessonId: EXTRA, fromRoomId: ROOM_ANNEX, toRoomId: ROOM_1 },
            { lessonId: EXTRA_TWO, fromRoomId: ROOM_ANNEX, toRoomId: ROOM_1 },
          ],
        },
        user,
      );

      expect(rows.filter((row) => row.roomId === ROOM_1)).toHaveLength(4);
    });

    it.each([
      ['a locked lesson', () => { rows[1]!.isLocked = true; }, { lessonId: ELIN_SECOND, fromRoomId: ROOM_10, toRoomId: ROOM_ANNEX }, `Lesson ${ELIN_SECOND} is locked and keeps its room.`],
      ['a parked lesson', () => { rows[1]!.isParked = true; }, { lessonId: ELIN_SECOND, fromRoomId: ROOM_10, toRoomId: ROOM_ANNEX }, `Lesson ${ELIN_SECOND} is parked and keeps its room.`],
      ['a lesson not in the year', () => undefined, { lessonId: EXTRA, fromRoomId: ROOM_10, toRoomId: ROOM_ANNEX }, `Lesson ${EXTRA} is not in this academic year.`],
      ['a room that does not exist', () => undefined, { lessonId: ELIN_SECOND, fromRoomId: ROOM_10, toRoomId: EXTRA }, `Room ${EXTRA} does not exist.`],
      ['the room it is already in', () => undefined, { lessonId: ELIN_SECOND, fromRoomId: ROOM_10, toRoomId: ROOM_10 }, `Lesson ${ELIN_SECOND} is moved to the room it is in.`],
    ])('refuses to move %s, and names the lesson and the reason', async (_label, arrange, change, message) => {
      arrange();
      const basis = await basisNow();

      const attempt = service.apply({ academicYearId: YEAR, basis, changes: [change] }, user);

      await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
      await expect(attempt).rejects.toThrow(message);
      expect(tx.masterLesson.updateMany).not.toHaveBeenCalled();
    });

    it('refuses to move one lesson twice in one apply', async () => {
      const basis = await basisNow();

      const attempt = service.apply(
        {
          academicYearId: YEAR,
          basis,
          changes: [
            { lessonId: ELIN_SECOND, fromRoomId: ROOM_10, toRoomId: ROOM_ANNEX },
            { lessonId: ELIN_SECOND, fromRoomId: ROOM_10, toRoomId: ROOM_1 },
          ],
        },
        user,
      );

      await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
      await expect(attempt).rejects.toThrow(`Lesson ${ELIN_SECOND} is moved more than once.`);
    });

    it('records every move in the audit trail and tells the other admins', async () => {
      await applyProposal();

      expect(tx.scheduleChangeLog.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            schoolId: SCHOOL,
            academicYearId: YEAR,
            masterLessonId: ELIN_SECOND,
            actorId: user.userId,
            action: 'UPDATE',
            before: { roomId: ROOM_10 },
            after: { roomId: ROOM_1 },
          }),
          expect.objectContaining({
            masterLessonId: ALEX_SECOND,
            before: { roomId: ROOM_1 },
            after: { roomId: ROOM_10 },
          }),
        ],
      });
      expect(realtime.notifyMasterTimetableChanged).toHaveBeenCalledWith(SCHOOL);
    });

    it('returns the basis a fresh proposal would compute from what it wrote', async () => {
      const { result } = await applyProposal();

      expect(await basisNow()).toBe(result.basis);
    });

    it('undoes itself: the reversed changes with the new basis put every room back', async () => {
      const original = elinAndAlexander();
      const { proposal, result } = await applyProposal();

      const undone = await service.apply(
        { academicYearId: YEAR, basis: result.basis, changes: reversed(proposal.changes) },
        user,
      );

      expect(rows).toEqual(original);
      expect(undone.updated).toBe(2);
      // Back where the proposal started, so the proposal's own basis holds again.
      expect(undone.basis).toBe(proposal.basis);
    });

    describe('the published calendar', () => {
      const CAL = (n: number) => `90000000-0000-4000-8000-00000000000${n}`;

      it('moves the published lessons of every moved template with it', async () => {
        calendar = [
          published(CAL(1), ELIN_SECOND, ROOM_10),
          published(CAL(2), ELIN_SECOND, ROOM_10, { date: new Date('2099-03-09T00:00:00.000Z') }),
          published(CAL(3), ALEX_SECOND, ROOM_1),
          // Not moved: its template keeps room 1.
          published(CAL(4), ELIN_FIRST, ROOM_1),
        ];

        const { result } = await applyProposal();

        expect(calendar.map((row) => [row.id, row.roomId])).toEqual([
          [CAL(1), ROOM_1],
          [CAL(2), ROOM_1],
          [CAL(3), ROOM_10],
          [CAL(4), ROOM_1],
        ]);
        expect(result.calendarUpdated).toBe(3);
      });

      it('leaves a date somebody already moved by hand where they put it', async () => {
        calendar = [
          published(CAL(1), ELIN_SECOND, ROOM_10),
          published(CAL(2), ELIN_SECOND, ROOM_ANNEX),
        ];

        const { result } = await applyProposal();

        expect(calendar.map((row) => row.roomId)).toEqual([ROOM_1, ROOM_ANNEX]);
        expect(result.calendarUpdated).toBe(1);
      });

      it.each([
        ['in the past', { date: PAST }],
        ['with attendance taken', { attended: true }],
        ['no longer merely scheduled', { status: 'CANCELLED' as const }],
      ])('leaves a lesson %s as it happened', async (_label, overrides) => {
        calendar = [published(CAL(1), ELIN_SECOND, ROOM_10, overrides)];

        const { result } = await applyProposal();

        expect(calendar[0]!.roomId).toBe(ROOM_10);
        expect(result.calendarUpdated).toBe(0);
      });

      it('touches only the rows a hand edit of the template could still rewrite', async () => {
        calendar = [published(CAL(1), ELIN_SECOND, ROOM_10)];

        await applyProposal();

        for (const [{ where }] of tx.calendarLesson.updateMany.mock.calls) {
          expect(where).toMatchObject({
            status: 'SCHEDULED',
            attendanceRecords: { none: {} },
            startsAt: { gt: expect.any(Date) },
          });
          expect(where).toHaveProperty('roomId');
        }
      });

      it('moves them back on undo, and a date moved by hand in between stays', async () => {
        calendar = [
          published(CAL(1), ELIN_SECOND, ROOM_10),
          published(CAL(2), ELIN_SECOND, ROOM_10, { date: new Date('2099-03-09T00:00:00.000Z') }),
          published(CAL(3), ALEX_SECOND, ROOM_1),
        ];
        const { proposal, result } = await applyProposal();
        // After the apply, somebody puts one of Elin's dates in the annex.
        calendar[1] = { ...calendar[1]!, roomId: ROOM_ANNEX };

        const undone = await service.apply(
          { academicYearId: YEAR, basis: result.basis, changes: reversed(proposal.changes) },
          user,
        );

        expect(calendar.map((row) => row.roomId)).toEqual([ROOM_10, ROOM_ANNEX, ROOM_1]);
        expect(undone.calendarUpdated).toBe(2);
      });
    });

    it('is not made stale by pupils joining a class whose only lesson is parked', async () => {
      /*
       * A parked lesson is never sent, so what it would ask of a room is no
       * part of what the proposal read. 7C gaining pupils changes nothing the
       * engine saw, and must not refuse the apply as though it had.
       */
      rows.push(
        lesson(EXTRA, {
          teacherId: OTHER_TEACHER,
          studentGroupId: GROUP_7C,
          roomId: ROOM_ANNEX,
          isParked: true,
        }),
      );
      const basis = await basisNow();
      people = [
        student('e0000000-0000-4000-8000-000000000001', GROUP_7C),
        student('e0000000-0000-4000-8000-000000000002', GROUP_7C),
      ];

      await service.apply(
        {
          academicYearId: YEAR,
          basis,
          changes: [{ lessonId: ELIN_SECOND, fromRoomId: ROOM_10, toRoomId: ROOM_ANNEX }],
        },
        user,
      );

      expect(rows.find((row) => row.id === ELIN_SECOND)!.roomId).toBe(ROOM_ANNEX);
    });

    it('refuses the undo once anything else has changed', async () => {
      const { proposal, result } = await applyProposal();
      rows[0]!.teacherId = OTHER_TEACHER;

      await expect(
        service.apply(
          { academicYearId: YEAR, basis: result.basis, changes: reversed(proposal.changes) },
          user,
        ),
      ).rejects.toMatchObject({ response: { code: ROOM_PROPOSAL_STALE } });
    });
  });
});

// Keeps the PrismaClient import honest for the tx type the snapshot receives.
export type _Tx = PrismaClient;
