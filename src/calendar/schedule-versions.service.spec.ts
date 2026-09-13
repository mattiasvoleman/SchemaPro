import {
  BadRequestException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { LessonRecurrence } from '@prisma/client';
import {
  createPrismaMock,
  createTxMock,
  testUser,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import {
  ScheduleVersionsService,
  type VersionLesson,
} from './schedule-versions.service';

const YEAR_ID = '44444444-4444-4444-8444-444444444444';
const VERSION_ID = '55555555-5555-4555-8555-555555555555';
const SAFETY_ID = '66666666-6666-4666-8666-666666666666';
const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const SUBJECT_ID = '77777777-7777-4777-8777-777777777777';
const GROUP_ID = '88888888-8888-4888-8888-888888888888';
const TEACHER_ID = '99999999-9999-4999-8999-999999999999';
const CO_TEACHER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ROOM_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EXTRA_GROUP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const STUDENT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const CREATED_AT = new Date('2026-08-06T12:00:00.000Z');

/** parseHHMM builds times on the epoch day, UTC. */
const utcTime = (h: number, m: number) => new Date(Date.UTC(1970, 0, 1, h, m));
/** `@db.Date` columns come back from Prisma at midnight UTC. */
const utcDate = (day: string) => new Date(`${day}T00:00:00.000Z`);

/*
 * The database as Prisma answers it.
 *
 * A stub that resolves a whole row hands the service every column whether its
 * query asked for it or not, so a `select` that forgot a column the service
 * goes on to read passes here and fails in production as `undefined`. These
 * answer the way Prisma 5 does: only the selected columns come back, a select
 * with nothing truthy in it is refused before anything is read, a relation
 * named as `{}` comes back whole, and a findUnique without its key is refused.
 */
type Row = Record<string, any>;
type Query = { where?: Row; select?: Row; data?: Row };

function refuseEmptySelect(select: Row | undefined): void {
  if (select === undefined) return;
  const chosen = Object.values(select).filter(Boolean);
  if (chosen.length === 0) {
    throw new Error('Prisma refuses a `select` with no truthy value.');
  }
  for (const spec of chosen) {
    if (typeof spec === 'object') refuseEmptySelect((spec as Query).select);
  }
}

function project(row: Row, select: Row | undefined): Row {
  if (select === undefined) return row;
  return Object.fromEntries(
    Object.entries(select)
      .filter(([, spec]) => Boolean(spec))
      .map(([column, spec]) => {
        const value = row[column];
        const nested = typeof spec === 'object' ? (spec as Query).select : undefined;
        if (nested === undefined || value === null || value === undefined) {
          return [column, value];
        }
        return [
          column,
          Array.isArray(value)
            ? value.map((item: Row) => project(item, nested))
            : project(value, nested),
        ];
      }),
  );
}

/** findMany over a table: every row, as the query selects it. */
const answerRows =
  (rows: Row[]) =>
  (query: Query = {}) => {
    refuseEmptySelect(query.select);
    return Promise.resolve(rows.map((row) => project(row, query.select)));
  };

/** findUnique by id over a table. */
const answerById =
  (rows: Row[]) =>
  (query: Query = {}) => {
    refuseEmptySelect(query.select);
    if (query.where?.id === undefined) {
      throw new Error('Prisma refuses a findUnique without its unique key.');
    }
    const row = rows.find((candidate) => candidate.id === query.where?.id);
    return Promise.resolve(row ? project(row, query.select) : null);
  };

/** create: the written row, with the database's own columns, as selected. */
const answerCreate =
  (generated: Row) =>
  (query: Query = {}) => {
    refuseEmptySelect(query.select);
    return Promise.resolve(project({ ...generated, ...query.data }, query.select));
  };

/** One master lesson as `snapshot()` reads it back from Prisma. */
type MasterLessonRow = {
  subjectId: string;
  studentGroupId: string;
  teacherId: string | null;
  coTeacherId: string | null;
  roomId: string | null;
  dayOfWeek: number;
  startTime: Date;
  endTime: Date;
  isLocked: boolean;
  isGenerated: boolean;
  isParked: boolean;
  recurrence: LessonRecurrence;
  startDate: Date | null;
  endDate: Date | null;
  extraGroups: { studentGroupId: string }[];
  participants: { studentId: string }[];
};

const masterLessonRow = (
  overrides: Partial<MasterLessonRow> = {},
): MasterLessonRow => ({
  subjectId: SUBJECT_ID,
  studentGroupId: GROUP_ID,
  teacherId: TEACHER_ID,
  coTeacherId: null,
  roomId: ROOM_ID,
  dayOfWeek: 2,
  startTime: utcTime(8, 5),
  endTime: utcTime(9, 30),
  isLocked: true,
  isGenerated: false,
  isParked: false,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  extraGroups: [{ studentGroupId: EXTRA_GROUP_ID }],
  participants: [{ studentId: STUDENT_ID }],
  ...overrides,
});

describe('ScheduleVersionsService', () => {
  let service: ScheduleVersionsService;
  let tx: TxMock;
  let prisma: PrismaMock;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new ScheduleVersionsService(prisma as unknown as PrismaService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** The master lessons the year holds right now, as a snapshot reads them. */
  const timetable = (rows: MasterLessonRow[]) =>
    tx.masterLesson.findMany.mockImplementation(answerRows(rows));

  describe('list', () => {
    it('lists the year’s versions under the caller’s RLS context', async () => {
      const user = testUser();
      tx.scheduleVersion.findMany.mockImplementation(
        answerRows([
          {
            id: VERSION_ID,
            schoolId: SCHOOL_ID,
            academicYearId: YEAR_ID,
            name: 'Draft v1',
            lessonCount: 3,
            createdAt: CREATED_AT,
            lessons: [],
          },
        ]),
      );

      await expect(service.list(YEAR_ID, user)).resolves.toEqual([
        {
          id: VERSION_ID,
          academicYearId: YEAR_ID,
          name: 'Draft v1',
          lessonCount: 3,
          createdAt: '2026-08-06T12:00:00.000Z',
        },
      ]);

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.scheduleVersion.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { academicYearId: YEAR_ID },
          orderBy: { createdAt: 'desc' },
        }),
      );
    });

    it('returns an empty list for a year with no snapshots', async () => {
      tx.scheduleVersion.findMany.mockResolvedValue([]);

      await expect(service.list(YEAR_ID, testUser())).resolves.toEqual([]);
    });
  });

  describe('create', () => {
    const arrangeYear = () => {
      tx.academicYear.findUnique.mockImplementation(
        answerById([{ id: YEAR_ID, schoolId: SCHOOL_ID }]),
      );
      tx.scheduleVersion.create.mockImplementation(
        answerCreate({ id: VERSION_ID, createdAt: CREATED_AT }),
      );
    };

    it('404s when the academic year does not exist', async () => {
      tx.academicYear.findUnique.mockResolvedValue(null);

      await expect(
        service.create(YEAR_ID, 'Draft v1', testUser()),
      ).rejects.toThrow(new NotFoundException('Academic year not found.'));
      expect(tx.scheduleVersion.create).not.toHaveBeenCalled();
    });

    it('snapshots every master lesson with HH:MM times and flattened relations', async () => {
      arrangeYear();
      timetable([masterLessonRow()]);

      await service.create(YEAR_ID, 'Draft v1', testUser({ userId: USER_ID }));

      expect(tx.masterLesson.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { academicYearId: YEAR_ID } }),
      );
      expect(tx.scheduleVersion.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            // Tenant comes from the year row the caller can see under RLS.
            schoolId: SCHOOL_ID,
            academicYearId: YEAR_ID,
            name: 'Draft v1',
            createdById: USER_ID,
            lessonCount: 1,
            lessons: [
              {
                subjectId: SUBJECT_ID,
                studentGroupId: GROUP_ID,
                teacherId: TEACHER_ID,
                coTeacherId: null,
                roomId: ROOM_ID,
                dayOfWeek: 2,
                startTime: '08:05',
                endTime: '09:30',
                isLocked: true,
                isGenerated: false,
                isParked: false,
                recurrence: 'ALL_WEEKS',
                startDate: null,
                endDate: null,
                extraGroupIds: [EXTRA_GROUP_ID],
                studentIds: [STUDENT_ID],
              },
            ],
          }),
        }),
      );
    });

    it('snapshots the recurrence and the date window of a term-long lesson', async () => {
      arrangeYear();
      timetable([
        masterLessonRow({
          recurrence: 'ODD_WEEKS',
          startDate: utcDate('2026-08-31'),
          endDate: utcDate('2026-12-18'),
        }),
      ]);

      await service.create(YEAR_ID, 'Draft v1', testUser());

      expect(tx.masterLesson.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({
            recurrence: true,
            startDate: true,
            endDate: true,
          }),
        }),
      );
      const { lessons } = tx.scheduleVersion.create.mock.calls[0][0].data;
      expect(lessons[0]).toMatchObject({
        recurrence: 'ODD_WEEKS',
        // Stored the way a `@db.Date` reads, not as a full timestamp — the
        // restore parses these back.
        startDate: '2026-08-31',
        endDate: '2026-12-18',
      });
    });

    it('snapshots who owns each lesson, not just what it looks like', async () => {
      arrangeYear();
      // Two lessons that are identical in every field the old inference could
      // see — both plain, both unlocked — and differ only in the column. A
      // snapshot that dropped it could not tell them apart on the way back,
      // and a restore would have to guess for both.
      timetable([
        masterLessonRow({ isLocked: false, isGenerated: true }),
        masterLessonRow({ isLocked: false, isGenerated: false }),
      ]);

      await service.create(YEAR_ID, 'Draft v1', testUser());

      expect(tx.masterLesson.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({ isGenerated: true }),
        }),
      );
      const { lessons } = tx.scheduleVersion.create.mock.calls[0][0].data;
      expect(lessons.map((lesson: VersionLesson) => lesson.isGenerated)).toEqual([
        true,
        false,
      ]);
    });

    it('snapshots the tray along with the grid', async () => {
      arrangeYear();
      // One lesson lifted out of its slot and one moved into it — the swap the
      // tray exists for. Both rows name the same day and time; only the flag
      // says that one of them is a placement and the other a memory.
      timetable([
        masterLessonRow({ isParked: true }),
        masterLessonRow({ isParked: false }),
      ]);

      await service.create(YEAR_ID, 'Draft v1', testUser());

      expect(tx.masterLesson.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          // The tray is part of the timetable: a snapshot that skipped parked
          // lessons would restore without them, which is a deletion.
          where: { academicYearId: YEAR_ID },
          select: expect.objectContaining({ isParked: true }),
        }),
      );
      const { lessons } = tx.scheduleVersion.create.mock.calls[0][0].data;
      expect(lessons.map((lesson: VersionLesson) => lesson.isParked)).toEqual([
        true,
        false,
      ]);
    });

    it('returns the stored summary with an ISO timestamp', async () => {
      arrangeYear();
      timetable([masterLessonRow()]);
      const user = testUser();

      await expect(service.create(YEAR_ID, 'Draft v1', user)).resolves.toEqual({
        id: VERSION_ID,
        academicYearId: YEAR_ID,
        name: 'Draft v1',
        lessonCount: 1,
        createdAt: '2026-08-06T12:00:00.000Z',
      });
      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
    });

    it('stores a null author for a principal with no userId', async () => {
      arrangeYear();
      timetable([]);

      await service.create(YEAR_ID, 'Draft v1', testUser({ userId: undefined }));

      expect(tx.scheduleVersion.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ createdById: null, lessonCount: 0 }),
        }),
      );
    });
  });

  describe('get', () => {
    it('returns the version with its lesson snapshot', async () => {
      const lessons = [{ subjectId: SUBJECT_ID }];
      tx.scheduleVersion.findUnique.mockImplementation(
        answerById([
          {
            id: VERSION_ID,
            schoolId: SCHOOL_ID,
            academicYearId: YEAR_ID,
            name: 'Draft v1',
            lessonCount: 1,
            createdAt: CREATED_AT,
            lessons,
          },
        ]),
      );

      await expect(service.get(VERSION_ID, testUser())).resolves.toEqual({
        id: VERSION_ID,
        academicYearId: YEAR_ID,
        name: 'Draft v1',
        lessonCount: 1,
        createdAt: '2026-08-06T12:00:00.000Z',
        lessons,
      });

      expect(tx.scheduleVersion.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: VERSION_ID } }),
      );
    });

    it('404s on an unknown version', async () => {
      tx.scheduleVersion.findUnique.mockResolvedValue(null);

      await expect(service.get(VERSION_ID, testUser())).rejects.toThrow(
        new NotFoundException('Schedule version not found.'),
      );
    });
  });

  describe('restore', () => {
    const fullLesson = (): VersionLesson => ({
      subjectId: SUBJECT_ID,
      studentGroupId: GROUP_ID,
      teacherId: TEACHER_ID,
      coTeacherId: CO_TEACHER_ID,
      roomId: ROOM_ID,
      dayOfWeek: 1,
      startTime: '08:15',
      endTime: '09:00',
      isLocked: true,
      // The optimizer's own work, locked afterwards by an admin who liked
      // where it landed. Ownership and lock are independent flags.
      isGenerated: true,
      isParked: false,
      recurrence: 'ODD_WEEKS',
      startDate: '2026-08-31',
      endDate: '2026-12-18',
      extraGroupIds: [EXTRA_GROUP_ID],
      studentIds: [STUDENT_ID],
    });

    /**
     * Optional fields absent — the restore must default them. This is also
     * the shape of every snapshot stored before recurrence was carried.
     */
    const minimalLesson = (): VersionLesson => ({
      subjectId: SUBJECT_ID,
      studentGroupId: GROUP_ID,
      teacherId: null,
      roomId: null,
      dayOfWeek: 5,
      startTime: '13:00',
      endTime: '14:40',
      isLocked: false,
    });

    const arrangeRestore = (
      lessons: unknown = [fullLesson(), minimalLesson()],
    ) => {
      tx.scheduleVersion.findUnique.mockImplementation(
        answerById([
          {
            id: VERSION_ID,
            schoolId: SCHOOL_ID,
            academicYearId: YEAR_ID,
            name: 'Golden master',
            lessonCount: Array.isArray(lessons) ? lessons.length : 0,
            createdAt: CREATED_AT,
            lessons,
          },
        ]),
      );
      // The safety snapshot taken before the wipe reads the year and the
      // current timetable, then writes its own version row.
      tx.academicYear.findUnique.mockImplementation(
        answerById([{ id: YEAR_ID, schoolId: SCHOOL_ID }]),
      );
      timetable([]);
      tx.scheduleVersion.create.mockImplementation(
        answerCreate({ id: SAFETY_ID, createdAt: CREATED_AT }),
      );
      tx.masterLesson.deleteMany.mockResolvedValue({ count: 0 });
      tx.masterLesson.create.mockResolvedValue({});
      tx.scheduleChangeLog.create.mockResolvedValue({});
    };

    it('404s on an unknown version without touching the timetable', async () => {
      tx.scheduleVersion.findUnique.mockResolvedValue(null);

      await expect(service.restore(VERSION_ID, testUser())).rejects.toThrow(
        new NotFoundException('Schedule version not found.'),
      );
      expect(tx.masterLesson.deleteMany).not.toHaveBeenCalled();
    });

    it('takes an automatic safety snapshot before wiping the timetable', async () => {
      arrangeRestore();

      const result = await service.restore(VERSION_ID, testUser());

      expect(tx.scheduleVersion.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: 'Before restore of "Golden master"',
            academicYearId: YEAR_ID,
            schoolId: SCHOOL_ID,
          }),
        }),
      );
      expect(result.safetyVersionId).toBe(SAFETY_ID);
      // The snapshot must exist before the wipe, or a failed restore has
      // nothing to revert to.
      const snapshotOrder =
        tx.scheduleVersion.create.mock.invocationCallOrder[0];
      const wipeOrder = tx.masterLesson.deleteMany.mock.invocationCallOrder[0];
      expect(snapshotOrder).toBeLessThan(wipeOrder);
    });

    it('rejects a malformed snapshot before deleting anything', async () => {
      arrangeRestore({ corrupted: true });

      await expect(service.restore(VERSION_ID, testUser())).rejects.toThrow(
        new BadRequestException('Version snapshot is malformed.'),
      );
      expect(tx.masterLesson.deleteMany).not.toHaveBeenCalled();
      expect(tx.masterLesson.create).not.toHaveBeenCalled();
    });

    it.each([
      ['a non-clock string', '8:15am'],
      ['an hour past the day', '24:00'],
      ['a missing key', undefined],
      // Both ends of the pattern are anchored: each of these holds a valid
      // clock inside it, and toHHMM never writes either.
      ['an extra leading digit', '108:15'],
      ['seconds the snapshot never writes', '08:15:00'],
    ])(
      'rejects a snapshot with %s as a time before deleting anything',
      async (_label, startTime) => {
        // The old split(':') parser met these only after the wipe, and none
        // of them with a 400 that named the value: a missing key threw a
        // TypeError (a 500), '8:15am' became an Invalid Date that Prisma's
        // validation rejected mid-insert (the filter's anonymous 400), and
        // '24:00' rolled over into a silent 00:00 that restored the lesson at
        // midnight.
        arrangeRestore([
          minimalLesson(),
          { ...fullLesson(), startTime: startTime as string },
        ]);

        await expect(service.restore(VERSION_ID, testUser())).rejects.toThrow(
          new BadRequestException(
            `Version snapshot contains an invalid time: "${startTime}".`,
          ),
        );
        expect(tx.masterLesson.deleteMany).not.toHaveBeenCalled();
        expect(tx.masterLesson.create).not.toHaveBeenCalled();
      },
    );

    it('replaces the year’s lessons with the snapshot, remapping every field', async () => {
      arrangeRestore();

      await service.restore(VERSION_ID, testUser());

      expect(tx.masterLesson.deleteMany).toHaveBeenCalledWith({
        where: { academicYearId: YEAR_ID },
      });
      expect(tx.masterLesson.create).toHaveBeenCalledTimes(2);
      expect(tx.masterLesson.create).toHaveBeenNthCalledWith(1, {
        data: {
          schoolId: SCHOOL_ID,
          academicYearId: YEAR_ID,
          subjectId: SUBJECT_ID,
          studentGroupId: GROUP_ID,
          teacherId: TEACHER_ID,
          coTeacherId: CO_TEACHER_ID,
          roomId: ROOM_ID,
          dayOfWeek: 1,
          startTime: utcTime(8, 15),
          endTime: utcTime(9, 0),
          isLocked: true,
          isGenerated: true,
          isParked: false,
          recurrence: 'ODD_WEEKS',
          startDate: utcDate('2026-08-31'),
          endDate: utcDate('2026-12-18'),
          extraGroups: {
            create: [{ schoolId: SCHOOL_ID, studentGroupId: EXTRA_GROUP_ID }],
          },
          participants: {
            create: [{ schoolId: SCHOOL_ID, studentId: STUDENT_ID }],
          },
        },
      });
      // Absent optionals default: null co-teacher, no extra groups/students.
      expect(tx.masterLesson.create).toHaveBeenNthCalledWith(2, {
        data: expect.objectContaining({
          teacherId: null,
          coTeacherId: null,
          roomId: null,
          startTime: utcTime(13, 0),
          endTime: utcTime(14, 40),
          isLocked: false,
          extraGroups: { create: [] },
          participants: { create: [] },
        }),
      });
    });

    it('reads a snapshot stored before recurrence existed as every week', async () => {
      arrangeRestore([minimalLesson()]);

      await service.restore(VERSION_ID, testUser());

      // No key at all in the blob. Writing the column explicitly rather than
      // leaning on its default keeps the reading visible at the boundary.
      expect(tx.masterLesson.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          recurrence: 'ALL_WEEKS',
          startDate: null,
          endDate: null,
        }),
      });
    });

    it('reads a window whose dates were spelled as full timestamps', async () => {
      // The blob is the only copy of a snapshot, so a restore must not turn on
      // how a date was spelled when it was stored: the calendar day is what a
      // DATE column holds, and it is the first ten characters either way.
      arrangeRestore([
        {
          ...minimalLesson(),
          startDate: '2026-08-31T00:00:00.000Z',
          endDate: '2026-12-18T00:00:00.000Z',
        },
      ]);

      await service.restore(VERSION_ID, testUser());

      expect(tx.masterLesson.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          startDate: utcDate('2026-08-31'),
          endDate: utcDate('2026-12-18'),
        }),
      });
    });

    it('gives each restored lesson back the owner it was snapshotted with', async () => {
      // One of the machine's, one of a human's, restored in the same call. A
      // restore that stamped a constant would pass whichever half it guessed
      // and hand the other half to the wrong owner — after which the next
      // regeneration either deletes work nobody can get back, or preserves its
      // own output and leaves the requirement unmet for good.
      arrangeRestore([
        fullLesson(),
        { ...fullLesson(), isGenerated: false, isLocked: false },
      ]);

      await service.restore(VERSION_ID, testUser());

      expect(tx.masterLesson.create).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          data: expect.objectContaining({ isGenerated: true }),
        }),
      );
      expect(tx.masterLesson.create).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          data: expect.objectContaining({ isGenerated: false }),
        }),
      );
    });

    it('reads a snapshot stored before ownership was carried as handmade', async () => {
      arrangeRestore([minimalLesson()]);

      await service.restore(VERSION_ID, testUser());

      // No key in the blob, and no way to add one: the snapshot is the only
      // copy. False is the recoverable direction — the lesson survives the
      // next regeneration and sits on the timetable where an administrator can
      // delete it. True would let regeneration delete it instead, and
      // restoring the same version again would only stage the same deletion.
      expect(tx.masterLesson.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ isGenerated: false }),
      });
    });

    it('puts a parked lesson back on the tray, not into the slot it remembers', async () => {
      // A was lifted out of Monday 08:15 so that B could move in, and both are
      // in the snapshot at that slot. Restore A as placed and it lands on top
      // of B — teacher, room and class all booked twice — and nothing here
      // checks for a clash. B restored as parked would lose its place instead.
      arrangeRestore([
        { ...fullLesson(), isParked: true },
        { ...fullLesson(), isParked: false },
      ]);

      await service.restore(VERSION_ID, testUser());

      expect(tx.masterLesson.create).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          data: expect.objectContaining({ isParked: true }),
        }),
      );
      expect(tx.masterLesson.create).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          data: expect.objectContaining({ isParked: false }),
        }),
      );
    });

    it('reads a snapshot stored before parking was carried as placed', async () => {
      arrangeRestore([minimalLesson()]);

      await service.restore(VERSION_ID, testUser());

      // No key in the blob. For a snapshot older than the tray that is exact:
      // nothing could be parked yet. For one taken since, whichever lessons
      // were on the tray are lost, and placed is the side a mistake shows on —
      // a clash on the grid, not a whole year restored onto the tray. Written
      // explicitly rather than left to the column default.
      expect(tx.masterLesson.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ isParked: false }),
      });
    });

    it('survives a round trip: what snapshot() writes, restore() reads back', async () => {
      const row = masterLessonRow({
        recurrence: 'EVEN_WEEKS',
        startDate: utcDate('2027-01-11'),
        endDate: utcDate('2027-06-11'),
        isGenerated: true,
        isParked: true,
      });
      // Snapshot the row, then feed that exact blob back into a restore. The
      // two halves have to agree on the wire format or the window is lost.
      arrangeRestore();
      timetable([row]);
      await service.create(YEAR_ID, 'Draft v1', testUser());
      const { lessons } = tx.scheduleVersion.create.mock.calls[0][0].data;

      arrangeRestore(lessons);
      await service.restore(VERSION_ID, testUser());

      expect(tx.masterLesson.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          recurrence: row.recurrence,
          startDate: row.startDate,
          endDate: row.endDate,
          // A generated lesson that came home as a handmade one would be the
          // regeneration's problem, one restore later.
          isGenerated: row.isGenerated,
          // And a parked one that came home placed would sit in a slot it
          // gave up, over whatever took it.
          isParked: row.isParked,
        }),
      });
    });

    it('carries recurrence into the automatic safety snapshot', async () => {
      arrangeRestore([minimalLesson()]);
      // The live timetable being replaced runs on odd weeks. If the safety
      // snapshot flattens that, undoing this restore silently doubles the
      // lesson — so the "a restore can always be reverted" promise fails.
      timetable([
        masterLessonRow({
          recurrence: 'ODD_WEEKS',
          startDate: utcDate('2026-08-31'),
          endDate: null,
        }),
      ]);

      await service.restore(VERSION_ID, testUser());

      const { lessons } = tx.scheduleVersion.create.mock.calls[0][0].data;
      expect(lessons[0]).toMatchObject({
        recurrence: 'ODD_WEEKS',
        startDate: '2026-08-31',
        endDate: null,
      });
    });

    it('carries ownership into the automatic safety snapshot', async () => {
      arrangeRestore([minimalLesson()]);
      // Same promise as above, for the other column: the safety snapshot is
      // what a regretted restore is undone from, and a handmade lesson that
      // came back from it as the machine's would be deleted by the first
      // regeneration after the undo — with the original already overwritten.
      timetable([
        masterLessonRow({ isGenerated: false }),
        masterLessonRow({ isGenerated: true }),
      ]);

      await service.restore(VERSION_ID, testUser());

      const { lessons } = tx.scheduleVersion.create.mock.calls[0][0].data;
      expect(lessons.map((lesson: VersionLesson) => lesson.isGenerated)).toEqual([
        false,
        true,
      ]);
    });

    it('carries the tray into the automatic safety snapshot', async () => {
      arrangeRestore([minimalLesson()]);
      // Undoing a restore is restoring this snapshot. If it forgot the tray,
      // the undo would put every lesson that was set aside when the restore ran
      // back into a slot that may since have been given to another lesson.
      timetable([
        masterLessonRow({ isParked: true }),
        masterLessonRow({ isParked: false }),
      ]);

      await service.restore(VERSION_ID, testUser());

      const { lessons } = tx.scheduleVersion.create.mock.calls[0][0].data;
      expect(lessons.map((lesson: VersionLesson) => lesson.isParked)).toEqual([
        true,
        false,
      ]);
    });

    it('records the restore in the change log with the actor and safety id', async () => {
      arrangeRestore();

      await service.restore(VERSION_ID, testUser({ userId: USER_ID }));

      expect(tx.scheduleChangeLog.create).toHaveBeenCalledWith({
        data: {
          schoolId: SCHOOL_ID,
          academicYearId: YEAR_ID,
          actorId: USER_ID,
          action: 'RESTORE',
          after: {
            versionId: VERSION_ID,
            versionName: 'Golden master',
            restoredLessons: 2,
            safetyVersionId: SAFETY_ID,
          },
        },
      });
    });

    it('logs a null actor when the principal has no userId', async () => {
      arrangeRestore();

      await service.restore(VERSION_ID, testUser({ userId: undefined }));

      expect(tx.scheduleChangeLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ actorId: null }),
        }),
      );
    });

    it('returns the restored count and runs under the caller’s RLS context', async () => {
      arrangeRestore();
      const user = testUser();

      await expect(service.restore(VERSION_ID, user)).resolves.toEqual({
        restoredLessons: 2,
        safetyVersionId: SAFETY_ID,
      });
      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(prisma.withSystemTransaction).not.toHaveBeenCalled();
    });

    it('restores an empty snapshot to an empty timetable', async () => {
      arrangeRestore([]);

      await expect(service.restore(VERSION_ID, testUser())).resolves.toEqual({
        restoredLessons: 0,
        safetyVersionId: SAFETY_ID,
      });
      expect(tx.masterLesson.deleteMany).toHaveBeenCalled();
      expect(tx.masterLesson.create).not.toHaveBeenCalled();
    });

    it('404s when the academic year behind the version has vanished', async () => {
      arrangeRestore();
      tx.academicYear.findUnique.mockResolvedValue(null);

      await expect(service.restore(VERSION_ID, testUser())).rejects.toThrow(
        new NotFoundException('Academic year not found.'),
      );
      expect(tx.masterLesson.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('snapshotInTransaction', () => {
    it('snapshots inside the caller’s transaction without opening one of its own', async () => {
      /*
       * The room optimisation's apply takes its safety copy this way, so that a
       * refused apply rolls the copy back with it. A snapshot that opened its
       * own transaction would survive the rollback and list, as "Före
       * salsoptimering", a timetable nothing was ever done to.
       */
      tx.academicYear.findUnique.mockResolvedValue({ id: YEAR_ID, schoolId: SCHOOL_ID });
      timetable([masterLessonRow()]);
      tx.scheduleVersion.create.mockResolvedValue({
        id: VERSION_ID,
        academicYearId: YEAR_ID,
        name: 'Före salsoptimering',
        lessonCount: 1,
        createdAt: CREATED_AT,
      });

      const summary = await service.snapshotInTransaction(
        tx as never,
        YEAR_ID,
        'Före salsoptimering',
        testUser(),
      );

      expect(prisma.withRls).not.toHaveBeenCalled();
      expect(tx.scheduleVersion.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ name: 'Före salsoptimering', lessonCount: 1 }),
        }),
      );
      expect(summary.id).toBe(VERSION_ID);
    });
  });

  describe('remove', () => {
    it('deletes an existing version', async () => {
      tx.scheduleVersion.findUnique.mockImplementation(
        answerById([{ id: VERSION_ID, schoolId: SCHOOL_ID, name: 'Draft v1' }]),
      );
      tx.scheduleVersion.delete.mockResolvedValue({ id: VERSION_ID });
      const user = testUser();

      await expect(service.remove(VERSION_ID, user)).resolves.toEqual({
        id: VERSION_ID,
      });
      expect(tx.scheduleVersion.delete).toHaveBeenCalledWith({
        where: { id: VERSION_ID },
      });
      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
    });

    it('404s on an unknown version without deleting', async () => {
      tx.scheduleVersion.findUnique.mockResolvedValue(null);

      await expect(service.remove(VERSION_ID, testUser())).rejects.toThrow(
        new NotFoundException('Schedule version not found.'),
      );
      expect(tx.scheduleVersion.delete).not.toHaveBeenCalled();
    });
  });
});
