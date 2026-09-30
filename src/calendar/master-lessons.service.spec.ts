import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  createPrismaMock,
  createTxMock,
  testUser,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import type { RealtimeService } from '../realtime/realtime.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { CreateMasterLessonDto } from './dto/create-master-lesson.dto';
import type { UpdateMasterLessonDto } from './dto/update-master-lesson.dto';
import { MasterLessonsService } from './master-lessons.service';

/** Monday. `remove`/`propagate` floor "today" to 2026-08-03T00:00:00Z. */
const NOW = new Date('2026-08-03T08:00:00.000Z');
const TODAY = new Date('2026-08-03T00:00:00.000Z');

const SCHOOL_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const YEAR_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SUBJECT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
/** The other lesson's subject — the other half of its own buffer's key. */
const OTHER_SUBJECT_ID = '00000000-aaaa-4aaa-8aaa-000000000004';
const GROUP_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const EXTRA_GROUP_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const OTHER_EXTRA_GROUP_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const TEACHER_ID = '99999999-9999-4999-8999-999999999999';
const CO_TEACHER_ID = '88888888-8888-4888-8888-888888888888';
const NEW_TEACHER_ID = '77777777-7777-4777-8777-777777777777';
const ROOM_ID = '66666666-6666-4666-8666-666666666666';
const LESSON_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_LESSON_ID = '44444444-4444-4444-8444-444444444444';
const STUDENT_ID = '33333333-3333-4333-8333-333333333331';
const OTHER_STUDENT_ID = '33333333-3333-4333-8333-333333333332';
/** A teaching group: a different id from the class, holding the same pupils. */
const TEACHING_GROUP_ID = '33333333-3333-4333-8333-333333333333';
const CAL_LESSON_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_CAL_LESSON_ID = '11111111-2222-4333-8444-666666666666';
/** testUser()'s default userId — the audit-trail actor. */
const USER_ID = '22222222-2222-4222-8222-222222222222';

/** "HH:MM" → the Date shape Prisma returns for a `@db.Time` column. */
const t = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`);
/** A `@db.Date` value: midnight UTC. */
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const NEW_ROOM_ID = '00000000-aaaa-4aaa-8aaa-000000000009';

/*
 * The database as Prisma answers it.
 *
 * A stub that resolves a whole row hands the service every column whether its
 * query asked for it or not, so a `select` that forgot a column the service
 * goes on to read passes here and fails in production as `undefined`. These
 * answer the way Prisma 5 does: only the selected columns come back, a select
 * with nothing truthy in it is refused before anything is read, a relation
 * named as `{}` comes back whole, and a findUnique without its key is refused.
 * A `where` is applied to the columns a fixture row spells out; a column the
 * row leaves out does not constrain it, so fixtures name only what a test is
 * about.
 */
type Row = Record<string, any>;
type Query = { where?: Row; select?: Row };

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

const same = (a: unknown, b: unknown): boolean =>
  a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([column, condition]) => {
    const value = row[column];
    if (value === undefined) return true;
    if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
      return Object.entries(condition as Row).every(([operator, operand]) => {
        if (operator === 'in') {
          return (operand as unknown[]).some((candidate) => same(value, candidate));
        }
        if (operator === 'not') return !same(value, operand);
        return matches(value, { [operator]: operand });
      });
    }
    return same(value, condition);
  });
}

/** findMany over a table: the rows the `where` admits, as selected. */
const answerRows =
  (rows: Row[]) =>
  (query: Query = {}) => {
    refuseEmptySelect(query.select);
    return Promise.resolve(
      rows.filter((row) => matches(row, query.where)).map((row) => project(row, query.select)),
    );
  };

/** findUnique over a table. */
const answerUnique =
  (rows: Row[]) =>
  (query: Query = {}) => {
    refuseEmptySelect(query.select);
    if (!query.where || Object.keys(query.where).length === 0) {
      throw new Error('Prisma refuses a findUnique without its unique key.');
    }
    const row = rows.find((candidate) => matches(candidate, query.where));
    return Promise.resolve(row ? project(row, query.select) : null);
  };

describe('MasterLessonsService', () => {
  let service: MasterLessonsService;
  let tx: TxMock;
  let prisma: PrismaMock;
  let realtime: { notifyMasterTimetableChanged: jest.Mock };
  let notifications: { recipientsForGroups: jest.Mock; notifyUsers: jest.Mock };

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    realtime = { notifyMasterTimetableChanged: jest.fn() };
    notifications = {
      recipientsForGroups: jest.fn().mockResolvedValue([]),
      notifyUsers: jest.fn().mockResolvedValue(0),
    };
    service = new MasterLessonsService(
      prisma as unknown as PrismaService,
      realtime as unknown as RealtimeService,
      notifications as unknown as NotificationsService,
    );

    // Quiet defaults; individual tests override what they assert on.
    sameDay([]);
    tx.availabilityConstraint.findMany.mockResolvedValue([]);
    tx.user.findMany.mockResolvedValue([]);
    tx.user.count.mockResolvedValue(0);
    tx.calendarLesson.findMany.mockResolvedValue([]);
    tx.calendarLesson.deleteMany.mockResolvedValue({ count: 0 });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /** The row shape LESSON_SELECT produces. Slot: Monday 10:00–11:00. */
  const lessonRecord = (overrides: Record<string, unknown> = {}) => ({
    id: LESSON_ID,
    academicYearId: YEAR_ID,
    subjectId: SUBJECT_ID,
    studentGroupId: GROUP_ID,
    teacherId: TEACHER_ID,
    coTeacherId: null,
    roomId: ROOM_ID,
    dayOfWeek: 1,
    startTime: t('10:00'),
    endTime: t('11:00'),
    isLocked: false,
    isParked: false,
    recurrence: 'ALL_WEEKS' as const,
    startDate: null as Date | null,
    endDate: null as Date | null,
    extraGroups: [] as Array<{ studentGroupId: string }>,
    participants: [] as Array<{ studentId: string }>,
    ...overrides,
  });

  /** An overlapping same-day lesson that collides with nothing by default. */
  const otherLesson = (overrides: Record<string, unknown> = {}) => ({
    id: OTHER_LESSON_ID,
    teacherId: '00000000-aaaa-4aaa-8aaa-000000000001',
    coTeacherId: null,
    roomId: '00000000-aaaa-4aaa-8aaa-000000000002',
    studentGroupId: '00000000-aaaa-4aaa-8aaa-000000000003',
    subjectId: OTHER_SUBJECT_ID,
    startTime: t('10:30'),
    endTime: t('11:30'),
    subject: { name: 'Math' },
    extraGroups: [] as Array<{ studentGroupId: string }>,
    participants: [] as Array<{ studentId: string }>,
    ...overrides,
  });

  /** The year's lessons on the candidate's weekday, as the clash scan reads them. */
  const sameDay = (rows: Row[]) =>
    tx.masterLesson.findMany.mockImplementation(answerRows(rows));

  /**
   * Who sits where: each pupil's home class, and the teaching groups that hold
   * them. One table answers every roster read — the participants' home classes,
   * both halves of rosterOf, and the reverse count — the way the database does.
   */
  const arrangePupils = (
    pupils: Array<{ id: string; studentGroupId: string | null }>,
    members: Array<{ studentId: string; studentGroupId: string }> = [],
  ) => {
    tx.user.findMany.mockImplementation(answerRows(pupils));
    tx.studentGroupMember.findMany.mockImplementation(answerRows(members));
    tx.user.count.mockImplementation((query: Query) =>
      Promise.resolve(pupils.filter((pupil) => matches(pupil, query.where)).length),
    );
  };

  /**
   * The pupil buffers the year carries, as pupilBuffersOf reads them: the
   * requirements somebody wrote a number on, keyed by (class, subject) because
   * a MasterLesson cannot name its requirement any other way.
   *
   * Unstubbed the table answers `[]` — no school has written a number — which is
   * why every test above this one still measures the exact half-open window.
   */
  const arrangeBuffers = (
    rows: Array<{
      studentGroupId: string;
      subjectId: string;
      minutesBefore?: number;
      minutesAfter?: number;
    }>,
  ) =>
    tx.teachingRequirement.findMany.mockImplementation(
      answerRows(rows.map((row) => ({ minutesBefore: 0, minutesAfter: 0, ...row }))),
    );

  // -------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------

  describe('create', () => {
    const createDto = (
      overrides: Partial<CreateMasterLessonDto> = {},
    ): CreateMasterLessonDto => ({
      academicYearId: YEAR_ID,
      subjectId: SUBJECT_ID,
      studentGroupId: GROUP_ID,
      teacherId: TEACHER_ID,
      roomId: ROOM_ID,
      dayOfWeek: 1,
      startTime: '10:00',
      endTime: '11:00',
      ...overrides,
    });

    const arrangeCreate = () => {
      tx.academicYear.findUnique.mockImplementation(
        answerUnique([{ id: YEAR_ID, schoolId: SCHOOL_ID }]),
      );
      tx.masterLesson.create.mockResolvedValue(
        lessonRecord({
          extraGroups: [{ studentGroupId: EXTRA_GROUP_ID }],
          participants: [{ studentId: STUDENT_ID }],
        }),
      );
    };

    it('runs under withRls for the calling principal and maps the created row', async () => {
      arrangeCreate();
      const user = testUser();

      await expect(service.create(createDto(), user)).resolves.toEqual({
        id: LESSON_ID,
        academicYearId: YEAR_ID,
        subjectId: SUBJECT_ID,
        studentGroupId: GROUP_ID,
        dayOfWeek: 1,
        startTime: '10:00',
        endTime: '11:00',
        roomId: ROOM_ID,
        teacherId: TEACHER_ID,
        coTeacherId: null,
        isLocked: false,
        isParked: false,
        // Defaults: every week, and the academic year's own boundaries.
        recurrence: 'ALL_WEEKS',
        startDate: null,
        endDate: null,
        extraGroupIds: [EXTRA_GROUP_ID],
        studentIds: [STUDENT_ID],
      });

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(prisma.withSystemTransaction).not.toHaveBeenCalled();
      expect(prisma.withServicePrincipal).not.toHaveBeenCalled();
    });

    // The composite (id, schoolId) keys added in 20260822130000 are what stop a
    // lesson naming another school's subject, group, teacher or room, and they
    // report it as P2003. Nothing here catches it on purpose: the exception
    // filter renders a bare P2003 as 400 "references a resource that does not
    // exist", which is what a foreign id is from inside the caller's tenant.
    // Wrapping this in `rethrowPrismaError` would quietly turn that into a 409.
    it('lets a reference the database refuses reach the filter as P2003', async () => {
      arrangeCreate();
      tx.masterLesson.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Foreign key constraint failed', {
          code: 'P2003',
          clientVersion: Prisma.prismaVersion.client,
        }),
      );

      await expect(
        service.create(createDto(), testUser()),
      ).rejects.toMatchObject({ code: 'P2003' });
    });

    it('persists the tenant from the academic-year row, not from the payload', async () => {
      arrangeCreate();

      await service.create(
        createDto({
          extraGroupIds: [EXTRA_GROUP_ID],
          studentIds: [STUDENT_ID],
        }),
        testUser(),
      );

      expect(tx.masterLesson.create).toHaveBeenCalledWith({
        data: {
          schoolId: SCHOOL_ID,
          academicYearId: YEAR_ID,
          subjectId: SUBJECT_ID,
          studentGroupId: GROUP_ID,
          teacherId: TEACHER_ID,
          coTeacherId: null,
          roomId: ROOM_ID,
          dayOfWeek: 1,
          startTime: new Date('1970-01-01T10:00:00.000Z'),
          endTime: new Date('1970-01-01T11:00:00.000Z'),
          isLocked: false,
          isGenerated: false,
          recurrence: 'ALL_WEEKS',
          startDate: null,
          endDate: null,
          extraGroups: {
            create: [{ schoolId: SCHOOL_ID, studentGroupId: EXTRA_GROUP_ID }],
          },
          participants: {
            create: [{ schoolId: SCHOOL_ID, studentId: STUDENT_ID }],
          },
        },
        select: expect.any(Object),
      });
    });

    it('persists a co-teacher, which no request could carry until now', async () => {
      /*
       * The column existed and the solver wrote it, but no request could: the
       * create and update DTOs had no field for it. So a co-taught lesson lost
       * its second teacher the moment a delete was undone — the undo recreates
       * through this very route.
       */
      arrangeCreate();

      await service.create({ ...createDto(), coTeacherId: CO_TEACHER_ID }, testUser());

      expect(tx.masterLesson.create.mock.calls[0][0].data.coTeacherId).toBe(
        CO_TEACHER_ID,
      );
    });

    it('sends the co-teacher into the clash check, not only the primary', async () => {
      // _detectConflicts reads candidate.coTeacherId. Leaving it off the
      // candidate meant a create naming a co-teacher was checked against half
      // the room — the teacher who is also in it went unexamined.
      arrangeCreate();
      // Already teaching 10:30-11:30, which the 10:00-11:00 candidate overlaps.
      sameDay([
        otherLesson({ teacherId: CO_TEACHER_ID }),
      ]);

      await expect(
        service.create({ ...createDto(), coTeacherId: CO_TEACHER_ID }, testUser()),
      ).rejects.toThrow();
      expect(tx.masterLesson.create).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------
    // Shared pupils across DIFFERENT groups.
    //
    // The group check above asks whether two groups are THE SAME. 4.1 and 4ma1
    // are not, and they hold Alva both — so the API accepted a double-booking
    // the web client's own engine (web/lib/conflicts.ts, groupsShareStudents)
    // has always refused. Every writer that is not that client — the solver, an
    // import, the mobile app, curl — went straight past it.
    // -----------------------------------------------------------------

    /** Route the two user.findMany call shapes to their own answers. */
    const arrangeRoster = (opts: {
      homeClass?: Array<{ id: string; studentGroupId: string }>;
      teachingGroups?: Array<{ studentId: string; studentGroupId: string }>;
    }) => {
      tx.user.findMany.mockImplementation((args: Record<string, any>) =>
        Promise.resolve(
          args?.where?.studentGroupId ? (opts.homeClass ?? []) : [],
        ),
      );
      tx.studentGroupMember.findMany.mockResolvedValue(opts.teachingGroups ?? []);
    };

    it('refuses a lesson whose pupils already sit in another group at that hour', async () => {
      arrangeCreate();
      sameDay([
        otherLesson({ studentGroupId: TEACHING_GROUP_ID }),
      ]);
      // Alva's home class is the candidate's group, and she is enrolled in the
      // teaching group the other lesson is filed under. Two different ids, one
      // pupil, one hour.
      arrangeRoster({
        homeClass: [{ id: STUDENT_ID, studentGroupId: GROUP_ID }],
        teachingGroups: [
          { studentId: STUDENT_ID, studentGroupId: TEACHING_GROUP_ID },
        ],
      });

      await expect(service.create(createDto(), testUser())).rejects.toThrow(
        /Students of this group/,
      );
      expect(tx.masterLesson.create).not.toHaveBeenCalled();
    });

    it('refuses it the other way round too', async () => {
      arrangeCreate();
      // Now the CANDIDATE is the teaching group and the other lesson is the
      // home class. Reading one side of the roster only would answer "no shared
      // pupils" here, since the interesting pair is always one of each.
      sameDay([
        otherLesson({ studentGroupId: GROUP_ID }),
      ]);
      arrangeRoster({
        homeClass: [{ id: STUDENT_ID, studentGroupId: GROUP_ID }],
        teachingGroups: [
          { studentId: STUDENT_ID, studentGroupId: TEACHING_GROUP_ID },
        ],
      });

      await expect(
        service.create(
          createDto({ studentGroupId: TEACHING_GROUP_ID }),
          testUser(),
        ),
      ).rejects.toThrow(/Students of this group/);
    });

    it('allows two groups that merely sit at the same hour', async () => {
      arrangeCreate();
      sameDay([
        otherLesson({ studentGroupId: TEACHING_GROUP_ID }),
      ]);
      // Different pupils. Two halves of a year taught in parallel is the point
      // of splitting them, not a clash.
      arrangeRoster({
        homeClass: [{ id: STUDENT_ID, studentGroupId: GROUP_ID }],
        teachingGroups: [
          { studentId: OTHER_STUDENT_ID, studentGroupId: TEACHING_GROUP_ID },
        ],
      });

      await service.create(createDto(), testUser());
      expect(tx.masterLesson.create).toHaveBeenCalled();
    });

    it('says it once when the group clashes with itself', async () => {
      arrangeCreate();
      // The commonest clash of all: 4.1 booked twice. Its pupils are shared
      // with itself by definition, so an unconditional pupil check would append
      // a second sentence saying the same thing in other words.
      sameDay([
        otherLesson({ studentGroupId: GROUP_ID }),
      ]);
      arrangeRoster({
        homeClass: [{ id: STUDENT_ID, studentGroupId: GROUP_ID }],
      });

      await expect(
        service.create(createDto(), testUser()),
      ).rejects.toMatchObject({
        message: 'The group already has Math in this slot.',
      });
    });

    it('asks the database nothing about pupils when no lesson overlaps', async () => {
      arrangeCreate();
      // Same day, an hour later. The common save lands on a day that is busy
      // but not at this hour, and paying for a roster there would be a tax on
      // every write.
      sameDay([
        otherLesson({ startTime: t('13:00'), endTime: t('14:00') }),
      ]);

      await service.create(createDto(), testUser());
      expect(tx.studentGroupMember.findMany).not.toHaveBeenCalled();
    });

    // Regeneration deletes what it owns. If this path ever left the column to
    // its default and the default moved, every lesson an admin placed by hand
    // would be deleted on the next optimizer run — so the write is asserted
    // here rather than trusted to the schema.
    // The roster below is read the way the database reads it — by the groups
    // in play — so a group left out of the question has no pupils to share.

    it('finds pupils shared with a group the other lesson only brings along', async () => {
      // 4ma1 attends the other lesson as an extra group rather than as its own.
      // It is in the room all the same, and Alva with it.
      arrangeCreate();
      sameDay([otherLesson({ extraGroups: [{ studentGroupId: TEACHING_GROUP_ID }] })]);
      arrangePupils(
        [{ id: STUDENT_ID, studentGroupId: GROUP_ID }],
        [{ studentId: STUDENT_ID, studentGroupId: TEACHING_GROUP_ID }],
      );

      await expect(service.create(createDto(), testUser())).rejects.toThrow(
        new ConflictException('Students of this group already have Math in this slot.'),
      );
    });

    it('finds the shared pupil wherever she sits in the class list', async () => {
      arrangeCreate();
      sameDay([otherLesson({ studentGroupId: TEACHING_GROUP_ID })]);
      // Alva is listed first, and a classmate who takes no part in 4ma1 after.
      arrangePupils(
        [
          { id: STUDENT_ID, studentGroupId: GROUP_ID },
          { id: OTHER_STUDENT_ID, studentGroupId: GROUP_ID },
        ],
        [{ studentId: STUDENT_ID, studentGroupId: TEACHING_GROUP_ID }],
      );

      await expect(service.create(createDto(), testUser())).rejects.toThrow(
        new ConflictException('Students of this group already have Math in this slot.'),
      );
    });

    it('does not hold a participant busy for a class that is elsewhere at that hour', async () => {
      // The pupil's home class has no lesson in this slot, so the pupil is
      // free, whatever the other lesson is.
      arrangeCreate();
      sameDay([otherLesson()]);
      arrangePupils([{ id: STUDENT_ID, studentGroupId: OTHER_EXTRA_GROUP_ID }]);

      await expect(
        service.create(createDto({ studentIds: [STUDENT_ID] }), testUser()),
      ).resolves.toMatchObject({ id: LESSON_ID });
    });

    it('says a participant is busy once, not again as a classmate of the other lesson', async () => {
      // Alva belongs to this class and takes part in the other lesson by name.
      // One pupil, one clash, one sentence.
      arrangeCreate();
      sameDay([otherLesson({ participants: [{ studentId: STUDENT_ID }] })]);
      arrangePupils([{ id: STUDENT_ID, studentGroupId: GROUP_ID }]);

      await expect(
        service.create(createDto({ studentIds: [STUDENT_ID] }), testUser()),
      ).rejects.toThrow(
        new ConflictException('A participating student already has Math in this slot.'),
      );
    });

    it('lets the other lesson keep participants from another class', async () => {
      arrangeCreate();
      sameDay([otherLesson({ participants: [{ studentId: OTHER_STUDENT_ID }] })]);
      arrangePupils([{ id: OTHER_STUDENT_ID, studentGroupId: OTHER_EXTRA_GROUP_ID }]);

      await expect(service.create(createDto(), testUser())).resolves.toMatchObject({
        id: LESSON_ID,
      });
    });

    it('claims a hand-placed lesson for the humans, whatever the column default', async () => {
      arrangeCreate();

      await service.create(
        createDto({
          // The shape a generated lesson now inherits from its requirement, to
          // make the point that the flag is what decides ownership: a window
          // no longer implies a human, and a plain lesson no longer implies
          // the machine.
          recurrence: 'ODD_WEEKS',
          startDate: '2026-08-31',
          endDate: '2026-12-18',
          isLocked: true,
        }),
        testUser(),
      );

      expect(tx.masterLesson.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ isGenerated: false }),
        }),
      );
    });

    it('honours an explicit isLocked flag', async () => {
      arrangeCreate();

      await service.create(createDto({ isLocked: true }), testUser());

      expect(tx.masterLesson.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ isLocked: true }),
        }),
      );
    });

    it('404s on an unknown academic year without creating anything', async () => {
      tx.academicYear.findUnique.mockResolvedValue(null);

      await expect(
        service.create(createDto(), testUser()),
      ).rejects.toThrow(new NotFoundException('Academic year not found.'));
      expect(tx.masterLesson.create).not.toHaveBeenCalled();
    });

    it('rejects an inverted time range before scanning for conflicts', async () => {
      arrangeCreate();

      await expect(
        service.create(
          createDto({ startTime: '11:00', endTime: '10:00' }),
          testUser(),
        ),
      ).rejects.toThrow('startTime must be before endTime.');
      expect(tx.masterLesson.findMany).not.toHaveBeenCalled();
    });

    it('rejects a zero-length time range', async () => {
      arrangeCreate();

      await expect(
        service.create(
          createDto({ startTime: '10:00', endTime: '10:00' }),
          testUser(),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('drops the primary group from extraGroupIds', async () => {
      arrangeCreate();

      await service.create(
        createDto({ extraGroupIds: [GROUP_ID, EXTRA_GROUP_ID] }),
        testUser(),
      );

      expect(tx.masterLesson.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            extraGroups: {
              create: [{ schoolId: SCHOOL_ID, studentGroupId: EXTRA_GROUP_ID }],
            },
          }),
        }),
      );
    });

    it('dedupes studentIds before creating participants', async () => {
      arrangeCreate();

      await service.create(
        createDto({ studentIds: [STUDENT_ID, STUDENT_ID] }),
        testUser(),
      );

      expect(tx.masterLesson.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            participants: {
              create: [{ schoolId: SCHOOL_ID, studentId: STUDENT_ID }],
            },
          }),
        }),
      );
    });

    // MasterLessonGroups has @@unique([masterLessonId, studentGroupId]), so a
    // payload naming the same group twice has to be deduped before the nested
    // create — otherwise the constraint answers with a P2002, which the global
    // filter turns into a 409 for a payload that conflicts with nothing. The
    // DTO's @IsUUID each-check lets duplicates through.
    it('dedupes duplicate extraGroupIds before the nested create', async () => {
      arrangeCreate();

      await service.create(
        createDto({ extraGroupIds: [EXTRA_GROUP_ID, EXTRA_GROUP_ID] }),
        testUser(),
      );

      expect(tx.masterLesson.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            extraGroups: {
              create: [{ schoolId: SCHOOL_ID, studentGroupId: EXTRA_GROUP_ID }],
            },
          }),
        }),
      );
    });

    it('scans conflicts across the whole year without excluding any lesson', async () => {
      arrangeCreate();

      await service.create(createDto(), testUser());

      expect(tx.masterLesson.findMany).toHaveBeenCalledWith({
        where: { academicYearId: YEAR_ID, dayOfWeek: 1, isParked: false },
        select: expect.any(Object),
      });
      expect(tx.availabilityConstraint.findMany).toHaveBeenCalledWith({
        where: {
          type: 'UNAVAILABLE',
          dayOfWeek: 1,
          date: null,
          OR: [
            { resourceType: 'TEACHER', userId: TEACHER_ID },
            { resourceType: 'ROOM', roomId: ROOM_ID },
            { resourceType: 'STUDENT_GROUP', studentGroupId: { in: [GROUP_ID] } },
          ],
        },
        select: { resourceType: true, startTime: true, endTime: true },
      });
    });

    it('only queries availability for the resources the lesson actually uses', async () => {
      arrangeCreate();

      await service.create(
        createDto({ teacherId: null, roomId: null }),
        testUser(),
      );

      expect(tx.availabilityConstraint.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: [
              {
                resourceType: 'STUDENT_GROUP',
                studentGroupId: { in: [GROUP_ID] },
              },
            ],
          }),
        }),
      );
    });

    it('409s when the teacher already teaches in the slot and creates nothing', async () => {
      arrangeCreate();
      sameDay([
        otherLesson({ teacherId: TEACHER_ID }),
      ]);

      const promise = service.create(createDto(), testUser());
      await expect(promise).rejects.toBeInstanceOf(ConflictException);
      await expect(promise).rejects.toMatchObject({
        message: 'Teacher already teaches Math in this slot.',
      });
      expect(tx.masterLesson.create).not.toHaveBeenCalled();
      expect(realtime.notifyMasterTimetableChanged).not.toHaveBeenCalled();
    });

    it('folds distinct conflicts into one 409 message', async () => {
      arrangeCreate();
      sameDay([
        otherLesson({ teacherId: TEACHER_ID, roomId: ROOM_ID }),
      ]);

      await expect(
        service.create(createDto(), testUser()),
      ).rejects.toMatchObject({
        message:
          'Teacher already teaches Math in this slot. ' +
          'Room is already booked for Math in this slot.',
      });
    });

    it('reports identical conflicts only once', async () => {
      arrangeCreate();
      sameDay([
        otherLesson({ teacherId: TEACHER_ID }),
        otherLesson({
          id: '00000000-bbbb-4bbb-8bbb-000000000001',
          teacherId: TEACHER_ID,
        }),
      ]);

      await expect(
        service.create(createDto(), testUser()),
      ).rejects.toMatchObject({
        message: 'Teacher already teaches Math in this slot.',
      });
    });

    it('409s when the primary group already has a lesson in the slot', async () => {
      arrangeCreate();
      sameDay([
        otherLesson({ studentGroupId: GROUP_ID }),
      ]);

      await expect(
        service.create(createDto(), testUser()),
      ).rejects.toMatchObject({
        message: 'The group already has Math in this slot.',
      });
    });

    it('409s when a candidate extra group clashes with the other lesson', async () => {
      arrangeCreate();
      sameDay([
        otherLesson({ studentGroupId: EXTRA_GROUP_ID }),
      ]);

      await expect(
        service.create(
          createDto({ extraGroupIds: [EXTRA_GROUP_ID] }),
          testUser(),
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('reads no parked lesson as an occupant', async () => {
      // A parked lesson keeps its old day and time only as a memory. Reading
      // that as a placement would refuse B the very slot A was lifted out of.
      arrangeCreate();

      await service.create(createDto(), testUser());

      expect(tx.masterLesson.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ isParked: false }),
        }),
      );
    });

    it("409s when the primary group is among the other lesson's extra groups", async () => {
      arrangeCreate();
      sameDay([
        otherLesson({ extraGroups: [{ studentGroupId: GROUP_ID }] }),
      ]);

      await expect(
        service.create(createDto(), testUser()),
      ).rejects.toMatchObject({
        message: 'The group already has Math in this slot.',
      });
    });

    it('treats back-to-back lessons as non-overlapping', async () => {
      arrangeCreate();
      // Same teacher, same room, same group — but 09:00–10:00 abuts 10:00.
      sameDay([
        otherLesson({
          teacherId: TEACHER_ID,
          roomId: ROOM_ID,
          studentGroupId: GROUP_ID,
          startTime: t('09:00'),
          endTime: t('10:00'),
        }),
      ]);

      await expect(
        service.create(createDto(), testUser()),
      ).resolves.toMatchObject({ id: LESSON_ID });
    });

    // -----------------------------------------------------------------
    // Ombyte före och dusch efter: the pupil buffer
    // -----------------------------------------------------------------

    describe('ombyte och dusch kring lektionen', () => {
      /** Idrott 10:00–11:00 for GROUP_ID, with 20 minutes of shower after it. */
      const arrangeShower = (
        buffer: { minutesBefore?: number; minutesAfter?: number } = { minutesAfter: 20 },
      ) => {
        arrangeCreate();
        arrangeBuffers([{ studentGroupId: GROUP_ID, subjectId: SUBJECT_ID, ...buffer }]);
      };

      it('refuses a lesson only the shower reaches', async () => {
        // 10:00–11:00 idrott and 11:00–12:00 matematik do not overlap by one
        // minute, and the check has always allowed exactly this. It stops being
        // allowed the moment the class needs twenty minutes to shower first: the
        // children are in the omklädningsrummet until 11:20 and cannot be in
        // matematik at 11:00.
        arrangeShower();
        sameDay([
          otherLesson({
            studentGroupId: GROUP_ID,
            startTime: t('11:00'),
            endTime: t('12:00'),
          }),
        ]);

        await expect(service.create(createDto(), testUser())).rejects.toMatchObject({
          message:
            'Klassen är upptagen med ombyte eller dusch i den här tiden: ' +
            'den här lektionen kräver 20 min dusch och ombyte efter.',
        });
      });

      it('refuses the class ahead of the lesson too, for the ombyte before it', async () => {
        arrangeShower({ minutesBefore: 10 });
        sameDay([
          otherLesson({
            studentGroupId: GROUP_ID,
            startTime: t('09:00'),
            endTime: t('10:00'),
          }),
        ]);

        await expect(service.create(createDto(), testUser())).rejects.toMatchObject({
          message:
            'Klassen är upptagen med ombyte eller dusch i den här tiden: ' +
            'den här lektionen kräver 10 min ombyte före.',
        });
      });

      it('counts both lessons’ buffers, neither of which is enough alone', async () => {
        // 09:00–09:45 slöjd, then idrott at 10:00. Fifteen minutes apart, and the
        // gap survives either buffer on its own: the idrott's 10 minutes of
        // ombyte reach back only to 09:50, and the slöjd's own 10 minutes reach
        // forward only to 09:55. Together they meet, and the class is in two
        // places at 09:52.
        arrangeCreate();
        arrangeBuffers([
          { studentGroupId: GROUP_ID, subjectId: SUBJECT_ID, minutesBefore: 10 },
          { studentGroupId: GROUP_ID, subjectId: OTHER_SUBJECT_ID, minutesAfter: 10 },
        ]);
        sameDay([
          otherLesson({
            studentGroupId: GROUP_ID,
            startTime: t('09:00'),
            endTime: t('09:45'),
          }),
        ]);

        await expect(service.create(createDto(), testUser())).rejects.toMatchObject({
          message:
            'Klassen är upptagen med ombyte eller dusch i den här tiden: ' +
            'den här lektionen kräver 10 min ombyte före, och ' +
            'Math kräver 10 min dusch och ombyte efter.',
        });
      });

      it('leaves the gap alone when each buffer only reaches half of it', async () => {
        // The same 09:45/10:00 gap, with only the idrott's own 10 minutes: the
        // class is free from 09:45 and changing from 09:50. Nothing to refuse,
        // and a padding that fired here would be padding a corridor rather than
        // naming what the children do.
        arrangeShower({ minutesBefore: 10 });
        sameDay([
          otherLesson({
            studentGroupId: GROUP_ID,
            startTime: t('09:00'),
            endTime: t('09:45'),
          }),
        ]);

        await expect(service.create(createDto(), testUser())).resolves.toMatchObject({
          id: LESSON_ID,
        });
      });

      it('does NOT hold the teacher or the room through the shower', async () => {
        // The user's decision, and the one this whole feature turns on. Same
        // teacher and same room, 11:00–12:00, against an idrott that keeps its
        // class until 11:20: the idrottslärare does not shower with them and the
        // gymnastiksal is empty while they do, so both placements are true.
        // Refusing here would cost the teacher a third of their week and make a
        // scarce hall unbookable around every lesson.
        arrangeShower();
        sameDay([
          otherLesson({
            teacherId: TEACHER_ID,
            roomId: ROOM_ID,
            startTime: t('11:00'),
            endTime: t('12:00'),
          }),
        ]);

        await expect(service.create(createDto(), testUser())).resolves.toMatchObject({
          id: LESSON_ID,
        });
      });

      it('still refuses the teacher and the room on a real overlap', async () => {
        // The other half of the same decision: the exact half-open test survives
        // the widening rather than being replaced by it.
        arrangeShower();
        sameDay([
          otherLesson({
            teacherId: TEACHER_ID,
            roomId: ROOM_ID,
            startTime: t('10:30'),
            endTime: t('11:30'),
          }),
        ]);

        const promise = service.create(createDto(), testUser());
        await expect(promise).rejects.toBeInstanceOf(ConflictException);
        await expect(promise).rejects.toMatchObject({
          message:
            'Teacher already teaches Math in this slot. ' +
            'Room is already booked for Math in this slot.',
        });
      });

      it('reaches a pupil the two groups merely share', async () => {
        // 4.1 and 4ma1 are different groups holding the same child, and the
        // buffer follows the child rather than the group name.
        arrangeShower();
        arrangePupils(
          [{ id: STUDENT_ID, studentGroupId: GROUP_ID }],
          [{ studentId: STUDENT_ID, studentGroupId: TEACHING_GROUP_ID }],
        );
        sameDay([
          otherLesson({
            studentGroupId: TEACHING_GROUP_ID,
            startTime: t('11:00'),
            endTime: t('12:00'),
          }),
        ]);

        await expect(service.create(createDto(), testUser())).rejects.toMatchObject({
          message:
            'Elever i gruppen är upptagna med ombyte eller dusch i den här tiden: ' +
            'den här lektionen kräver 20 min dusch och ombyte efter.',
        });
      });

      it('asks the year only for the requirements that carry a number', async () => {
        // The thrift the mechanism has to pay for itself with: a school that has
        // never written an ombyte gets one query that finds nothing, and every
        // window below then collapses to the exact test.
        arrangeShower();
        sameDay([otherLesson()]);

        await service.create(createDto(), testUser());

        expect(tx.teachingRequirement.findMany).toHaveBeenCalledWith({
          where: {
            academicYearId: YEAR_ID,
            OR: [{ minutesBefore: { gt: 0 } }, { minutesAfter: { gt: 0 } }],
          },
          select: {
            studentGroupId: true,
            subjectId: true,
            minutesBefore: true,
            minutesAfter: true,
          },
        });
      });

      it('asks nothing about buffers on a day with no other lesson', async () => {
        arrangeShower();

        await service.create(createDto(), testUser());

        expect(tx.teachingRequirement.findMany).not.toHaveBeenCalled();
      });

      /*
       * A lesson two classes attend takes the WIDEST buffer among them.
       *
       * The pupils of a visiting class change and shower too, and the lesson
       * holds all of them, so the only number that covers everybody on it is the
       * largest. The cost is stated as plainly in the tests as in the code: a
       * guest with a longer rule lengthens the block for the HOST class as well,
       * which no single row asked for — and that is the direction to err in,
       * because the other error puts a class in matematiken while it is still in
       * duschen.
       */
      describe('gästklassen räknas med', () => {
        it("takes the guest's longer dusch, although the host class's own row is shorter", async () => {
          // 7A reads idrott with five minutes of dusch; 7B, joining, has twenty.
          // 11:15 clears 7A's own rule by ten minutes and is still refused —
          // exactly the cost, and 7B's children are in omklädningsrummet until
          // 11:20 whoever the lesson belongs to.
          arrangeCreate();
          arrangeBuffers([
            { studentGroupId: GROUP_ID, subjectId: SUBJECT_ID, minutesAfter: 5 },
            { studentGroupId: EXTRA_GROUP_ID, subjectId: SUBJECT_ID, minutesAfter: 20 },
          ]);
          sameDay([
            otherLesson({
              studentGroupId: GROUP_ID,
              startTime: t('11:15'),
              endTime: t('12:15'),
            }),
          ]);

          await expect(
            service.create(createDto({ extraGroupIds: [EXTRA_GROUP_ID] }), testUser()),
          ).rejects.toMatchObject({
            message:
              'Klassen är upptagen med ombyte eller dusch i den här tiden: ' +
              'den här lektionen kräver 20 min dusch och ombyte efter.',
          });
        });

        it('a guest with no rule of its own does not shrink the host class’s', async () => {
          // The widening is a maximum, not an average: `buffers` holds only the
          // requirements somebody wrote a number on, so a guest without one
          // contributes nothing rather than a zero. Averaging — or letting the
          // last group read win — would quietly halve a dusch by adding a class.
          arrangeCreate();
          arrangeBuffers([
            { studentGroupId: GROUP_ID, subjectId: SUBJECT_ID, minutesAfter: 20 },
          ]);
          sameDay([
            otherLesson({
              studentGroupId: GROUP_ID,
              startTime: t('11:15'),
              endTime: t('12:15'),
            }),
          ]);

          await expect(
            service.create(createDto({ extraGroupIds: [EXTRA_GROUP_ID] }), testUser()),
          ).rejects.toMatchObject({
            message:
              'Klassen är upptagen med ombyte eller dusch i den här tiden: ' +
              'den här lektionen kräver 20 min dusch och ombyte efter.',
          });
        });

        it("reads the OTHER lesson's guest class by the same rule", async () => {
          // Both sides or neither. The candidate has no buffer at all here; what
          // reaches back into it is the ombyte of a class that merely joins the
          // lesson it is being placed against, and forgetting that half would
          // make the check depend on which lesson somebody happened to move.
          arrangeCreate();
          arrangeBuffers([
            {
              studentGroupId: EXTRA_GROUP_ID,
              subjectId: OTHER_SUBJECT_ID,
              minutesBefore: 20,
            },
          ]);
          sameDay([
            otherLesson({
              studentGroupId: GROUP_ID,
              extraGroups: [{ studentGroupId: EXTRA_GROUP_ID }],
              startTime: t('11:15'),
              endTime: t('12:15'),
            }),
          ]);

          await expect(service.create(createDto(), testUser())).rejects.toMatchObject({
            message:
              'Klassen är upptagen med ombyte eller dusch i den här tiden: ' +
              'Math kräver 20 min ombyte före.',
          });
        });

        it('still holds neither the teacher nor the room through a guest’s dusch', async () => {
          // The decision the whole feature turns on, now that a guest class can
          // be what widens the window: the idrottslärare does not shower with
          // 7B either, and the gymnastiksal is just as empty. Same teacher, same
          // room, 11:15 — and nothing on the clock overlaps.
          arrangeCreate();
          arrangeBuffers([
            { studentGroupId: EXTRA_GROUP_ID, subjectId: SUBJECT_ID, minutesAfter: 20 },
          ]);
          sameDay([
            otherLesson({
              teacherId: TEACHER_ID,
              roomId: ROOM_ID,
              startTime: t('11:15'),
              endTime: t('12:15'),
            }),
          ]);

          await expect(
            service.create(createDto({ extraGroupIds: [EXTRA_GROUP_ID] }), testUser()),
          ).resolves.toMatchObject({ id: LESSON_ID });
        });

        it('asks the year for the buffers once, not once per class on the lesson', async () => {
          // The map is keyed on (group, subject) and read per group, so adding a
          // guest class costs a lookup and not a query.
          arrangeCreate();
          arrangeBuffers([
            { studentGroupId: EXTRA_GROUP_ID, subjectId: SUBJECT_ID, minutesAfter: 20 },
          ]);
          sameDay([otherLesson()]);

          await service.create(
            createDto({ extraGroupIds: [EXTRA_GROUP_ID] }),
            testUser(),
          );

          expect(tx.teachingRequirement.findMany).toHaveBeenCalledTimes(1);
        });
      });
    });

    it.each([
      ['TEACHER', 'The teacher is unavailable in this slot.'],
      ['ROOM', 'The room is unavailable in this slot.'],
      ['STUDENT_GROUP', 'The student group is unavailable in this slot.'],
    ])(
      '409s on a weekly UNAVAILABLE %s constraint covering the slot',
      async (resourceType, label) => {
        arrangeCreate();
        tx.availabilityConstraint.findMany.mockResolvedValue([
          { resourceType, startTime: t('10:30'), endTime: t('12:00') },
        ]);

        const promise = service.create(createDto(), testUser());
        await expect(promise).rejects.toBeInstanceOf(ConflictException);
        await expect(promise).rejects.toMatchObject({ message: label });
      },
    );

    it('ignores an UNAVAILABLE constraint that ends when the lesson starts', async () => {
      arrangeCreate();
      tx.availabilityConstraint.findMany.mockResolvedValue([
        { resourceType: 'TEACHER', startTime: t('08:00'), endTime: t('10:00') },
      ]);

      await expect(
        service.create(createDto(), testUser()),
      ).resolves.toMatchObject({ id: LESSON_ID });
    });

    it("409s when a participating student's home class attends the other lesson", async () => {
      arrangeCreate();
      const homeGroup = '00000000-cccc-4ccc-8ccc-000000000001';
      tx.user.findMany.mockResolvedValue([
        { id: STUDENT_ID, studentGroupId: homeGroup },
      ]);
      sameDay([
        otherLesson({ studentGroupId: homeGroup }),
      ]);

      await expect(
        service.create(createDto({ studentIds: [STUDENT_ID] }), testUser()),
      ).rejects.toMatchObject({
        message: 'A participating student already has Math in this slot.',
      });
      // Home groups were resolved for exactly the candidate students.
      expect(tx.user.findMany).toHaveBeenCalledWith({
        where: { id: { in: [STUDENT_ID] } },
        select: { id: true, studentGroupId: true },
      });
    });

    it('409s when a participating student individually attends the other lesson', async () => {
      arrangeCreate();
      tx.user.findMany.mockResolvedValue([
        { id: STUDENT_ID, studentGroupId: null },
      ]);
      sameDay([
        otherLesson({ participants: [{ studentId: STUDENT_ID }] }),
      ]);

      await expect(
        service.create(createDto({ studentIds: [STUDENT_ID] }), testUser()),
      ).rejects.toMatchObject({
        message: 'A participating student already has Math in this slot.',
      });
    });

    it("409s when the other lesson's individual participants belong to this class", async () => {
      arrangeCreate();
      const foreignStudent = '00000000-dddd-4ddd-8ddd-000000000001';
      sameDay([
        otherLesson({ participants: [{ studentId: foreignStudent }] }),
      ]);
      tx.user.count.mockResolvedValue(1);

      await expect(
        service.create(createDto(), testUser()),
      ).rejects.toMatchObject({
        message: 'A student of this class attends Math in this slot.',
      });
      expect(tx.user.count).toHaveBeenCalledWith({
        where: {
          id: { in: [foreignStudent] },
          studentGroupId: { in: [GROUP_ID] },
        },
      });
    });

    it('does not flag a class-less student who is otherwise free', async () => {
      arrangeCreate();
      tx.user.findMany.mockResolvedValue([
        { id: STUDENT_ID, studentGroupId: null },
      ]);
      sameDay([otherLesson()]);

      await expect(
        service.create(createDto({ studentIds: [STUDENT_ID] }), testUser()),
      ).resolves.toMatchObject({ id: LESSON_ID });
    });

    it('writes no participants for a lesson that names none', async () => {
      arrangeCreate();

      await service.create(createDto(), testUser());

      expect(tx.masterLesson.create.mock.calls[0][0].data.participants).toEqual({
        create: [],
      });
    });

    it('refuses a teacher who co-teaches the other lesson', async () => {
      arrangeCreate();
      sameDay([otherLesson({ coTeacherId: TEACHER_ID })]);

      await expect(service.create(createDto(), testUser())).rejects.toThrow(
        new ConflictException('Teacher already teaches Math in this slot.'),
      );
    });

    it('lets an odd-week lesson share its slot with an even-week one', async () => {
      // Slöjd on odd weeks and hemkunskap on even weeks: the same hour and the
      // same teacher, never the same week.
      arrangeCreate();
      sameDay([otherLesson({ teacherId: TEACHER_ID, recurrence: 'EVEN_WEEKS' })]);

      await expect(
        service.create(createDto({ recurrence: 'ODD_WEEKS' }), testUser()),
      ).resolves.toMatchObject({ id: LESSON_ID });
    });

    it.each([
      ['spring', { startDate: '2027-01-11' }, { endDate: day('2026-12-18') }],
      ['autumn', { endDate: '2026-12-18' }, { startDate: day('2027-01-11') }],
    ])(
      'lets a %s-term lesson share its slot with one in the other term',
      async (_label, window, otherWindow) => {
        arrangeCreate();
        sameDay([otherLesson({ teacherId: TEACHER_ID, ...otherWindow })]);

        await expect(
          service.create(createDto(window), testUser()),
        ).resolves.toMatchObject({ id: LESSON_ID });
      },
    );

    it('lets the other lesson start as this one ends', async () => {
      // The mirror of back-to-back above: 10:00–11:00 against 11:00–12:00.
      arrangeCreate();
      sameDay([
        otherLesson({
          teacherId: TEACHER_ID,
          roomId: ROOM_ID,
          studentGroupId: GROUP_ID,
          startTime: t('11:00'),
          endTime: t('12:00'),
        }),
      ]);

      await expect(service.create(createDto(), testUser())).resolves.toMatchObject({
        id: LESSON_ID,
      });
    });

    it('reads the minutes of a slot, not only its hour', async () => {
      // 10:45–11:30 against 10:00–10:30: a quarter of an hour apart, and the
      // same hour on the clock.
      arrangeCreate();
      sameDay([
        otherLesson({ teacherId: TEACHER_ID, startTime: t('10:00'), endTime: t('10:30') }),
      ]);

      await expect(
        service.create(createDto({ startTime: '10:45', endTime: '11:30' }), testUser()),
      ).resolves.toMatchObject({ id: LESSON_ID });
    });

    it.each([
      ['starts when the lesson ends', '11:00', '12:00'],
      ['lies later the same day', '12:00', '13:00'],
    ])('ignores an UNAVAILABLE constraint that %s', async (_label, start, end) => {
      arrangeCreate();
      tx.availabilityConstraint.findMany.mockResolvedValue([
        { resourceType: 'TEACHER', startTime: t(start), endTime: t(end) },
      ]);

      await expect(service.create(createDto(), testUser())).resolves.toMatchObject({
        id: LESSON_ID,
      });
    });

    it('writes a CREATE entry to the audit trail', async () => {
      arrangeCreate();

      await service.create(createDto(), testUser());

      expect(tx.scheduleChangeLog.create).toHaveBeenCalledWith({
        data: {
          schoolId: SCHOOL_ID,
          academicYearId: YEAR_ID,
          masterLessonId: LESSON_ID,
          actorId: USER_ID,
          action: 'CREATE',
          before: undefined,
          after: expect.objectContaining({
            id: LESSON_ID,
            startTime: '10:00',
            endTime: '11:00',
          }),
        },
      });
    });

    it('records a null actor when the principal carries no userId', async () => {
      arrangeCreate();

      await service.create(createDto(), testUser({ userId: undefined }));

      expect(tx.scheduleChangeLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'CREATE', actorId: null }),
        }),
      );
    });

    it("broadcasts the change to the academic year's school", async () => {
      arrangeCreate();

      await service.create(createDto(), testUser());

      expect(realtime.notifyMasterTimetableChanged).toHaveBeenCalledWith(
        SCHOOL_ID,
      );
    });
  });

  // -------------------------------------------------------------------
  // update
  // -------------------------------------------------------------------

  describe('update', () => {
    /** LESSON_SELECT + the school join the update path selects. */
    const storedLesson = (overrides: Record<string, unknown> = {}) => ({
      ...lessonRecord(),
      school: { id: SCHOOL_ID, timezone: 'Europe/Stockholm' },
      ...overrides,
    });

    const arrangeUpdate = (
      lessonOverrides: Record<string, unknown> = {},
      updatedOverrides: Record<string, unknown> = {},
    ) => {
      tx.masterLesson.findUnique.mockImplementation(
        answerUnique([storedLesson(lessonOverrides)]),
      );
      tx.masterLesson.update.mockResolvedValue(lessonRecord(updatedOverrides));
    };

    it('finds the buffer through the subject the stored lesson already has', async () => {
      // A PATCH never names a subject, so the buffer has to be found from the
      // row. Moving this idrott to 11:00–12:00 puts its own class's 09:00–10:00
      // matematik 60 minutes away and its shower reaches back… nowhere — but the
      // matematik keeps the class until 10:20, and the idrott now starts inside
      // that. Nothing in the patch says "idrott"; only lesson.subjectId does.
      arrangeUpdate();
      arrangeBuffers([
        { studentGroupId: GROUP_ID, subjectId: OTHER_SUBJECT_ID, minutesAfter: 20 },
      ]);
      sameDay([
        otherLesson({
          studentGroupId: GROUP_ID,
          startTime: t('09:00'),
          endTime: t('10:00'),
        }),
      ]);

      await expect(
        service.update(LESSON_ID, { startTime: '10:10', endTime: '11:10' }, testUser()),
      ).rejects.toMatchObject({
        message:
          'Klassen är upptagen med ombyte eller dusch i den här tiden: ' +
          'Math kräver 20 min dusch och ombyte efter.',
      });
    });

    it('404s on an unknown lesson', async () => {
      tx.masterLesson.findUnique.mockResolvedValue(null);

      await expect(
        service.update(LESSON_ID, { dayOfWeek: 2 }, testUser()),
      ).rejects.toThrow(new NotFoundException('Master lesson not found.'));
      expect(tx.masterLesson.update).not.toHaveBeenCalled();
    });

    it('moves the slot, propagates to future lessons in school wall-clock time, and reports the count', async () => {
      // Monday 10:00–11:00 → Wednesday 09:00–10:30. One materialized lesson
      // next Monday (2026-08-10) moves to Wednesday 2026-08-12; Stockholm is
      // UTC+2 in August, so 09:00 wall clock = 07:00Z.
      arrangeUpdate(
        {},
        { dayOfWeek: 3, startTime: t('09:00'), endTime: t('10:30') },
      );
      tx.calendarLesson.findMany.mockResolvedValue([
        { id: CAL_LESSON_ID, date: new Date('2026-08-10T00:00:00.000Z') },
      ]);
      const user = testUser();

      const dto: UpdateMasterLessonDto = {
        dayOfWeek: 3,
        startTime: '09:00',
        endTime: '10:30',
      };
      await expect(service.update(LESSON_ID, dto, user)).resolves.toEqual({
        id: LESSON_ID,
        academicYearId: YEAR_ID,
        subjectId: SUBJECT_ID,
        studentGroupId: GROUP_ID,
        dayOfWeek: 3,
        startTime: '09:00',
        endTime: '10:30',
        roomId: ROOM_ID,
        teacherId: TEACHER_ID,
        coTeacherId: null,
        isLocked: false,
        isParked: false,
        // Untouched by a move: the lesson keeps the weeks it ran before.
        recurrence: 'ALL_WEEKS',
        startDate: null,
        endDate: null,
        extraGroupIds: [],
        studentIds: [],
        propagatedLessons: 1,
        // The lesson still runs every week, so nothing is stranded.
        removedCalendarLessons: 0,
      });

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      // Only future, still-SCHEDULED, attendance-free lessons are touched.
      expect(tx.calendarLesson.findMany).toHaveBeenCalledWith({
        where: {
          masterLessonId: LESSON_ID,
          status: 'SCHEDULED',
          date: { gte: TODAY },
          attendanceRecords: { none: {} },
        },
        select: { id: true, date: true },
      });
      expect(tx.calendarLesson.update).toHaveBeenCalledWith({
        where: { id: CAL_LESSON_ID },
        data: {
          date: new Date('2026-08-12T00:00:00.000Z'),
          startsAt: new Date('2026-08-12T07:00:00.000Z'),
          endsAt: new Date('2026-08-12T08:30:00.000Z'),
          roomId: ROOM_ID,
        },
      });
      // A plain move of an every-week lesson strands nothing.
      expect(tx.calendarLesson.deleteMany).not.toHaveBeenCalled();
      expect(realtime.notifyMasterTimetableChanged).toHaveBeenCalledWith(
        SCHOOL_ID,
      );
    });

    it('merges the patch onto the current slot and excludes itself from the scan', async () => {
      // Stored participants stay part of the conflict scan even when the
      // patch does not touch them.
      arrangeUpdate(
        { participants: [{ studentId: STUDENT_ID }] },
        { dayOfWeek: 4 },
      );

      await service.update(LESSON_ID, { dayOfWeek: 4 }, testUser());

      expect(tx.user.findMany).toHaveBeenCalledWith({
        where: { id: { in: [STUDENT_ID] } },
        select: { id: true, studentGroupId: true },
      });
      expect(tx.masterLesson.findMany).toHaveBeenCalledWith({
        where: {
          academicYearId: YEAR_ID,
          dayOfWeek: 4,
          isParked: false,
          id: { not: LESSON_ID },
        },
        select: expect.any(Object),
      });
      // Untouched fields are absent from the update payload.
      expect(tx.masterLesson.update).toHaveBeenCalledWith({
        where: { id: LESSON_ID },
        data: { dayOfWeek: 4 },
        select: expect.any(Object),
      });
    });

    it('rejects a patch whose merged time range is inverted', async () => {
      arrangeUpdate();

      await expect(
        // Existing end is 11:00; the new start of 12:00 inverts the range.
        service.update(LESSON_ID, { startTime: '12:00' }, testUser()),
      ).rejects.toThrow(new BadRequestException('startTime must be before endTime.'));
      expect(tx.masterLesson.update).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------
    // The tray. A parked lesson occupies nothing; a lesson put back is a
    // placement like any other.
    // -----------------------------------------------------------------

    it('parks a lesson without asking whether its old slot is free', async () => {
      // The whole point of the tray: A leaves slot X while B is still there.
      // A conflict scan here would refuse the very move that makes a swap
      // possible, so none is run — not "run and ignored", none.
      arrangeUpdate();
      sameDay([otherLesson({ teacherId: TEACHER_ID })]);

      await service.update(LESSON_ID, { isParked: true }, testUser());

      expect(tx.masterLesson.findMany).not.toHaveBeenCalled();
      expect(tx.masterLesson.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ isParked: true }) }),
      );
    });

    it('checks a lesson being put back like any other placement', async () => {
      // Un-parking names a day and a time, and that slot may since have been
      // taken — by the lesson it was lifted out to make room for.
      arrangeUpdate({ isParked: true });
      sameDay([otherLesson({ teacherId: TEACHER_ID })]);

      await expect(
        service.update(LESSON_ID, { isParked: false, dayOfWeek: 1 }, testUser()),
      ).rejects.toThrow(ConflictException);
      expect(tx.masterLesson.update).not.toHaveBeenCalled();
    });

    it("409s when the stored co-teacher clashes, without updating", async () => {
      arrangeUpdate({ coTeacherId: CO_TEACHER_ID });
      sameDay([
        otherLesson({ teacherId: CO_TEACHER_ID }),
      ]);

      await expect(
        service.update(LESSON_ID, { dayOfWeek: 1 }, testUser()),
      ).rejects.toThrow(ConflictException);
      expect(tx.masterLesson.update).not.toHaveBeenCalled();
      expect(realtime.notifyMasterTimetableChanged).not.toHaveBeenCalled();
    });

    it('clears the room with an explicit null', async () => {
      arrangeUpdate({}, { roomId: null });

      await service.update(LESSON_ID, { roomId: null }, testUser());

      expect(tx.masterLesson.update).toHaveBeenCalledWith({
        where: { id: LESSON_ID },
        data: { dayOfWeek: 1, roomId: null },
        select: expect.any(Object),
      });
    });

    it('locks the lesson in place when isLocked is patched', async () => {
      arrangeUpdate({}, { isLocked: true });

      await service.update(LESSON_ID, { isLocked: true }, testUser());

      expect(tx.masterLesson.update).toHaveBeenCalledWith({
        where: { id: LESSON_ID },
        data: { dayOfWeek: 1, isLocked: true },
        select: expect.any(Object),
      });
    });

    /*
     * The three below guard the seam between a generated lesson and the person
     * editing it. Regeneration keeps what the optimizer made and nobody has
     * touched; a generated lesson carries its requirement's window, so the
     * window alone cannot say who wrote it. Get this wrong in one direction and
     * an administrator's "kemi bara på våren" is deleted at the next
     * regeneration; get it wrong in the other and every nudge becomes an
     * invisible lock.
     */
    it.each([
      ['odd weeks', { recurrence: 'ODD_WEEKS' as const }, { recurrence: 'ODD_WEEKS' }],
      ['a period start', { startDate: '2027-01-11' }, { startDate: new Date('2027-01-11') }],
      ['a period end', { endDate: '2027-06-11' }, { endDate: new Date('2027-06-11') }],
    ])(
      'takes the lesson away from the machine when a human writes %s',
      async (_label, patch, written) => {
        arrangeUpdate({ isGenerated: true });

        await service.update(LESSON_ID, patch, testUser());

        expect(tx.masterLesson.update).toHaveBeenCalledWith({
          where: { id: LESSON_ID },
          data: { dayOfWeek: 1, ...written, isGenerated: false },
          select: expect.any(Object),
        });
      },
    );

    it('clears a window without leaving the lesson to be regenerated over', async () => {
      arrangeUpdate({ isGenerated: true, recurrence: 'ODD_WEEKS' });

      await service.update(LESSON_ID, { recurrence: 'ALL_WEEKS' }, testUser());

      // Writing ALL_WEEKS is still writing the window, so the handover stands.
      // The lesson stops alternating and stays the administrator's — the
      // alternative is that undoing an edit quietly re-arms the delete.
      expect(tx.masterLesson.update).toHaveBeenCalledWith({
        where: { id: LESSON_ID },
        data: { dayOfWeek: 1, recurrence: 'ALL_WEEKS', isGenerated: false },
        select: expect.any(Object),
      });
    });

    it('leaves ownership where it is when the patch only moves the lesson', async () => {
      arrangeUpdate({ isGenerated: true });

      await service.update(LESSON_ID, { dayOfWeek: 3 }, testUser());

      // A moved time is something the solver can express and simply decided
      // otherwise about, so pinning it stays the lock's job — visible on the
      // lesson, rather than a side effect of having touched it.
      const { data } = tx.masterLesson.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(data).not.toHaveProperty('isGenerated');
    });

    it('replaces the extra groups, dropping the primary group and scoping rows to the school', async () => {
      arrangeUpdate(
        {},
        { extraGroups: [{ studentGroupId: EXTRA_GROUP_ID }] },
      );

      await service.update(
        LESSON_ID,
        { extraGroupIds: [GROUP_ID, EXTRA_GROUP_ID] },
        testUser(),
      );

      expect(tx.masterLesson.update).toHaveBeenCalledWith({
        where: { id: LESSON_ID },
        data: {
          dayOfWeek: 1,
          extraGroups: {
            deleteMany: {},
            create: [{ schoolId: SCHOOL_ID, studentGroupId: EXTRA_GROUP_ID }],
          },
        },
        select: expect.any(Object),
      });
    });

    it('replaces the extra groups, deduplicated', async () => {
      // Same unique constraint as on create: a duplicate would fail the
      // nested create with the same 409, and only after deleteMany had run in
      // the same transaction.
      arrangeUpdate(
        {},
        { extraGroups: [{ studentGroupId: EXTRA_GROUP_ID }] },
      );

      await service.update(
        LESSON_ID,
        { extraGroupIds: [EXTRA_GROUP_ID, EXTRA_GROUP_ID] },
        testUser(),
      );

      expect(tx.masterLesson.update).toHaveBeenCalledWith({
        where: { id: LESSON_ID },
        data: {
          dayOfWeek: 1,
          extraGroups: {
            deleteMany: {},
            create: [{ schoolId: SCHOOL_ID, studentGroupId: EXTRA_GROUP_ID }],
          },
        },
        select: expect.any(Object),
      });
    });

    it('replaces the participants, deduplicated', async () => {
      arrangeUpdate({}, { participants: [{ studentId: STUDENT_ID }] });

      await service.update(
        LESSON_ID,
        { studentIds: [STUDENT_ID, STUDENT_ID] },
        testUser(),
      );

      expect(tx.masterLesson.update).toHaveBeenCalledWith({
        where: { id: LESSON_ID },
        data: {
          dayOfWeek: 1,
          participants: {
            deleteMany: {},
            create: [{ schoolId: SCHOOL_ID, studentId: STUDENT_ID }],
          },
        },
        select: expect.any(Object),
      });
    });

    // ISO weeks for the dates below: 2026-08-10 is week 33 (odd),
    // 2026-08-17 week 34 (even), 2026-08-24 week 35 (odd).
    it('drops the calendar lessons the narrowed recurrence no longer covers', async () => {
      arrangeUpdate({}, { recurrence: 'ODD_WEEKS' });
      tx.calendarLesson.findMany.mockResolvedValue([
        { id: CAL_LESSON_ID, date: new Date('2026-08-10T00:00:00.000Z') },
        { id: OTHER_CAL_LESSON_ID, date: new Date('2026-08-17T00:00:00.000Z') },
      ]);

      await expect(
        service.update(LESSON_ID, { recurrence: 'ODD_WEEKS' }, testUser()),
      ).resolves.toMatchObject({
        propagatedLessons: 1,
        removedCalendarLessons: 1,
      });

      // The odd week survives untouched; the even week is unreachable by any
      // later publish, so it is deleted rather than left behind.
      expect(tx.calendarLesson.update).toHaveBeenCalledTimes(1);
      expect(tx.calendarLesson.update).toHaveBeenCalledWith({
        where: { id: CAL_LESSON_ID },
        data: {
          date: new Date('2026-08-10T00:00:00.000Z'),
          startsAt: new Date('2026-08-10T08:00:00.000Z'),
          endsAt: new Date('2026-08-10T09:00:00.000Z'),
          roomId: ROOM_ID,
        },
      });
      expect(tx.calendarLesson.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: [OTHER_CAL_LESSON_ID] } },
      });
    });

    it('drops calendar lessons left outside a term end pulled forward', async () => {
      // The window itself is narrowed, without the slot moving at all:
      // 2026-08-10 stays inside, 2026-09-14 falls past the new end date.
      arrangeUpdate({}, { endDate: new Date('2026-09-07T00:00:00.000Z') });
      tx.calendarLesson.findMany.mockResolvedValue([
        { id: CAL_LESSON_ID, date: new Date('2026-08-10T00:00:00.000Z') },
        { id: OTHER_CAL_LESSON_ID, date: new Date('2026-09-14T00:00:00.000Z') },
      ]);

      await expect(
        service.update(LESSON_ID, { endDate: '2026-09-07' }, testUser()),
      ).resolves.toMatchObject({
        endDate: '2026-09-07',
        propagatedLessons: 1,
        removedCalendarLessons: 1,
      });

      // The DATE column holds midnight UTC, so the day is never shifted by a
      // timezone on the way in. `isGenerated` rides along because writing a
      // window hands the lesson to whoever wrote it.
      expect(tx.masterLesson.update).toHaveBeenCalledWith({
        where: { id: LESSON_ID },
        data: {
          dayOfWeek: 1,
          endDate: new Date('2026-09-07T00:00:00.000Z'),
          isGenerated: false,
        },
        select: expect.any(Object),
      });
      expect(tx.calendarLesson.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: [OTHER_CAL_LESSON_ID] } },
      });
    });

    it("drops calendar lessons a weekday move carries past the template's end date", async () => {
      // A half-term lesson, Mondays 2026-08-31 to 2026-09-16, moved to
      // Fridays: 08-31 lands on 09-04 and stays, 09-14 lands on 09-18 and
      // falls outside the template's own window.
      const startDate = new Date('2026-08-31T00:00:00.000Z');
      const endDate = new Date('2026-09-16T00:00:00.000Z');
      arrangeUpdate(
        { startDate, endDate },
        { dayOfWeek: 5, startDate, endDate },
      );
      tx.calendarLesson.findMany.mockResolvedValue([
        { id: CAL_LESSON_ID, date: new Date('2026-08-31T00:00:00.000Z') },
        { id: OTHER_CAL_LESSON_ID, date: new Date('2026-09-14T00:00:00.000Z') },
      ]);

      await expect(
        service.update(LESSON_ID, { dayOfWeek: 5 }, testUser()),
      ).resolves.toMatchObject({
        propagatedLessons: 1,
        removedCalendarLessons: 1,
      });

      expect(tx.calendarLesson.update).toHaveBeenCalledTimes(1);
      expect(tx.calendarLesson.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: CAL_LESSON_ID },
          data: expect.objectContaining({
            date: new Date('2026-09-04T00:00:00.000Z'),
          }),
        }),
      );
      expect(tx.calendarLesson.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: [OTHER_CAL_LESSON_ID] } },
      });
    });

    it('notifies the affected classes when the change only removed lessons', async () => {
      // 2026-08-17 is week 34, so an ODD_WEEKS lesson loses it and moves
      // nothing at all — the class still has to hear that it is gone.
      arrangeUpdate({}, { recurrence: 'ODD_WEEKS' });
      tx.calendarLesson.findMany.mockResolvedValue([
        { id: CAL_LESSON_ID, date: new Date('2026-08-17T00:00:00.000Z') },
      ]);
      tx.subject.findUnique.mockResolvedValue({ name: 'Mathematics' });
      notifications.recipientsForGroups.mockResolvedValue([STUDENT_ID]);

      await expect(
        service.update(LESSON_ID, { recurrence: 'ODD_WEEKS' }, testUser()),
      ).resolves.toMatchObject({
        propagatedLessons: 0,
        removedCalendarLessons: 1,
      });

      expect(tx.calendarLesson.update).not.toHaveBeenCalled();
      expect(notifications.notifyUsers).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          userIds: [STUDENT_ID],
          type: 'SCHEDULE_CHANGED',
        }),
      );
    });

    it('leaves the LEAD teacher of a dropped lesson alone', async () => {
      // The row is about to be deleted; rewriting its teacher first would be
      // work on a lesson that no longer exists.
      arrangeUpdate(
        {},
        { recurrence: 'ODD_WEEKS', teacherId: NEW_TEACHER_ID },
      );
      tx.calendarLesson.findMany.mockResolvedValue([
        { id: CAL_LESSON_ID, date: new Date('2026-08-17T00:00:00.000Z') },
      ]);

      await service.update(
        LESSON_ID,
        { recurrence: 'ODD_WEEKS', teacherId: NEW_TEACHER_ID },
        testUser(),
      );

      expect(tx.calendarLessonTeacher.deleteMany).not.toHaveBeenCalled();
      expect(tx.calendarLessonTeacher.create).not.toHaveBeenCalled();
    });

    it('skips propagation entirely when propagate is false', async () => {
      arrangeUpdate({}, { dayOfWeek: 5 });

      await expect(
        service.update(
          LESSON_ID,
          { dayOfWeek: 5, propagate: false },
          testUser(),
        ),
      ).resolves.toMatchObject({
        propagatedLessons: 0,
        removedCalendarLessons: 0,
      });
      expect(tx.calendarLesson.findMany).not.toHaveBeenCalled();
      expect(tx.calendarLesson.deleteMany).not.toHaveBeenCalled();
      expect(notifications.notifyUsers).not.toHaveBeenCalled();
    });

    it('re-assigns the LEAD teacher on propagated lessons when the teacher changes', async () => {
      arrangeUpdate({}, { teacherId: NEW_TEACHER_ID });
      tx.calendarLesson.findMany.mockResolvedValue([
        { id: CAL_LESSON_ID, date: new Date('2026-08-10T00:00:00.000Z') },
      ]);

      await service.update(
        LESSON_ID,
        { teacherId: NEW_TEACHER_ID },
        testUser(),
      );

      expect(tx.masterLesson.update).toHaveBeenCalledWith({
        where: { id: LESSON_ID },
        data: { dayOfWeek: 1, teacherId: NEW_TEACHER_ID },
        select: expect.any(Object),
      });
      expect(tx.calendarLessonTeacher.deleteMany).toHaveBeenCalledWith({
        where: { calendarLessonId: CAL_LESSON_ID, role: 'LEAD' },
      });
      expect(tx.calendarLessonTeacher.create).toHaveBeenCalledWith({
        data: {
          schoolId: SCHOOL_ID,
          calendarLessonId: CAL_LESSON_ID,
          teacherId: NEW_TEACHER_ID,
          role: 'LEAD',
        },
      });
    });

    it('removes the LEAD assignment when the teacher is cleared', async () => {
      arrangeUpdate({}, { teacherId: null });
      tx.calendarLesson.findMany.mockResolvedValue([
        { id: CAL_LESSON_ID, date: new Date('2026-08-10T00:00:00.000Z') },
      ]);

      await service.update(LESSON_ID, { teacherId: null }, testUser());

      expect(tx.calendarLessonTeacher.deleteMany).toHaveBeenCalledWith({
        where: { calendarLessonId: CAL_LESSON_ID, role: 'LEAD' },
      });
      expect(tx.calendarLessonTeacher.create).not.toHaveBeenCalled();
    });

    it('leaves lesson-teacher assignments alone when the teacher is unchanged', async () => {
      arrangeUpdate({}, { dayOfWeek: 2 });
      tx.calendarLesson.findMany.mockResolvedValue([
        { id: CAL_LESSON_ID, date: new Date('2026-08-10T00:00:00.000Z') },
      ]);

      await service.update(LESSON_ID, { dayOfWeek: 2 }, testUser());

      expect(tx.calendarLessonTeacher.deleteMany).not.toHaveBeenCalled();
      expect(tx.calendarLessonTeacher.create).not.toHaveBeenCalled();
    });

    it('notifies affected classes with the new slot once lessons actually moved', async () => {
      arrangeUpdate(
        { extraGroups: [{ studentGroupId: EXTRA_GROUP_ID }] },
        {
          dayOfWeek: 3,
          startTime: t('09:00'),
          endTime: t('10:30'),
          extraGroups: [{ studentGroupId: EXTRA_GROUP_ID }],
        },
      );
      tx.calendarLesson.findMany.mockResolvedValue([
        { id: CAL_LESSON_ID, date: new Date('2026-08-10T00:00:00.000Z') },
      ]);
      tx.subject.findUnique.mockResolvedValue({ name: 'Mathematics' });
      const recipients = [STUDENT_ID, '00000000-eeee-4eee-8eee-000000000001'];
      notifications.recipientsForGroups.mockResolvedValue(recipients);

      await service.update(
        LESSON_ID,
        { dayOfWeek: 3, startTime: '09:00', endTime: '10:30' },
        testUser(),
      );

      expect(notifications.recipientsForGroups).toHaveBeenCalledWith(tx, [
        GROUP_ID,
        EXTRA_GROUP_ID,
      ]);
      expect(tx.subject.findUnique).toHaveBeenCalledWith({
        where: { id: SUBJECT_ID },
        select: { name: true },
      });
      expect(notifications.notifyUsers).toHaveBeenCalledWith(tx, {
        schoolId: SCHOOL_ID,
        userIds: recipients,
        type: 'SCHEDULE_CHANGED',
        meta: {
          subjectName: 'Mathematics',
          dayOfWeek: 3,
          startTime: '09:00',
          endTime: '10:30',
        },
      });
    });

    // The notice announces the slot the lesson lands in, so it goes to the
    // classes that attend it afterwards. Read off the pre-update lesson, a
    // class added by this very update never heard about the moved lessons it
    // now attends — while the class it replaced was told about a slot that is
    // no longer its own.
    it('notifies the post-update group list, including a group added by the update', async () => {
      arrangeUpdate(
        { extraGroups: [{ studentGroupId: EXTRA_GROUP_ID }] },
        {
          dayOfWeek: 3,
          extraGroups: [{ studentGroupId: OTHER_EXTRA_GROUP_ID }],
        },
      );
      tx.calendarLesson.findMany.mockResolvedValue([
        { id: CAL_LESSON_ID, date: new Date('2026-08-10T00:00:00.000Z') },
      ]);
      tx.subject.findUnique.mockResolvedValue({ name: 'Mathematics' });

      await service.update(
        LESSON_ID,
        { dayOfWeek: 3, extraGroupIds: [OTHER_EXTRA_GROUP_ID] },
        testUser(),
      );

      expect(notifications.recipientsForGroups).toHaveBeenCalledWith(tx, [
        GROUP_ID,
        OTHER_EXTRA_GROUP_ID, // the attached group — not the one it replaced
      ]);
    });

    it('falls back to an empty subject name when the subject row is gone', async () => {
      arrangeUpdate({}, { dayOfWeek: 3 });
      tx.calendarLesson.findMany.mockResolvedValue([
        { id: CAL_LESSON_ID, date: new Date('2026-08-10T00:00:00.000Z') },
      ]);
      tx.subject.findUnique.mockResolvedValue(null);

      await service.update(LESSON_ID, { dayOfWeek: 3 }, testUser());

      expect(notifications.notifyUsers).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          meta: expect.objectContaining({ subjectName: '' }),
        }),
      );
    });

    it('stays silent when no calendar lesson actually moved', async () => {
      arrangeUpdate({}, { dayOfWeek: 3 });
      tx.calendarLesson.findMany.mockResolvedValue([]);

      await expect(
        service.update(LESSON_ID, { dayOfWeek: 3 }, testUser()),
      ).resolves.toMatchObject({
        propagatedLessons: 0,
        removedCalendarLessons: 0,
      });
      expect(notifications.notifyUsers).not.toHaveBeenCalled();
      expect(notifications.recipientsForGroups).not.toHaveBeenCalled();
    });

    it('moves both ends of the slot when both are patched', async () => {
      arrangeUpdate({}, { startTime: t('12:00'), endTime: t('13:00') });

      await expect(
        service.update(LESSON_ID, { startTime: '12:00', endTime: '13:00' }, testUser()),
      ).resolves.toMatchObject({ startTime: '12:00', endTime: '13:00' });

      expect(tx.masterLesson.update).toHaveBeenCalledWith({
        where: { id: LESSON_ID },
        data: { dayOfWeek: 1, startTime: t('12:00'), endTime: t('13:00') },
        select: expect.any(Object),
      });
    });

    it('rejects a patch that leaves the lesson no time at all', async () => {
      arrangeUpdate();

      await expect(
        // Existing end is 11:00; a start of 11:00 leaves nothing between them.
        service.update(LESSON_ID, { startTime: '11:00' }, testUser()),
      ).rejects.toThrow(new BadRequestException('startTime must be before endTime.'));
      expect(tx.masterLesson.update).not.toHaveBeenCalled();
    });

    it('folds every clash a patch makes into one 409 message', async () => {
      arrangeUpdate();
      sameDay([otherLesson({ teacherId: TEACHER_ID, roomId: ROOM_ID })]);

      await expect(service.update(LESSON_ID, { dayOfWeek: 1 }, testUser())).rejects.toThrow(
        new ConflictException(
          'Teacher already teaches Math in this slot. ' +
            'Room is already booked for Math in this slot.',
        ),
      );
    });

    /*
     * The clash scan checks the lesson as it will be, which is the patch laid
     * over the stored row: what the patch names, and what it leaves alone. Each
     * pair below differs in which of the two a busy resource sits in.
     */
    it.each([
      ['the teacher', { teacherId: NEW_TEACHER_ID }, NEW_TEACHER_ID],
      ['the co-teacher', { coTeacherId: CO_TEACHER_ID }, CO_TEACHER_ID],
    ])('checks %s a patch assigns, not the one it replaces', async (_label, patch, busy) => {
      arrangeUpdate();
      sameDay([otherLesson({ teacherId: busy })]);

      await expect(service.update(LESSON_ID, patch, testUser())).rejects.toThrow(
        new ConflictException('Teacher already teaches Math in this slot.'),
      );
      expect(tx.masterLesson.update).not.toHaveBeenCalled();
    });

    it.each([
      ['a room the patch names', { roomId: NEW_ROOM_ID }, NEW_ROOM_ID],
      ['the room a lesson already has', { dayOfWeek: 1 }, ROOM_ID],
    ])('checks %s', async (_label, patch, bookedRoom) => {
      arrangeUpdate();
      sameDay([otherLesson({ roomId: bookedRoom })]);

      await expect(service.update(LESSON_ID, patch, testUser())).rejects.toThrow(
        new ConflictException('Room is already booked for Math in this slot.'),
      );
    });

    it('checks the extra groups a lesson already brings along', async () => {
      arrangeUpdate({ extraGroups: [{ studentGroupId: EXTRA_GROUP_ID }] });
      sameDay([otherLesson({ studentGroupId: EXTRA_GROUP_ID })]);

      await expect(service.update(LESSON_ID, { dayOfWeek: 1 }, testUser())).rejects.toThrow(
        new ConflictException('The group already has Math in this slot.'),
      );
    });

    it.each([
      ['odd weeks', { recurrence: 'ODD_WEEKS' }, { recurrence: 'EVEN_WEEKS' }],
      ['its spring term', { startDate: day('2027-01-11') }, { endDate: day('2026-12-18') }],
      ['its autumn term', { endDate: day('2026-12-18') }, { startDate: day('2027-01-11') }],
    ])('goes on checking a moved lesson by %s', async (_label, stored, otherWindow) => {
      // A patch that does not name the weeks keeps the ones the lesson had —
      // in the clash scan, not only in the row.
      arrangeUpdate(stored);
      sameDay([otherLesson({ teacherId: TEACHER_ID, ...otherWindow })]);

      await expect(
        service.update(LESSON_ID, { dayOfWeek: 1 }, testUser()),
      ).resolves.toMatchObject({ id: LESSON_ID });
    });

    it.each([
      ['a spring term', { startDate: '2027-01-11' }, { endDate: day('2026-12-18') }],
      ['an autumn term', { endDate: '2026-12-18' }, { startDate: day('2027-01-11') }],
    ])('checks the lesson by the %s a patch gives it', async (_label, patch, otherWindow) => {
      arrangeUpdate();
      sameDay([otherLesson({ teacherId: TEACHER_ID, ...otherWindow })]);

      await expect(service.update(LESSON_ID, patch, testUser())).resolves.toMatchObject({
        id: LESSON_ID,
      });
    });

    it.each([
      ['an explicit null', null],
      ['an empty string', ''],
    ])('clears a period start given as %s', async (_label, startDate) => {
      arrangeUpdate({ startDate: day('2027-01-11') });

      await service.update(LESSON_ID, { startDate }, testUser());

      expect(tx.masterLesson.update).toHaveBeenCalledWith({
        where: { id: LESSON_ID },
        data: { dayOfWeek: 1, startDate: null, isGenerated: false },
        select: expect.any(Object),
      });
    });

    it('keeps only the calendar day of a date sent as a full timestamp', async () => {
      arrangeUpdate();

      await service.update(LESSON_ID, { endDate: '2026-09-07T00:00:00.000Z' }, testUser());

      expect(tx.masterLesson.update).toHaveBeenCalledWith({
        where: { id: LESSON_ID },
        data: { dayOfWeek: 1, endDate: day('2026-09-07'), isGenerated: false },
        select: expect.any(Object),
      });
    });

    it('writes an UPDATE entry with before/after snapshots', async () => {
      arrangeUpdate({}, { dayOfWeek: 3 });

      await service.update(LESSON_ID, { dayOfWeek: 3 }, testUser());

      expect(tx.scheduleChangeLog.create).toHaveBeenCalledWith({
        data: {
          schoolId: SCHOOL_ID,
          academicYearId: YEAR_ID,
          masterLessonId: LESSON_ID,
          actorId: USER_ID,
          action: 'UPDATE',
          before: expect.objectContaining({ dayOfWeek: 1, startTime: '10:00' }),
          after: expect.objectContaining({ dayOfWeek: 3 }),
        },
      });
    });
    it('changes the co-teacher, and clears it when asked', async () => {
      // The field reached the DTO but not the write, so a PATCH naming it was
      // accepted and did nothing — the quietest kind of failure.
      arrangeUpdate({ coTeacherId: CO_TEACHER_ID });

      await service.update(LESSON_ID, { coTeacherId: null }, testUser());

      // toMatchObject, not toEqual: `dayOfWeek` is written unconditionally on
      // this path (it falls back to the stored value), which the neighbouring
      // "untouched fields" test already pins.
      expect(tx.masterLesson.update.mock.calls[0][0].data).toMatchObject({
        coTeacherId: null,
      });
    });

    it('leaves the stored co-teacher alone when the payload omits it', async () => {
      arrangeUpdate({ coTeacherId: CO_TEACHER_ID });

      await service.update(LESSON_ID, { dayOfWeek: 4 }, testUser());

      expect('coTeacherId' in tx.masterLesson.update.mock.calls[0][0].data).toBe(false);
    });

  });

  // -------------------------------------------------------------------
  // remove
  // -------------------------------------------------------------------

  describe('remove', () => {
    const arrangeRemove = () => {
      tx.masterLesson.findUnique.mockImplementation(
        answerUnique([{ ...lessonRecord(), schoolId: SCHOOL_ID }]),
      );
      tx.calendarLesson.deleteMany.mockResolvedValue({ count: 3 });
    };

    it('404s on an unknown lesson and deletes nothing', async () => {
      tx.masterLesson.findUnique.mockResolvedValue(null);

      await expect(service.remove(LESSON_ID, testUser())).rejects.toThrow(
        new NotFoundException('Master lesson not found.'),
      );
      expect(tx.calendarLesson.deleteMany).not.toHaveBeenCalled();
      expect(tx.masterLesson.delete).not.toHaveBeenCalled();
    });

    it('removes only future, attendance-free SCHEDULED calendar lessons with the template', async () => {
      arrangeRemove();
      const user = testUser();

      await expect(service.remove(LESSON_ID, user)).resolves.toEqual({
        id: LESSON_ID,
        removedCalendarLessons: 3,
      });

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.calendarLesson.deleteMany).toHaveBeenCalledWith({
        where: {
          masterLessonId: LESSON_ID,
          status: 'SCHEDULED',
          date: { gte: TODAY },
          attendanceRecords: { none: {} },
        },
      });
      expect(tx.masterLesson.delete).toHaveBeenCalledWith({
        where: { id: LESSON_ID },
      });
    });

    it('writes a DELETE audit entry and broadcasts to the school', async () => {
      arrangeRemove();

      await service.remove(LESSON_ID, testUser());

      expect(tx.scheduleChangeLog.create).toHaveBeenCalledWith({
        data: {
          schoolId: SCHOOL_ID,
          academicYearId: YEAR_ID,
          masterLessonId: LESSON_ID,
          actorId: USER_ID,
          action: 'DELETE',
          before: expect.objectContaining({
            id: LESSON_ID,
            startTime: '10:00',
            endTime: '11:00',
          }),
          after: undefined,
        },
      });
      expect(realtime.notifyMasterTimetableChanged).toHaveBeenCalledWith(
        SCHOOL_ID,
      );
    });
  });
});
