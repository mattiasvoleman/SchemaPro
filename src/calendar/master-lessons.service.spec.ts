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
import { recordedReads } from '../../test/utils/recorded-reads';
import type { PrismaService } from '../database/prisma.service';
import type { RealtimeService } from '../realtime/realtime.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { CreateMasterLessonDto } from './dto/create-master-lesson.dto';
import type { UpdateMasterLessonDto } from './dto/update-master-lesson.dto';
import { MasterLessonsService, teacherDayWarning } from './master-lessons.service';

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
        if (operator === 'notIn') {
          return !(operand as unknown[]).some((candidate) => same(value, candidate));
        }
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
  let notifications: { recipientsForLessons: jest.Mock; notifyUsers: jest.Mock };

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    realtime = { notifyMasterTimetableChanged: jest.fn() };
    notifications = {
      recipientsForLessons: jest.fn().mockResolvedValue([]),
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

  /**
   * The timplanspost behind a lesson and the rest of its week, as
   * distributionWarnings reads them: the post, its subject's default and both
   * names in ONE joined raw read keyed on the post's own (läsår, class,
   * subject), and the post's lessons by the same key — told apart from the
   * clash scan's read of the candidate's DAY, which `sameDay` keeps answering.
   * Every other raw statement (the publication mode's) answers as the mock's
   * default does: no row.
   */
  /** Whether a $queryRaw call is distributionWarnings' read of the post. A
   *  tagged template arrives as its strings; publish-mode's Prisma.sql does not. */
  const isPostRead = (first: unknown): boolean =>
    Array.isArray(first) && first.join('?').includes('FROM "TeachingRequirements" r');

  const arrangeDistribution = (
    post: {
      subject: { maxLessonsPerDay?: number | null; minDaysBetween?: number | null };
      ownDistribution?: boolean;
      maxLessonsPerDay?: number | null;
      minDaysBetween?: number | null;
    } | null,
    week: Row[],
  ) => {
    const postRaw = jest.fn((strings: unknown, ...values: unknown[]) => {
      if (!isPostRead(strings)) return Promise.resolve([]);
      const keyed =
        values[0] === YEAR_ID && values[1] === GROUP_ID && values[2] === SUBJECT_ID;
      return Promise.resolve(
        post === null || !keyed
          ? []
          : [
              {
                ownDistribution: post.ownDistribution ?? false,
                maxLessonsPerDay: post.maxLessonsPerDay ?? null,
                minDaysBetween: post.minDaysBetween ?? null,
                subjectMaxLessonsPerDay: post.subject.maxLessonsPerDay ?? null,
                subjectMinDaysBetween: post.subject.minDaysBetween ?? null,
                subjectName: 'Idrott',
                groupName: '7A',
              },
            ],
      );
    });
    Object.assign(tx, { $queryRaw: postRaw });
    const clashScan = tx.masterLesson.findMany.getMockImplementation()!;
    tx.masterLesson.findMany.mockImplementation((query: Query = {}) =>
      query.where && 'subjectId' in query.where
        ? answerRows(
            week.map((lesson) => ({
              academicYearId: YEAR_ID,
              studentGroupId: GROUP_ID,
              subjectId: SUBJECT_ID,
              isParked: false,
              recurrence: 'ALL_WEEKS',
              startDate: null,
              endDate: null,
              ...lesson,
            })),
          )(query)
        : clashScan(query),
    );
    return postRaw;
  };

  /**
   * Lärarens dag as teacherDayWarnings reads it: the teachers' caps, the day
   * limits of their posts, and every lesson of the year they are on — told
   * apart from the clash scan of the candidate's DAY and the ämnesfördelning's
   * week of one post by its OR over the two teacher columns, and answered as
   * that OR asks. Every other masterLesson.findMany answers as before. Rows
   * carry `isParked`, so a parked one comes back only to a read that forgot to
   * leave it out. And what the edited lessons are called, in the one raw
   * statement that asks it (by the lessons' ids) — LESSON_ID is Idrott för 7A,
   * as the ämnesfördelning's post calls it; every other raw statement
   * answers as it did before.
   */
  const arrangeTeacherDay = ({
    caps = [],
    limits = [],
    week = [],
    names = [{ id: LESSON_ID, subjectName: 'Idrott', groupName: '7A' }],
  }: {
    caps?: Array<{ userId: string; maxTeachingMinutesPerDay: number }>;
    limits?: Array<{ userId: string; maxTeachingDaysPerWeek: number }>;
    week?: Row[];
    names?: Array<{ id: string; subjectName: string; groupName: string }>;
  }) => {
    const otherRaw = tx.$queryRaw;
    Object.assign(tx, {
      $queryRaw: jest.fn((strings: unknown, ...values: unknown[]) =>
        isNameRead(strings)
          ? Promise.resolve(names.filter((row) => (values[0] as string[]).includes(row.id)))
          : otherRaw(strings, ...values),
      ),
    });
    tx.teacherWorkRule.findMany.mockImplementation(answerRows(caps));
    tx.teacherEmployment.findMany.mockImplementation(
      answerRows(limits.map((limit) => ({ academicYearId: YEAR_ID, ...limit }))),
    );
    const otherReads = tx.masterLesson.findMany.getMockImplementation()!;
    tx.masterLesson.findMany.mockImplementation((query: Query = {}) => {
      if (!query.where || !('OR' in query.where)) return otherReads(query);
      const [lead, co] = query.where.OR as [{ teacherId: { in: string[] } }, { coTeacherId: { in: string[] } }];
      const rest = Object.fromEntries(Object.entries(query.where).filter(([column]) => column !== 'OR'));
      return answerRows(
        week.filter(
          (row) => lead.teacherId.in.includes(row.teacherId) || co.coTeacherId.in.includes(row.coTeacherId),
        ),
      )({ ...query, where: rest });
    });
  };

  /** A lesson of a teacher's week: TEACHER_ID's, every week, placed. */
  const taught = (id: string, dayOfWeek: number, start: string, end: string, extra: Row = {}): Row => ({
    id,
    academicYearId: YEAR_ID,
    teacherId: TEACHER_ID,
    coTeacherId: null,
    dayOfWeek,
    startTime: t(start),
    endTime: t(end),
    recurrence: 'ALL_WEEKS',
    startDate: null,
    endDate: null,
    isParked: false,
    ...extra,
  });

  /** The teacher-day reads that went out, by their own where. */
  const weekReads = () =>
    (tx.masterLesson.findMany.mock.calls as Array<[Query]>).filter(([query]) => query.where && 'OR' in query.where);

  /** Whether a $queryRaw call is teacherDayWarnings' read of the lessons' names. */
  const isNameRead = (first: unknown): boolean =>
    Array.isArray(first) && first.join('?').includes('FROM "MasterLessons" m');
  /** The lesson ids each read of the names asked about. */
  const nameReads = () =>
    (tx.$queryRaw.mock.calls as Array<[unknown, ...unknown[]]>)
      .filter(([strings]) => isNameRead(strings))
      .map(([, ids]) => ids);

  /** A schemaläggare without HR-läs: reads the timetable, not the post's figures. */
  const scheduler = () => testUser({ adminProfile: 'SCHEMALAGGARE', hrRead: false, channel: 'WEB' });

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
        // No timplanspost with an ämnesfördelning, so nothing to warn about.
        warnings: [],
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
          // An uppdrag's slot blocks only its own läsår, through its link.
          AND: [
            {
              OR: [
                { teacherDutySlot: { is: null } },
                { teacherDutySlot: { is: { teacherDuty: { is: { academicYearId: YEAR_ID } } } } },
              ],
            },
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

    describe('ämnesfördelning', () => {
      const MONDAY_AFTERNOON = { id: OTHER_LESSON_ID, dayOfWeek: 1 };

      it('saves a second idrott on a Monday under one a day, and warns', async () => {
        // A warning, never a 409: the school placing two on one Monday by hand
        // has decided to, and the generator keeps the rule for what it places.
        arrangeCreate();
        arrangeDistribution({ subject: { maxLessonsPerDay: 1 } }, [
          MONDAY_AFTERNOON,
          { id: LESSON_ID, dayOfWeek: 1 },
        ]);

        const created = await service.create(createDto(), testUser());

        expect(tx.masterLesson.create).toHaveBeenCalled();
        expect(created.warnings).toEqual([
          {
            code: 'DISTRIBUTION_TOO_MANY_ON_DAY',
            params: { requirement: 'Idrott för 7A', day: 1, count: 2, maxPerDay: 1 },
          },
        ]);
      });

      it('warns about consecutive days with the two weekdays named', async () => {
        arrangeCreate();
        arrangeDistribution({ subject: { minDaysBetween: 2 } }, [
          { id: OTHER_LESSON_ID, dayOfWeek: 2 },
          { id: LESSON_ID, dayOfWeek: 1 },
        ]);

        const created = await service.create(createDto(), testUser());

        expect(created.warnings).toEqual([
          {
            code: 'DISTRIBUTION_DAYS_TOO_CLOSE',
            params: { requirement: 'Idrott för 7A', firstDay: 1, secondDay: 2, minDaysBetween: 2 },
          },
        ]);
      });

      it('reads the post and the week by the post’s own key, parked lessons left out', async () => {
        arrangeCreate();
        const postRead = arrangeDistribution({ subject: { maxLessonsPerDay: 1 } }, [
          { id: LESSON_ID, dayOfWeek: 1 },
        ]);

        await service.create(createDto(), testUser());

        const reads = postRead.mock.calls.filter(([strings]) => isPostRead(strings));
        expect(reads).toHaveLength(1);
        expect(reads[0]!.slice(1)).toEqual([YEAR_ID, GROUP_ID, SUBJECT_ID]);
        expect(tx.masterLesson.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              academicYearId: YEAR_ID,
              studentGroupId: GROUP_ID,
              subjectId: SUBJECT_ID,
              isParked: false,
            },
          }),
        );
      });

      it('says nothing about a breach the new lesson is no part of', async () => {
        // Two the school already put on Tuesday; the new one is on Monday. The
        // Tuesday is the subject dialog's to list, not this save's.
        arrangeCreate();
        arrangeDistribution({ subject: { maxLessonsPerDay: 1 } }, [
          { id: 'tue-1', dayOfWeek: 2 },
          { id: 'tue-2', dayOfWeek: 2 },
          { id: LESSON_ID, dayOfWeek: 1 },
        ]);

        await expect(service.create(createDto(), testUser())).resolves.toMatchObject({
          warnings: [],
        });
      });

      it('holds the post to its own rule rather than its subject’s', async () => {
        arrangeCreate();
        arrangeDistribution(
          { subject: { maxLessonsPerDay: 1 }, ownDistribution: true, maxLessonsPerDay: 2 },
          [MONDAY_AFTERNOON, { id: LESSON_ID, dayOfWeek: 1 }],
        );

        await expect(service.create(createDto(), testUser())).resolves.toMatchObject({
          warnings: [],
        });
      });

      it('reads no week at all for a post without a rule', async () => {
        arrangeCreate();
        arrangeDistribution({ subject: {} }, [MONDAY_AFTERNOON, { id: LESSON_ID, dayOfWeek: 1 }]);

        await expect(service.create(createDto(), testUser())).resolves.toMatchObject({
          warnings: [],
        });
        expect(tx.masterLesson.findMany).not.toHaveBeenCalledWith(
          expect.objectContaining({ where: expect.objectContaining({ subjectId: SUBJECT_ID }) }),
        );
      });
    });

    describe('Lärarens dag', () => {
      /** The year's read, counting a day limit on the new lesson's teachers' posts as `days`. */
      const arrangeYear = (days: number | undefined) =>
        tx.academicYear.findUnique.mockImplementation(
          answerUnique([
            {
              id: YEAR_ID,
              schoolId: SCHOOL_ID,
              ...(days === undefined ? {} : { _count: { teacherEmployments: days } }),
            },
          ]),
        );

      it('a lesson created onto a teacher’s full Monday saves and warns, after the ämnesfördelning', async () => {
        arrangeCreate();
        arrangeDistribution({ subject: { maxLessonsPerDay: 1 } }, [
          { id: OTHER_LESSON_ID, dayOfWeek: 1 },
          { id: LESSON_ID, dayOfWeek: 1 },
        ]);
        arrangeTeacherDay({
          caps: [{ userId: TEACHER_ID, maxTeachingMinutesPerDay: 90 }],
          week: [taught(OTHER_LESSON_ID, 1, '08:00', '09:00'), taught(LESSON_ID, 1, '10:00', '11:00')],
        });

        const created = await service.create(createDto(), testUser());

        expect(tx.masterLesson.create).toHaveBeenCalled();
        expect(created.warnings).toEqual([
          {
            code: 'DISTRIBUTION_TOO_MANY_ON_DAY',
            params: { requirement: 'Idrott för 7A', day: 1, count: 2, maxPerDay: 1 },
          },
          {
            code: 'TEACHER_DAY_TOO_LONG',
            params: { role: 'LEAD', requirement: 'Idrott för 7A', day: 1, minutes: 120, cap: 90 },
          },
        ]);
        // The create's reads select no name, so the warning asks the new
        // lesson's, once.
        expect(nameReads()).toEqual([[LESSON_ID]]);
        // A create has no read its caps could be counted in: the teacher's own
        // is the gate. The day limits are counted in the year's read, and
        // this year's posts hold none, so no post is read.
        expect(tx.teacherWorkRule.findMany).toHaveBeenCalledWith({
          where: { userId: { in: [TEACHER_ID] }, maxTeachingMinutesPerDay: { not: null } },
          select: { userId: true, maxTeachingMinutesPerDay: true },
        });
        expect(tx.teacherEmployment.findMany).not.toHaveBeenCalled();
        expect(tx.academicYear.findUnique).toHaveBeenCalledWith(
          expect.objectContaining({
            select: expect.objectContaining({
              _count: {
                select: {
                  teacherEmployments: {
                    where: { userId: { in: [TEACHER_ID] }, maxTeachingDaysPerWeek: { not: null } },
                  },
                },
              },
            }),
          }),
        );
        expect(recordedReads(tx)).toEqual([]);
      });

      it('names the medlärare too, and counts their posts as well', async () => {
        arrangeCreate();
        tx.masterLesson.create.mockResolvedValue(lessonRecord({ teacherId: null, coTeacherId: CO_TEACHER_ID }));
        arrangeTeacherDay({
          caps: [{ userId: CO_TEACHER_ID, maxTeachingMinutesPerDay: 60 }],
          week: [
            taught(OTHER_LESSON_ID, 1, '08:00', '09:00', { teacherId: CO_TEACHER_ID }),
            taught(LESSON_ID, 1, '10:00', '11:00', { teacherId: null, coTeacherId: CO_TEACHER_ID }),
          ],
        });

        const created = await service.create(createDto({ teacherId: null, coTeacherId: CO_TEACHER_ID }), testUser());

        expect(created.warnings).toEqual([
          {
            code: 'TEACHER_DAY_TOO_LONG',
            params: { role: 'CO_TEACHER', requirement: 'Idrott för 7A', day: 1, minutes: 120, cap: 60 },
          },
        ]);
        expect(tx.academicYear.findUnique).toHaveBeenCalledWith(
          expect.objectContaining({
            select: expect.objectContaining({
              _count: {
                select: {
                  teacherEmployments: {
                    where: { userId: { in: [CO_TEACHER_ID] }, maxTeachingDaysPerWeek: { not: null } },
                  },
                },
              },
            }),
          }),
        );
      });

      it('a lesson created without a teacher asks nothing about a teacher’s day', async () => {
        arrangeCreate();
        arrangeTeacherDay({ caps: [{ userId: TEACHER_ID, maxTeachingMinutesPerDay: 30 }] });

        await expect(
          service.create(createDto({ teacherId: null }), testUser()),
        ).resolves.toMatchObject({ warnings: [] });
        expect(tx.teacherWorkRule.findMany).not.toHaveBeenCalled();
        expect(tx.teacherEmployment.findMany).not.toHaveBeenCalled();
        expect(weekReads()).toHaveLength(0);
      });

      it('a teacher without a cap or a day limit is read once and no week is', async () => {
        arrangeCreate();
        arrangeTeacherDay({ week: [taught(LESSON_ID, 1, '07:00', '19:00')] });

        await expect(service.create(createDto(), testUser())).resolves.toMatchObject({ warnings: [] });
        expect(tx.teacherWorkRule.findMany).toHaveBeenCalledTimes(1);
        expect(weekReads()).toHaveLength(0);
        expect(nameReads()).toEqual([]);
      });

      it('a teacher with a cap the new lesson keeps: the week is read, and no name, since no warning names one', async () => {
        arrangeCreate();
        arrangeTeacherDay({
          caps: [{ userId: TEACHER_ID, maxTeachingMinutesPerDay: 120 }],
          week: [taught(OTHER_LESSON_ID, 1, '08:00', '09:00'), taught(LESSON_ID, 1, '10:00', '11:00')],
        });

        await expect(service.create(createDto(), testUser())).resolves.toMatchObject({ warnings: [] });
        expect(weekReads()).toHaveLength(1);
        expect(nameReads()).toEqual([]);
      });

      it('a lesson whose names the reader is not shown is still warned about, under no name', async () => {
        arrangeCreate();
        arrangeTeacherDay({
          caps: [{ userId: TEACHER_ID, maxTeachingMinutesPerDay: 90 }],
          week: [taught(OTHER_LESSON_ID, 1, '08:00', '09:00'), taught(LESSON_ID, 1, '10:00', '11:00')],
          names: [],
        });

        const created = await service.create(createDto(), testUser());

        expect(created.warnings).toEqual([
          { code: 'TEACHER_DAY_TOO_LONG', params: { role: 'LEAD', requirement: '', day: 1, minutes: 120, cap: 90 } },
        ]);
      });

      it('a day limit on the post of the lesson’s year: the post is read, and the reader with HR-läs gets the figures', async () => {
        arrangeCreate();
        arrangeYear(1);
        arrangeTeacherDay({
          limits: [{ userId: TEACHER_ID, maxTeachingDaysPerWeek: 1 }],
          week: [taught(OTHER_LESSON_ID, 2, '08:00', '09:00'), taught(LESSON_ID, 1, '10:00', '11:00')],
        });

        const created = await service.create(createDto(), testUser({ channel: 'WEB' }));

        expect(created.warnings).toEqual([
          {
            code: 'TEACHER_WEEK_TOO_MANY_DAYS',
            params: { role: 'LEAD', requirement: 'Idrott för 7A', days: 2, max: 1 },
          },
        ]);
        expect(tx.teacherEmployment.findMany).toHaveBeenCalledWith({
          where: { academicYearId: YEAR_ID, userId: { in: [TEACHER_ID] }, maxTeachingDaysPerWeek: { not: null } },
          select: { userId: true, maxTeachingDaysPerWeek: true },
        });
        expect(recordedReads(tx)).toEqual([{ kind: 'EMPLOYMENT', channel: 'WEB', ids: [TEACHER_ID] }]);
      });

      it('a year whose posts hold no limit for them reads no post', async () => {
        arrangeCreate();
        arrangeYear(0);
        arrangeTeacherDay({ limits: [{ userId: TEACHER_ID, maxTeachingDaysPerWeek: 1 }] });

        await service.create(createDto(), testUser());

        expect(tx.teacherEmployment.findMany).not.toHaveBeenCalled();
      });
    });

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
    /**
     * LESSON_SELECT + the school join the update path selects, with its
     * count of the lesson's year when R1 or R2 settles it: 1, the active year.
     */
    const storedLesson = (overrides: Record<string, unknown> = {}) => ({
      ...lessonRecord(),
      school: { id: SCHOOL_ID, timezone: 'Europe/Stockholm', _count: { academicYears: 1 } },
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
        // Nobody new on the lesson, so nothing for the staffing policy to say.
        warnings: [],
      });

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      // Only still-SCHEDULED, attendance-free lessons not yet begun are touched.
      expect(tx.calendarLesson.findMany).toHaveBeenCalledWith({
        where: {
          masterLessonId: LESSON_ID,
          status: 'SCHEDULED',
          startsAt: { gt: NOW },
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

    it('never moves a row into the past: a Thursday lesson moved to Monday on a Thursday drops this week’s row', async () => {
      // Thursday 2026-08-06 09:00 in Stockholm. This week's row is today's
      // 10:00, not begun, so it is reconcilable — and the shift of −3 days
      // would land it on Monday the 3rd, a day already lived, as a SCHEDULED
      // lesson with its teacher that nobody held. It is removed instead;
      // next week's row moves as before.
      jest.setSystemTime(new Date('2026-08-06T07:00:00.000Z'));
      arrangeUpdate({ dayOfWeek: 4 }, { dayOfWeek: 1 });
      tx.calendarLesson.findMany.mockResolvedValue([
        { id: CAL_LESSON_ID, date: new Date('2026-08-06T00:00:00.000Z') },
        { id: OTHER_CAL_LESSON_ID, date: new Date('2026-08-13T00:00:00.000Z') },
      ]);

      await expect(
        service.update(LESSON_ID, { dayOfWeek: 1 }, testUser()),
      ).resolves.toMatchObject({
        dayOfWeek: 1,
        propagatedLessons: 1,
        removedCalendarLessons: 1,
      });

      expect(tx.calendarLesson.update).toHaveBeenCalledTimes(1);
      expect(tx.calendarLesson.update).toHaveBeenCalledWith({
        where: { id: OTHER_CAL_LESSON_ID },
        data: {
          date: new Date('2026-08-10T00:00:00.000Z'),
          startsAt: new Date('2026-08-10T08:00:00.000Z'),
          endsAt: new Date('2026-08-10T09:00:00.000Z'),
          roomId: ROOM_ID,
        },
      });
      expect(tx.calendarLesson.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: [CAL_LESSON_ID] } },
      });
    });

    it('never moves a row into the past within the day: a 13:00 lesson moved to 08:00 at ten drops today’s row', async () => {
      // Thursday 2026-08-06 10:00 in Stockholm. Today's 13:00 row has not
      // begun, so it is reconcilable; moved to 08:00 it would stand on the
      // same date — a day check lets it through — but end at 09:00, an hour
      // before now, SCHEDULED with its teacher: held by nobody, counted as
      // genomförd by the timplan. It is removed; next week's row moves.
      jest.setSystemTime(new Date('2026-08-06T08:00:00.000Z'));
      arrangeUpdate(
        { dayOfWeek: 4, startTime: t('13:00'), endTime: t('14:00') },
        { dayOfWeek: 4, startTime: t('08:00'), endTime: t('09:00') },
      );
      tx.calendarLesson.findMany.mockResolvedValue([
        { id: CAL_LESSON_ID, date: new Date('2026-08-06T00:00:00.000Z') },
        { id: OTHER_CAL_LESSON_ID, date: new Date('2026-08-13T00:00:00.000Z') },
      ]);

      await expect(
        service.update(LESSON_ID, { startTime: '08:00', endTime: '09:00' }, testUser()),
      ).resolves.toMatchObject({
        propagatedLessons: 1,
        removedCalendarLessons: 1,
      });

      expect(tx.calendarLesson.update).toHaveBeenCalledTimes(1);
      expect(tx.calendarLesson.update).toHaveBeenCalledWith({
        where: { id: OTHER_CAL_LESSON_ID },
        data: {
          date: new Date('2026-08-13T00:00:00.000Z'),
          startsAt: new Date('2026-08-13T06:00:00.000Z'),
          endsAt: new Date('2026-08-13T07:00:00.000Z'),
          roomId: ROOM_ID,
        },
      });
      expect(tx.calendarLesson.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: [CAL_LESSON_ID] } },
      });
    });

    it('asks for the rows by the instant they begin, so a lesson held this morning or the school’s yesterday is never reached', async () => {
      // 00:30 on Friday 2026-08-07 in Stockholm is still Thursday in UTC. A
      // day-grained read asked from Thursday the 6th and returned Thursday's
      // held lessons; a read by the instant asks for lessons beginning after
      // now, whatever the clock's day.
      jest.setSystemTime(new Date('2026-08-06T22:30:00.000Z'));
      arrangeUpdate({ dayOfWeek: 4 }, { dayOfWeek: 5 });
      tx.calendarLesson.findMany.mockResolvedValue([]);

      await service.update(LESSON_ID, { dayOfWeek: 5 }, testUser());

      expect(tx.calendarLesson.findMany).toHaveBeenCalledWith({
        where: {
          masterLessonId: LESSON_ID,
          status: 'SCHEDULED',
          startsAt: { gt: new Date('2026-08-06T22:30:00.000Z') },
          attendanceRecords: { none: {} },
        },
        select: { id: true, date: true },
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
      notifications.recipientsForLessons.mockResolvedValue([STUDENT_ID]);

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
      (tx as unknown as { $executeRaw: jest.Mock }).$executeRaw = jest.fn().mockResolvedValue(1);
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
      // The new LEAD, unless the lesson has a vikarie or the new teacher is
      // already on it (staffing Fas 3, C5b): one guarded INSERT.
      const insert = (tx as unknown as { $executeRaw: jest.Mock }).$executeRaw.mock.calls[0]!;
      const sql = (insert[0] as readonly string[]).join('?');
      expect(sql).toContain('INSERT INTO "CalendarLessonTeachers"');
      expect(sql).toContain(`x."role" = 'SUBSTITUTE' OR x."teacherId" =`);
      expect(insert.slice(1)).toEqual([SCHOOL_ID, CAL_LESSON_ID, NEW_TEACHER_ID, CAL_LESSON_ID, NEW_TEACHER_ID]);
      expect(tx.calendarLessonTeacher.create).not.toHaveBeenCalled();
    });

    /*
     * Re-teachering a lesson asks the staffing policy's behörighet question —
     * only that one: the load report is computed from the timplan, so a lesson
     * has no load to be over — of the lesson's own attendance over the läsår.
     */
    describe('ämnesfördelning', () => {
      it('moving a lesson next to another under "not on consecutive days" saves and warns', async () => {
        arrangeUpdate({}, { dayOfWeek: 2 });
        arrangeDistribution({ subject: { minDaysBetween: 2 } }, [
          { id: OTHER_LESSON_ID, dayOfWeek: 3 },
          { id: LESSON_ID, dayOfWeek: 2 },
        ]);

        const updated = await service.update(LESSON_ID, { dayOfWeek: 2 }, testUser());

        expect(tx.masterLesson.update).toHaveBeenCalled();
        expect(updated.warnings).toEqual([
          {
            code: 'DISTRIBUTION_DAYS_TOO_CLOSE',
            params: { requirement: 'Idrott för 7A', firstDay: 2, secondDay: 3, minDaysBetween: 2 },
          },
        ]);
      });

      it('a lesson set aside on the tray breaks nothing, and nothing is read for it', async () => {
        arrangeUpdate({}, { isParked: true });
        arrangeDistribution({ subject: { maxLessonsPerDay: 1 } }, [
          { id: OTHER_LESSON_ID, dayOfWeek: 1 },
          { id: LESSON_ID, dayOfWeek: 1 },
        ]);

        await expect(
          service.update(LESSON_ID, { isParked: true }, testUser()),
        ).resolves.toMatchObject({ warnings: [] });
        expect(tx.masterLesson.findMany).not.toHaveBeenCalledWith(
          expect.objectContaining({ where: expect.objectContaining({ subjectId: SUBJECT_ID }) }),
        );
      });

      it('a lesson set aside while moved to another day breaks nothing either', async () => {
        // The day changed, so the week is asked about — and a lesson on the
        // tray occupies nothing, so it is no part of any breach.
        arrangeUpdate({}, { dayOfWeek: 2, isParked: true });
        const postRead = arrangeDistribution({ subject: { minDaysBetween: 2 } }, [
          { id: OTHER_LESSON_ID, dayOfWeek: 3 },
          { id: LESSON_ID, dayOfWeek: 2, isParked: true },
        ]);

        await expect(
          service.update(LESSON_ID, { dayOfWeek: 2, isParked: true }, testUser()),
        ).resolves.toMatchObject({ warnings: [] });
        // Answered before any read: the tray is no place in the week.
        expect(postRead.mock.calls.filter(([strings]) => isPostRead(strings))).toHaveLength(0);
      });

      it('a lesson nudged within its own day is not asked about the week', async () => {
        // Monday stays Monday, so no day can have gained a lesson: the edit
        // cannot break a rule the week did not already break.
        arrangeUpdate({}, { startTime: t('13:00'), endTime: t('14:00') });
        const postRead = arrangeDistribution({ subject: { maxLessonsPerDay: 1 } }, [
          { id: OTHER_LESSON_ID, dayOfWeek: 1 },
          { id: LESSON_ID, dayOfWeek: 1 },
        ]);

        await expect(
          service.update(LESSON_ID, { startTime: '13:00', endTime: '14:00' }, testUser()),
        ).resolves.toMatchObject({ warnings: [] });
        expect(postRead.mock.calls.filter(([strings]) => isPostRead(strings))).toHaveLength(0);
      });

      it('a lesson put back from the tray onto a full Monday warns', async () => {
        arrangeUpdate({ isParked: true }, { isParked: false });
        arrangeDistribution({ subject: { maxLessonsPerDay: 1 } }, [
          { id: OTHER_LESSON_ID, dayOfWeek: 1 },
          { id: LESSON_ID, dayOfWeek: 1 },
        ]);

        const updated = await service.update(LESSON_ID, { isParked: false }, testUser());

        expect(updated.warnings).toEqual([
          {
            code: 'DISTRIBUTION_TOO_MANY_ON_DAY',
            params: { requirement: 'Idrott för 7A', day: 1, count: 2, maxPerDay: 1 },
          },
        ]);
      });
    });

    describe('Lärarens dag', () => {
      /**
       * The stored lesson, its school counting the caps and the year's day
       * limits as Lärarens dag's gate does, and the row the write gives back.
       */
      const arrangeEdit = (
        counts: { caps?: number; days?: number },
        stored: Record<string, unknown> = {},
        updated: Record<string, unknown> = {},
      ) => {
        tx.masterLesson.findUnique.mockImplementation(
          answerUnique([
            storedLesson({
              ...stored,
              school: {
                id: SCHOOL_ID,
                timezone: 'Europe/Stockholm',
                _count: { academicYears: 1, teacherWorkRules: counts.caps ?? 0, teacherEmployments: counts.days ?? 0 },
              },
            }),
          ]),
        );
        tx.masterLesson.update.mockResolvedValue(lessonRecord({ ...stored, ...updated }));
      };
      const TUESDAY = { dayOfWeek: 2 };
      const TWO_DAY_LIMIT = { userId: TEACHER_ID, maxTeachingDaysPerWeek: 2 };
      /** Monday and Tuesday already taught; the lesson dragged to Wednesday is the third day. */
      const THREE_DAYS = [
        taught('00000000-aaaa-4aaa-8aaa-0000000000a1', 1, '08:00', '09:00'),
        taught('00000000-aaaa-4aaa-8aaa-0000000000a2', 2, '08:00', '09:00'),
        taught(LESSON_ID, 3, '10:00', '11:00'),
      ];

      it('a school without a cap or a day limit sends not one statement more, however long the day', async () => {
        arrangeEdit({}, {}, TUESDAY);
        arrangeTeacherDay({
          caps: [{ userId: TEACHER_ID, maxTeachingMinutesPerDay: 30 }],
          limits: [{ userId: TEACHER_ID, maxTeachingDaysPerWeek: 1 }],
          week: [taught(LESSON_ID, 2, '07:00', '19:00'), taught(OTHER_LESSON_ID, 4, '08:00', '09:00')],
        });

        await expect(service.update(LESSON_ID, TUESDAY, testUser())).resolves.toMatchObject({ warnings: [] });
        expect(tx.teacherWorkRule.findMany).not.toHaveBeenCalled();
        expect(tx.teacherEmployment.findMany).not.toHaveBeenCalled();
        expect(weekReads()).toHaveLength(0);
        expect(recordedReads(tx)).toEqual([]);
        // The gate rides in the school's statement the PATCH already makes:
        // any cap of the school, any day limit of the lesson's own year.
        const [read] = tx.masterLesson.findUnique.mock.calls[0] as [Query];
        expect(read.select!.school.select._count.select).toEqual({
          academicYears: expect.anything(),
          teacherWorkRules: { where: { maxTeachingMinutesPerDay: { not: null } } },
          teacherEmployments: {
            where: {
              maxTeachingDaysPerWeek: { not: null },
              academicYear: { is: { masterLessons: { some: { id: LESSON_ID } } } },
            },
          },
        });
      });

      it('a drag onto a teacher’s long Tuesday saves and warns with the cap’s figures, to any reader', async () => {
        arrangeEdit({ caps: 1 }, {}, TUESDAY);
        arrangeTeacherDay({
          caps: [{ userId: TEACHER_ID, maxTeachingMinutesPerDay: 120 }],
          week: [taught(OTHER_LESSON_ID, 2, '08:00', '09:30'), taught(LESSON_ID, 2, '10:00', '11:00')],
        });

        const updated = await service.update(LESSON_ID, TUESDAY, scheduler());

        expect(tx.masterLesson.update).toHaveBeenCalled();
        expect(updated.warnings).toEqual([
          { code: 'TEACHER_DAY_TOO_LONG', params: { role: 'LEAD', requirement: 'Idrott för 7A', day: 2, minutes: 150, cap: 120 } },
        ]);
        expect(tx.teacherWorkRule.findMany).toHaveBeenCalledWith({
          where: { userId: { in: [TEACHER_ID] }, maxTeachingMinutesPerDay: { not: null } },
          select: { userId: true, maxTeachingMinutesPerDay: true },
        });
        // The school counts no day limit: no post is read for one.
        expect(tx.teacherEmployment.findMany).not.toHaveBeenCalled();
        expect(weekReads().map(([query]) => query)).toEqual([
          {
            where: {
              academicYearId: YEAR_ID,
              isParked: false,
              OR: [{ teacherId: { in: [TEACHER_ID] } }, { coTeacherId: { in: [TEACHER_ID] } }],
            },
            select: {
              id: true,
              teacherId: true,
              coTeacherId: true,
              dayOfWeek: true,
              startTime: true,
              endTime: true,
              recurrence: true,
              startDate: true,
              endDate: true,
            },
          },
        ]);
        // The cap is the work rule's, which all staff read: nothing to record.
        expect(recordedReads(tx)).toEqual([]);
      });

      it('a long day the edit is no part of is not this save’s to repeat', async () => {
        // Wednesday was over the cap before the edit; the lesson goes to Thursday.
        arrangeEdit({ caps: 1 }, {}, { dayOfWeek: 4 });
        arrangeTeacherDay({
          caps: [{ userId: TEACHER_ID, maxTeachingMinutesPerDay: 60 }],
          week: [taught(OTHER_LESSON_ID, 3, '08:00', '10:00'), taught(LESSON_ID, 4, '10:00', '11:00')],
        });

        await expect(service.update(LESSON_ID, { dayOfWeek: 4 }, testUser())).resolves.toMatchObject({
          warnings: [],
        });
        expect(weekReads()).toHaveLength(1);
        expect(nameReads()).toEqual([]);
      });

      it('the minutes told are the weeks the edit is in: the even Mondays it made 100, not the odd ones already at 120', async () => {
        // The odd Mondays were over the cap before the edit; the lesson, every
        // even week, joins a 40-minute one on the even Mondays.
        arrangeEdit({ caps: 1 }, { dayOfWeek: 2, recurrence: 'EVEN_WEEKS' }, { dayOfWeek: 1 });
        arrangeTeacherDay({
          caps: [{ userId: TEACHER_ID, maxTeachingMinutesPerDay: 90 }],
          week: [
            taught(OTHER_LESSON_ID, 1, '08:00', '10:00', { recurrence: 'ODD_WEEKS' }),
            taught('00000000-aaaa-4aaa-8aaa-0000000000a5', 1, '08:00', '08:40', { recurrence: 'EVEN_WEEKS' }),
            taught(LESSON_ID, 1, '10:00', '11:00', { recurrence: 'EVEN_WEEKS' }),
          ],
        });

        const updated = await service.update(LESSON_ID, { dayOfWeek: 1 }, testUser());

        expect(updated.warnings).toEqual([
          {
            code: 'TEACHER_DAY_TOO_LONG',
            params: { role: 'LEAD', requirement: 'Idrott för 7A', day: 1, minutes: 100, cap: 90 },
          },
        ]);
      });

      it('the medlärare’s day too, named as CO_TEACHER', async () => {
        arrangeEdit({ caps: 1 }, { coTeacherId: CO_TEACHER_ID }, TUESDAY);
        arrangeTeacherDay({
          caps: [{ userId: CO_TEACHER_ID, maxTeachingMinutesPerDay: 60 }],
          week: [
            taught(OTHER_LESSON_ID, 2, '08:00', '09:00', { teacherId: CO_TEACHER_ID }),
            taught(LESSON_ID, 2, '10:00', '11:00', { coTeacherId: CO_TEACHER_ID }),
          ],
        });

        const updated = await service.update(LESSON_ID, TUESDAY, testUser());

        expect(updated.warnings).toEqual([
          { code: 'TEACHER_DAY_TOO_LONG', params: { role: 'CO_TEACHER', requirement: 'Idrott för 7A', day: 2, minutes: 120, cap: 60 } },
        ]);
        // Both teachers' rules are asked; only the one with a rule has a week read.
        expect(tx.teacherWorkRule.findMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: expect.objectContaining({ userId: { in: [TEACHER_ID, CO_TEACHER_ID] } }) }),
        );
        expect(weekReads()[0]![0].where!.OR).toEqual([
          { teacherId: { in: [CO_TEACHER_ID] } },
          { coTeacherId: { in: [CO_TEACHER_ID] } },
        ]);
      });

      it('a lead and medlärare who are one person, as an old row has it, is one teacher told once as LEAD', async () => {
        arrangeEdit({ caps: 1 }, { coTeacherId: TEACHER_ID }, TUESDAY);
        arrangeTeacherDay({
          caps: [{ userId: TEACHER_ID, maxTeachingMinutesPerDay: 60 }],
          week: [
            taught(OTHER_LESSON_ID, 2, '08:00', '09:00'),
            taught(LESSON_ID, 2, '10:00', '11:00', { coTeacherId: TEACHER_ID }),
          ],
        });

        const updated = await service.update(LESSON_ID, TUESDAY, testUser());

        expect(updated.warnings).toEqual([
          { code: 'TEACHER_DAY_TOO_LONG', params: { role: 'LEAD', requirement: 'Idrott för 7A', day: 2, minutes: 120, cap: 60 } },
        ]);
        expect(tx.teacherWorkRule.findMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: expect.objectContaining({ userId: { in: [TEACHER_ID] } }) }),
        );
      });

      it('a parked lesson of the teacher’s occupies nothing on their day', async () => {
        arrangeEdit({ caps: 1 }, {}, TUESDAY);
        arrangeTeacherDay({
          caps: [{ userId: TEACHER_ID, maxTeachingMinutesPerDay: 120 }],
          week: [
            taught(OTHER_LESSON_ID, 2, '08:00', '10:00', { isParked: true }),
            taught(LESSON_ID, 2, '10:00', '11:00'),
          ],
        });

        await expect(service.update(LESSON_ID, TUESDAY, testUser())).resolves.toMatchObject({ warnings: [] });
      });

      it('an odd-week and an even-week lesson on one Tuesday never meet, as the week has them', async () => {
        arrangeEdit({ caps: 1 }, { recurrence: 'EVEN_WEEKS' }, TUESDAY);
        arrangeTeacherDay({
          caps: [{ userId: TEACHER_ID, maxTeachingMinutesPerDay: 90 }],
          week: [
            taught(OTHER_LESSON_ID, 2, '08:00', '09:00', { recurrence: 'ODD_WEEKS' }),
            taught(LESSON_ID, 2, '10:00', '11:00', { recurrence: 'EVEN_WEEKS' }),
          ],
        });

        await expect(service.update(LESSON_ID, TUESDAY, testUser())).resolves.toMatchObject({ warnings: [] });
        expect(weekReads()).toHaveLength(1);
      });

      it('a term the lesson does not share with another is a week they never meet in', async () => {
        arrangeEdit({ caps: 1 }, { startDate: day('2027-01-11') }, TUESDAY);
        arrangeTeacherDay({
          caps: [{ userId: TEACHER_ID, maxTeachingMinutesPerDay: 90 }],
          week: [
            taught(OTHER_LESSON_ID, 2, '08:00', '09:00', { endDate: day('2026-12-18') }),
            taught(LESSON_ID, 2, '10:00', '11:00', { startDate: day('2027-01-11') }),
          ],
        });

        await expect(service.update(LESSON_ID, TUESDAY, testUser())).resolves.toMatchObject({ warnings: [] });
      });

      it('a lesson set aside asks nothing, however its teacher’s day stands', async () => {
        arrangeEdit({ caps: 1, days: 1 }, {}, { isParked: true });
        arrangeTeacherDay({
          caps: [{ userId: TEACHER_ID, maxTeachingMinutesPerDay: 30 }],
          limits: [{ userId: TEACHER_ID, maxTeachingDaysPerWeek: 1 }],
          week: [taught(LESSON_ID, 1, '07:00', '19:00'), taught(OTHER_LESSON_ID, 2, '08:00', '09:00')],
        });

        await expect(service.update(LESSON_ID, { isParked: true }, testUser())).resolves.toMatchObject({
          warnings: [],
        });
        expect(tx.teacherWorkRule.findMany).not.toHaveBeenCalled();
        expect(tx.teacherEmployment.findMany).not.toHaveBeenCalled();
      });

      it('a lesson edited while it stays on the tray asks nothing, even with a new teacher', async () => {
        arrangeEdit({ caps: 1 }, { isParked: true }, { coTeacherId: CO_TEACHER_ID });
        arrangeTeacherDay({ caps: [{ userId: CO_TEACHER_ID, maxTeachingMinutesPerDay: 30 }] });

        await service.update(LESSON_ID, { coTeacherId: CO_TEACHER_ID }, testUser());

        expect(tx.teacherWorkRule.findMany).not.toHaveBeenCalled();
      });

      it('a lesson put back from the tray onto a long day warns', async () => {
        arrangeEdit({ caps: 1 }, { isParked: true }, { isParked: false });
        arrangeTeacherDay({
          caps: [{ userId: TEACHER_ID, maxTeachingMinutesPerDay: 60 }],
          week: [taught(OTHER_LESSON_ID, 1, '08:00', '09:00'), taught(LESSON_ID, 1, '10:00', '11:00')],
        });

        const updated = await service.update(LESSON_ID, { isParked: false }, testUser());

        expect(updated.warnings).toEqual([
          { code: 'TEACHER_DAY_TOO_LONG', params: { role: 'LEAD', requirement: 'Idrott för 7A', day: 1, minutes: 120, cap: 60 } },
        ]);
      });

      it('a lesson made longer within its own day is asked about: the day is what changed', async () => {
        arrangeEdit({ caps: 1 }, {}, { endTime: t('12:00') });
        arrangeTeacherDay({
          caps: [{ userId: TEACHER_ID, maxTeachingMinutesPerDay: 150 }],
          week: [taught(OTHER_LESSON_ID, 1, '08:00', '09:00'), taught(LESSON_ID, 1, '10:00', '12:00')],
        });

        const updated = await service.update(LESSON_ID, { endTime: '12:00' }, testUser());

        expect(updated.warnings).toEqual([
          { code: 'TEACHER_DAY_TOO_LONG', params: { role: 'LEAD', requirement: 'Idrott för 7A', day: 1, minutes: 180, cap: 150 } },
        ]);
      });

      it('an edit that leaves the slot and the teachers as they were asks nothing: a room, or the dialog restating them', async () => {
        arrangeEdit({ caps: 1, days: 1 });
        arrangeTeacherDay({
          caps: [{ userId: TEACHER_ID, maxTeachingMinutesPerDay: 30 }],
          limits: [{ userId: TEACHER_ID, maxTeachingDaysPerWeek: 1 }],
          week: [taught(LESSON_ID, 1, '10:00', '11:00'), taught(OTHER_LESSON_ID, 2, '08:00', '09:00')],
        });

        await service.update(LESSON_ID, { roomId: NEW_ROOM_ID }, testUser());
        await service.update(
          LESSON_ID,
          {
            dayOfWeek: 1,
            startTime: '10:00',
            endTime: '11:00',
            teacherId: TEACHER_ID,
            coTeacherId: null,
            recurrence: 'ALL_WEEKS',
            startDate: null,
            endDate: null,
            isLocked: true,
          },
          testUser(),
        );

        expect(tx.teacherWorkRule.findMany).not.toHaveBeenCalled();
        expect(tx.teacherEmployment.findMany).not.toHaveBeenCalled();
      });

      it('a teacher this PATCH puts on a lesson that stays is asked about; the one who kept it is not', async () => {
        // The lead's Monday was over the cap before; the edit did not change
        // it. The new medlärare's Monday is the edit's.
        arrangeEdit({ caps: 1 }, {}, { coTeacherId: CO_TEACHER_ID });
        arrangeTeacherDay({
          caps: [
            { userId: TEACHER_ID, maxTeachingMinutesPerDay: 60 },
            { userId: CO_TEACHER_ID, maxTeachingMinutesPerDay: 60 },
          ],
          week: [
            taught(OTHER_LESSON_ID, 1, '08:00', '09:00'),
            taught('00000000-aaaa-4aaa-8aaa-0000000000a3', 1, '08:00', '09:00', { teacherId: CO_TEACHER_ID }),
            taught(LESSON_ID, 1, '10:00', '11:00', { coTeacherId: CO_TEACHER_ID }),
          ],
        });

        const updated = await service.update(LESSON_ID, { coTeacherId: CO_TEACHER_ID }, testUser());

        expect(updated.warnings).toEqual([
          { code: 'TEACHER_DAY_TOO_LONG', params: { role: 'CO_TEACHER', requirement: 'Idrott för 7A', day: 1, minutes: 120, cap: 60 } },
        ]);
        expect(tx.teacherWorkRule.findMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: expect.objectContaining({ userId: { in: [CO_TEACHER_ID] } }) }),
        );
      });

      it('a school with a cap, on none of this lesson’s teachers, reads the rules and no week', async () => {
        arrangeEdit({ caps: 1 }, {}, TUESDAY);
        arrangeTeacherDay({ caps: [{ userId: NEW_TEACHER_ID, maxTeachingMinutesPerDay: 30 }] });

        await expect(service.update(LESSON_ID, TUESDAY, testUser())).resolves.toMatchObject({ warnings: [] });
        expect(tx.teacherWorkRule.findMany).toHaveBeenCalledTimes(1);
        expect(weekReads()).toHaveLength(0);
      });

      describe('the days, which are the post’s', () => {
        it('a reader with HR-läs gets the count and the limit, and the read is in the läslogg', async () => {
          arrangeEdit({ days: 1 }, {}, { dayOfWeek: 3 });
          arrangeTeacherDay({ limits: [TWO_DAY_LIMIT], week: THREE_DAYS });

          const updated = await service.update(LESSON_ID, { dayOfWeek: 3 }, testUser({ channel: 'WEB' }));

          expect(updated.warnings).toEqual([
            { code: 'TEACHER_WEEK_TOO_MANY_DAYS', params: { role: 'LEAD', requirement: 'Idrott för 7A', days: 3, max: 2 } },
          ]);
          // The post of the lesson's own läsår; the school counts no cap, so
          // no work rule is read.
          expect(tx.teacherEmployment.findMany).toHaveBeenCalledWith({
            where: { academicYearId: YEAR_ID, userId: { in: [TEACHER_ID] }, maxTeachingDaysPerWeek: { not: null } },
            select: { userId: true, maxTeachingDaysPerWeek: true },
          });
          expect(tx.teacherWorkRule.findMany).not.toHaveBeenCalled();
          expect(recordedReads(tx)).toEqual([{ kind: 'EMPLOYMENT', channel: 'WEB', ids: [TEACHER_ID] }]);
        });

        it('a schemaläggare without HR-läs is told the verdict and not one figure, and the read is recorded all the same', async () => {
          arrangeEdit({ days: 1 }, {}, { dayOfWeek: 3 });
          arrangeTeacherDay({ limits: [TWO_DAY_LIMIT], week: THREE_DAYS });

          const updated = await service.update(LESSON_ID, { dayOfWeek: 3 }, scheduler());

          expect(updated.warnings).toEqual([
            { code: 'TEACHER_WEEK_TOO_MANY_DAYS_HIDDEN', params: { role: 'LEAD', requirement: 'Idrott för 7A' } },
          ]);
          expect(recordedReads(tx)).toEqual([{ kind: 'EMPLOYMENT', channel: 'WEB', ids: [TEACHER_ID] }]);
        });

        it('a schemaläggare with HR-läs gets the figures', async () => {
          arrangeEdit({ days: 1 }, {}, { dayOfWeek: 3 });
          arrangeTeacherDay({ limits: [TWO_DAY_LIMIT], week: THREE_DAYS });

          const updated = await service.update(
            LESSON_ID,
            { dayOfWeek: 3 },
            testUser({ adminProfile: 'SCHEMALAGGARE', hrRead: true }),
          );

          expect(updated.warnings).toEqual([
            { code: 'TEACHER_WEEK_TOO_MANY_DAYS', params: { role: 'LEAD', requirement: 'Idrott för 7A', days: 3, max: 2 } },
          ]);
        });

        it('both rules broken: the cap first, then the days, and the post is recorded once', async () => {
          arrangeEdit({ caps: 1, days: 1 }, {}, TUESDAY);
          arrangeTeacherDay({
            caps: [{ userId: TEACHER_ID, maxTeachingMinutesPerDay: 120 }],
            limits: [{ userId: TEACHER_ID, maxTeachingDaysPerWeek: 1 }],
            week: [
              taught(OTHER_LESSON_ID, 2, '08:00', '09:30'),
              taught('00000000-aaaa-4aaa-8aaa-0000000000a1', 1, '08:00', '09:00'),
              taught(LESSON_ID, 2, '10:00', '11:00'),
            ],
          });

          const updated = await service.update(LESSON_ID, TUESDAY, testUser({ channel: 'APP' }));

          expect(updated.warnings).toEqual([
            { code: 'TEACHER_DAY_TOO_LONG', params: { role: 'LEAD', requirement: 'Idrott för 7A', day: 2, minutes: 150, cap: 120 } },
            { code: 'TEACHER_WEEK_TOO_MANY_DAYS', params: { role: 'LEAD', requirement: 'Idrott för 7A', days: 2, max: 1 } },
          ]);
          expect(recordedReads(tx)).toEqual([{ kind: 'EMPLOYMENT', channel: 'APP', ids: [TEACHER_ID] }]);
          // Two warnings about one lesson: its names asked once, for it once.
          expect(nameReads()).toEqual([[LESSON_ID]]);
        });

        it('the count told is the weeks the edit is in, not the odd weeks already over the limit', async () => {
          // Odd weeks were four days before the edit; the lesson, every even
          // week, makes the even weeks three.
          arrangeEdit({ days: 1 }, { recurrence: 'EVEN_WEEKS' }, { dayOfWeek: 3 });
          arrangeTeacherDay({
            limits: [TWO_DAY_LIMIT],
            week: [
              ...[1, 2, 4, 5].map((day) =>
                taught(`00000000-aaaa-4aaa-8aaa-0000000000b${day}`, day, '08:00', '09:00', { recurrence: 'ODD_WEEKS' }),
              ),
              taught('00000000-aaaa-4aaa-8aaa-0000000000a1', 1, '08:00', '09:00', { recurrence: 'EVEN_WEEKS' }),
              taught('00000000-aaaa-4aaa-8aaa-0000000000a2', 2, '08:00', '09:00', { recurrence: 'EVEN_WEEKS' }),
              taught(LESSON_ID, 3, '10:00', '11:00', { recurrence: 'EVEN_WEEKS' }),
            ],
          });

          const updated = await service.update(LESSON_ID, { dayOfWeek: 3 }, testUser());

          expect(updated.warnings).toEqual([
            { code: 'TEACHER_WEEK_TOO_MANY_DAYS', params: { role: 'LEAD', requirement: 'Idrott för 7A', days: 3, max: 2 } },
          ]);
        });

        it('a day limit kept records nothing, though a cap beside it was broken', async () => {
          arrangeEdit({ caps: 1, days: 1 }, {}, TUESDAY);
          arrangeTeacherDay({
            caps: [{ userId: TEACHER_ID, maxTeachingMinutesPerDay: 120 }],
            limits: [{ userId: TEACHER_ID, maxTeachingDaysPerWeek: 5 }],
            week: [taught(OTHER_LESSON_ID, 2, '08:00', '09:30'), taught(LESSON_ID, 2, '10:00', '11:00')],
          });

          const updated = await service.update(LESSON_ID, TUESDAY, testUser());

          expect(updated.warnings).toEqual([
            { code: 'TEACHER_DAY_TOO_LONG', params: { role: 'LEAD', requirement: 'Idrott för 7A', day: 2, minutes: 150, cap: 120 } },
          ]);
          expect(recordedReads(tx)).toEqual([]);
        });
      });
    });

    describe('the staffing policy', () => {
      const arrangePolicy = (mode: 'OFF' | 'WARN' | 'REFUSE', held: Record<string, unknown>[]) => {
        tx.staffingPolicy.findUnique.mockResolvedValue({
          qualificationMode: mode,
          overAllocationMode: 'REFUSE',
          overAllocationTolerancePercent: 10,
          fullTimeTeachingMinutesPerWeek: 1,
          unstaffedGeneration: 'ALLOW',
        });
        tx.teacherSubjectQualification.findMany.mockResolvedValue(held);
        tx.subject.findUnique.mockResolvedValue({ name: 'Matematik' });
        tx.academicYear.findUnique.mockResolvedValue({ startDate: day('2026-08-17'), endDate: day('2027-06-11') });
        tx.studentGroup.findMany.mockResolvedValue([{ id: GROUP_ID, gradeLevel: 8 }]);
      };
      const someoneElses = [
        { userId: TEACHER_ID, subjectId: SUBJECT_ID, minGradeLevel: 7, maxGradeLevel: 9, kind: 'LEGITIMATION', validFrom: null, validTo: null },
      ];

      it('WARN: re-teachers to a teacher without behörighet, and says so', async () => {
        arrangeUpdate({}, { teacherId: NEW_TEACHER_ID });
        arrangePolicy('WARN', someoneElses);

        const updated = await service.update(LESSON_ID, { teacherId: NEW_TEACHER_ID }, testUser());

        expect(updated.warnings).toEqual([
          { code: 'STAFF_TEACHER_NOT_QUALIFIED', params: { role: 'TEACHER', subject: 'Matematik', grades: '8' } },
        ]);
        expect(tx.masterLesson.update).toHaveBeenCalledTimes(1);
      });

      it('REFUSE: 409 with the code and params, and the lesson is not touched', async () => {
        arrangeUpdate({}, { teacherId: NEW_TEACHER_ID });
        arrangePolicy('REFUSE', someoneElses);

        await expect(
          service.update(LESSON_ID, { coTeacherId: NEW_TEACHER_ID }, testUser()),
        ).rejects.toMatchObject({
          response: {
            code: 'STAFF_TEACHER_NOT_QUALIFIED',
            params: { role: 'CO_TEACHER', subject: 'Matematik', grades: '8' },
          },
        });
        expect(tx.masterLesson.update).not.toHaveBeenCalled();
      });

      it('a qualified teacher passes, under REFUSE too', async () => {
        arrangeUpdate({}, { teacherId: NEW_TEACHER_ID });
        arrangePolicy('REFUSE', [{ ...someoneElses[0], userId: NEW_TEACHER_ID }]);

        await expect(
          service.update(LESSON_ID, { teacherId: NEW_TEACHER_ID }, testUser()),
        ).resolves.toMatchObject({ warnings: [] });
      });

      it('asks nothing when the PATCH keeps the teacher, or the policy is OFF', async () => {
        arrangeUpdate();
        arrangePolicy('REFUSE', someoneElses);
        await expect(
          service.update(LESSON_ID, { teacherId: TEACHER_ID, dayOfWeek: 1 }, testUser()),
        ).resolves.toMatchObject({ warnings: [] });

        arrangePolicy('OFF', someoneElses);
        await expect(
          service.update(LESSON_ID, { teacherId: NEW_TEACHER_ID }, testUser()),
        ).resolves.toMatchObject({ warnings: [] });
        expect(tx.teacherSubjectQualification.findMany).not.toHaveBeenCalled();
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
      notifications.recipientsForLessons.mockResolvedValue(recipients);

      await service.update(
        LESSON_ID,
        { dayOfWeek: 3, startTime: '09:00', endTime: '10:30' },
        testUser(),
      );

      // The one roster reader's scope: the classes, and the pupils named on
      // the lesson (none here).
      expect(notifications.recipientsForLessons).toHaveBeenCalledWith(tx, [
        { groupIds: [GROUP_ID, EXTRA_GROUP_ID], participantIds: [] },
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

      expect(notifications.recipientsForLessons).toHaveBeenCalledWith(tx, [
        // the attached group — not the one it replaced
        { groupIds: [GROUP_ID, OTHER_EXTRA_GROUP_ID], participantIds: [] },
      ]);
    });

    // A pupil named on the lesson itself (MasterLessonStudents) attends it
    // as much as the class does: the notice used to read the classes alone.
    it('tells the pupils named on the lesson after the update too', async () => {
      arrangeUpdate(
        { participants: [{ studentId: STUDENT_ID }] },
        { dayOfWeek: 3, participants: [{ studentId: STUDENT_ID }] },
      );
      tx.calendarLesson.findMany.mockResolvedValue([
        { id: CAL_LESSON_ID, date: new Date('2026-08-10T00:00:00.000Z') },
      ]);
      tx.subject.findUnique.mockResolvedValue({ name: 'Mathematics' });

      await service.update(LESSON_ID, { dayOfWeek: 3 }, testUser());

      expect(notifications.recipientsForLessons).toHaveBeenCalledWith(tx, [
        { groupIds: [GROUP_ID], participantIds: [STUDENT_ID] },
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
      expect(notifications.recipientsForLessons).not.toHaveBeenCalled();
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

    it('removes only attendance-free SCHEDULED calendar lessons not yet begun with the template', async () => {
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
          startsAt: { gt: NOW },
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

  // -------------------------------------------------------------------
  // Block i schemat: a parallel block's card, and a member moved alone
  // -------------------------------------------------------------------

  describe('Block i schemat', () => {
    const BLOCK_ID = '12121212-1212-4212-8212-121212121212';
    const FR_LESSON = '13131313-1313-4313-8313-131313131313';
    const FR_GROUP = '14141414-1414-4414-8414-141414141414';
    const FR_SUBJECT = '15151515-1515-4515-8515-151515151515';
    const FR_TEACHER = '16161616-1616-4616-8616-161616161616';
    const FR_ROOM = '17171717-1717-4717-8717-171717171717';

    /** block-lessons.ts' read: told apart from the other raw statements by its alias. */
    const isBlockRead = (first: unknown): boolean =>
      Array.isArray(first) && first.join('?').includes('FROM "TeachingRequirements" own');
    /** Franska för Fr7, the other member of Språkval åk 7, on Monday 10:00–11:00. */
    const franska = (overrides: Record<string, unknown> = {}) => ({
      blockId: BLOCK_ID,
      name: 'Språkval åk 7',
      id: FR_LESSON,
      studentGroupId: FR_GROUP,
      subjectId: FR_SUBJECT,
      dayOfWeek: 1,
      startTime: '10:00',
      endTime: '11:00',
      recurrence: 'ALL_WEEKS',
      startDate: null,
      endDate: null,
      isGenerated: true,
      isLocked: false,
      ...overrides,
    });
    const arrangeBlock = (rows: Row[]) => {
      const raw = jest.fn((strings: unknown) => Promise.resolve(isBlockRead(strings) ? rows : []));
      Object.assign(tx, { $queryRaw: raw });
      return raw;
    };
    const blockReads = (raw: jest.Mock) => raw.mock.calls.filter(([strings]) => isBlockRead(strings)).length;

    describe('a member moved by hand (update)', () => {
      const arrangeStored = (overrides: Record<string, unknown> = {}) => {
        tx.masterLesson.findUnique.mockImplementation(
          answerUnique([
            {
              ...lessonRecord(overrides),
              school: { id: SCHOOL_ID, timezone: 'Europe/Stockholm', _count: { academicYears: 1 } },
            },
          ]),
        );
        tx.masterLesson.update.mockResolvedValue(lessonRecord());
      };
      const written = () => (tx.masterLesson.update.mock.calls[0]![0] as { data: Row }).data;

      it('splits the block when it leaves the others: the lesson is the school’s, and the save says so', async () => {
        arrangeStored();
        arrangeBlock([franska()]);

        const result = await service.update(LESSON_ID, { dayOfWeek: 2 }, testUser());

        expect(written()).toMatchObject({ dayOfWeek: 2, isGenerated: false });
        expect(written()).not.toHaveProperty('isLocked');
        expect(result.warnings).toContainEqual({ code: 'BLOCK_SPLIT', params: { block: 'Språkval åk 7' } });
      });

      it('changes no owner and says nothing when a lesson already apart moves on: it left no card', async () => {
        // A block made over a timetable that never placed its lessons together
        // is this case for every lesson: a nudge must not refuse the block.
        arrangeStored({ dayOfWeek: 3 });
        arrangeBlock([franska()]);

        const result = await service.update(LESSON_ID, { dayOfWeek: 4 }, testUser());

        expect(written()).not.toHaveProperty('isGenerated');
        expect(result.warnings).toEqual([]);
      });

      it('splits the block when a member leaves its card for another card of the block', async () => {
        // Tyska left Franska at Monday 10:00 and lands beside Spanska's other
        // lesson on Tuesday: Franska stands alone, so the block is split.
        arrangeStored();
        arrangeBlock([franska(), franska({ id: '18181818-1818-4818-8818-181818181818', dayOfWeek: 2 })]);

        const result = await service.update(LESSON_ID, { dayOfWeek: 2 }, testUser());

        expect(written()).toMatchObject({ isGenerated: false });
        expect(result.warnings.map((warning) => warning.code)).toEqual(['BLOCK_SPLIT']);
      });

      it('joins the card it lands on, taking the card’s owner and lock, and says nothing', async () => {
        arrangeStored({ dayOfWeek: 2 });
        arrangeBlock([franska({ isLocked: true })]);

        const result = await service.update(LESSON_ID, { dayOfWeek: 1 }, testUser());

        expect(written()).toMatchObject({ dayOfWeek: 1, isGenerated: true, isLocked: true });
        expect(result.warnings).toEqual([]);
      });

      it('rejoins on an undo’s whole snapshot: the window does not make it the school’s, the card’s lock stands', async () => {
        // The undo of a split sends the whole snapshot: the window, which
        // alone would make the lesson the school's, and the lock it had —
        // the lesson's own lock as it is, which is no change of it.
        arrangeStored({ dayOfWeek: 2 });
        arrangeBlock([franska({ isLocked: true })]);

        await service.update(
          LESSON_ID,
          { dayOfWeek: 1, startTime: '10:00', endTime: '11:00', recurrence: 'ALL_WEEKS', startDate: null, endDate: null, isLocked: false },
          testUser(),
        );

        expect(written()).toMatchObject({ isGenerated: true, isLocked: true });
      });

      it('lets a lock the PATCH changes stand on a rejoin', async () => {
        arrangeStored({ dayOfWeek: 2 });
        arrangeBlock([franska({ isLocked: false })]);

        await service.update(LESSON_ID, { dayOfWeek: 1, isLocked: true }, testUser());

        expect(written()).toMatchObject({ isGenerated: true, isLocked: true });
      });

      it('joins only in the card’s weeks: the same clock on odd weeks is no card', async () => {
        arrangeStored({ dayOfWeek: 2 });
        arrangeBlock([franska({ recurrence: 'ODD_WEEKS' })]);

        const result = await service.update(LESSON_ID, { dayOfWeek: 1 }, testUser());

        expect(written()).not.toHaveProperty('isGenerated');
        expect(result.warnings).toEqual([]);
      });

      it('splits when a member’s weeks are narrowed in its card: it no longer runs beside the others', async () => {
        arrangeStored();
        arrangeBlock([franska()]);

        const result = await service.update(LESSON_ID, { recurrence: 'ODD_WEEKS' }, testUser());

        expect(written()).toMatchObject({ recurrence: 'ODD_WEEKS', isGenerated: false });
        expect(result.warnings.map((warning) => warning.code)).toEqual(['BLOCK_SPLIT']);
      });

      it('keeps a block lesson the engine’s when its dialog writes its weeks as they stood', async () => {
        // The dialog sends the window on every save. A room changed in a
        // card member's dialog must not leave the whole block refused.
        arrangeStored();
        arrangeBlock([franska()]);
        const dialog = { dayOfWeek: 1, startTime: '10:00', endTime: '11:00', roomId: FR_ROOM, recurrence: 'ALL_WEEKS' as const, startDate: null, endDate: null };

        const result = await service.update(LESSON_ID, dialog, testUser());
        expect(written()).not.toHaveProperty('isGenerated');
        expect(result.warnings).toEqual([]);

        // A lesson in no block is handed over by the same save, as before.
        tx.masterLesson.update.mockClear();
        arrangeBlock([]);
        await service.update(LESSON_ID, dialog, testUser());
        expect(written()).toMatchObject({ isGenerated: false });
      });

      it('puts a member back from the tray beside its card as the card’s', async () => {
        arrangeStored({ isParked: true });
        arrangeBlock([franska()]);

        await service.update(LESSON_ID, { isParked: false }, testUser());

        expect(written()).toMatchObject({ isParked: false, isGenerated: true });
      });

      it('splits the block when a member set aside from its card comes back from the tray somewhere else', async () => {
        // Tyska was parked from Monday 10:00, where Franska still stands, and
        // is dragged from Parkering to Wednesday: it left the card as a drag
        // would have taken it, so the next generation must refuse the block
        // rather than put Tyska back beside Franska unasked.
        arrangeStored({ isParked: true });
        arrangeBlock([franska()]);

        const result = await service.update(LESSON_ID, { isParked: false, dayOfWeek: 3 }, testUser());

        expect(written()).toMatchObject({ isParked: false, dayOfWeek: 3, isGenerated: false });
        expect(result.warnings).toContainEqual({ code: 'BLOCK_SPLIT', params: { block: 'Språkval åk 7' } });
      });

      it('changes no owner for a lesson back from the tray whose remembered slot holds none of its block', async () => {
        // The card moved on while Tyska was parked: there is no card it left.
        arrangeStored({ isParked: true });
        arrangeBlock([franska({ dayOfWeek: 2 })]);

        const result = await service.update(LESSON_ID, { isParked: false, dayOfWeek: 3 }, testUser());

        expect(written()).not.toHaveProperty('isGenerated');
        expect(result.warnings).toEqual([]);
      });

      it('asks nothing of an edit that moves no lesson, sets one aside, or edits one on the tray', async () => {
        arrangeStored();
        const raw = arrangeBlock([franska()]);

        await service.update(LESSON_ID, { roomId: FR_ROOM }, testUser());
        await service.update(LESSON_ID, { isParked: true, dayOfWeek: 2 }, testUser());
        arrangeStored({ isParked: true });
        await service.update(LESSON_ID, { dayOfWeek: 2 }, testUser());

        expect(blockReads(raw)).toBe(0);
        for (const [call] of tx.masterLesson.update.mock.calls as Array<[{ data: Row }]>) {
          expect(call.data).not.toHaveProperty('isGenerated');
        }
      });

      it('leaves a lesson in no block, or alone in its block, as any lesson', async () => {
        arrangeStored();
        const raw = arrangeBlock([]);
        const alone = await service.update(LESSON_ID, { dayOfWeek: 2 }, testUser());
        // A block whose other members have no placed lesson: one row of nulls.
        arrangeBlock([{ blockId: BLOCK_ID, name: 'Språkval åk 7', ...Object.fromEntries(
          ['id', 'studentGroupId', 'subjectId', 'dayOfWeek', 'startTime', 'endTime', 'recurrence', 'startDate', 'endDate', 'isGenerated', 'isLocked'].map((key) => [key, null]),
        ) }]);
        const lone = await service.update(LESSON_ID, { dayOfWeek: 2 }, testUser());

        expect(blockReads(raw)).toBe(1);
        for (const [call] of tx.masterLesson.update.mock.calls as Array<[{ data: Row }]>) {
          expect(call.data).not.toHaveProperty('isGenerated');
        }
        expect([...alone.warnings, ...lone.warnings]).toEqual([]);
      });
    });

    describe('moveBlockCard', () => {
      /** Tyska för Ty7 and Franska för Fr7, one card on Monday 10:00–11:00. */
      const tyska = (overrides: Record<string, unknown> = {}) => ({
        ...lessonRecord(),
        isGenerated: true,
        subject: { name: 'Tyska' },
        studentGroup: { name: 'Ty7' },
        school: { id: SCHOOL_ID, timezone: 'Europe/Stockholm', _count: { academicYears: 1 } },
        ...overrides,
      });
      const franskaLesson = (overrides: Record<string, unknown> = {}) =>
        tyska({
          id: FR_LESSON,
          studentGroupId: FR_GROUP,
          subjectId: FR_SUBJECT,
          teacherId: FR_TEACHER,
          roomId: FR_ROOM,
          subject: { name: 'Franska' },
          studentGroup: { name: 'Fr7' },
          ...overrides,
        });
      const posts = [
        { studentGroupId: GROUP_ID, subjectId: SUBJECT_ID, blockId: BLOCK_ID },
        { studentGroupId: FR_GROUP, subjectId: FR_SUBJECT, blockId: BLOCK_ID },
      ];
      /** The card's lessons for the read by id, `day` for the clash scan; the block's other lessons. */
      const arrangeCard = (card: Row[], day: Row[] = [], blockPosts: Row[] = posts, siblings: Row[] = [franska()]) => {
        arrangeBlock(siblings);
        tx.masterLesson.findMany.mockImplementation((query: Query = {}) =>
          query.where && 'id' in query.where && (query.where.id as Row).in
            ? answerRows(card)(query)
            : answerRows(day)(query),
        );
        tx.teachingRequirement.findMany.mockImplementation((query: Query = {}) =>
          Promise.resolve(query.select && 'blockId' in query.select ? blockPosts : []),
        );
        tx.masterLesson.updateMany.mockResolvedValue({ count: card.length });
      };
      const move = (dto: Record<string, unknown> = {}) =>
        service.moveBlockCard(
          { lessonIds: [LESSON_ID, FR_LESSON], dayOfWeek: 2, startTime: '09:00', endTime: '10:00', ...dto } as never,
          testUser(),
        );

      it('moves every member in one statement held to the slot it was read in, and leaves the owner be', async () => {
        arrangeCard([tyska(), franskaLesson()]);

        const result = await move();

        expect(tx.masterLesson.updateMany).toHaveBeenCalledWith({
          where: {
            id: { in: [LESSON_ID, FR_LESSON] },
            dayOfWeek: 1,
            startTime: t('10:00'),
            endTime: t('11:00'),
            recurrence: 'ALL_WEEKS',
            startDate: null,
            endDate: null,
            isParked: false,
          },
          data: { dayOfWeek: 2, startTime: t('09:00'), endTime: t('10:00') },
        });
        expect(tx.masterLesson.updateMany).toHaveBeenCalledTimes(1);
        expect(result.lessons.map((lesson) => [lesson.id, lesson.dayOfWeek, lesson.startTime])).toEqual([
          [LESSON_ID, 2, '09:00'],
          [FR_LESSON, 2, '09:00'],
        ]);
        expect(tx.scheduleChangeLog.create).toHaveBeenCalledTimes(2);
        expect(realtime.notifyMasterTimetableChanged).toHaveBeenCalledTimes(1);
      });

      it('holds the card against the rest of the day with its own lessons left out of where they stood', async () => {
        // Franska's teacher already teaches matematik on Tuesday at 09:00; the
        // card's own lessons, still on Monday, are not in the way.
        arrangeCard(
          [tyska(), franskaLesson()],
          [
            franskaLesson({ dayOfWeek: 2, startTime: t('09:00'), endTime: t('10:00') }),
            otherLesson({ teacherId: FR_TEACHER, startTime: t('09:00'), endTime: t('10:00') }),
          ],
        );

        await expect(move()).rejects.toThrow('Franska för Fr7: Teacher already teaches Math in this slot.');
        const scan = (tx.masterLesson.findMany.mock.calls as Array<[Query]>).find(
          ([query]) => query.where && 'dayOfWeek' in query.where,
        )![0];
        expect(scan.where!.id).toEqual({ notIn: [LESSON_ID, FR_LESSON] });
        expect(tx.masterLesson.updateMany).not.toHaveBeenCalled();
      });

      it('holds the members against each other at the new slot, naming the clash once', async () => {
        arrangeCard([tyska(), franskaLesson({ roomId: ROOM_ID })]);

        const refusal = await move().catch((error: unknown) => error);

        expect(refusal).toBeInstanceOf(ConflictException);
        expect((refusal as ConflictException).message).toBe(
          'Tyska för Ty7: Room is already booked for Franska in this slot.',
        );
      });

      it('refuses lessons that are not one block’s card', async () => {
        arrangeCard([tyska(), franskaLesson()], [], [posts[0]!, { ...posts[1]!, blockId: null }]);
        await expect(move()).rejects.toMatchObject({ response: { code: 'NOT_A_BLOCK_CARD' } });

        arrangeCard([tyska(), franskaLesson()], [], [posts[0]!, { ...posts[1]!, blockId: '18181818-1818-4818-8818-181818181818' }]);
        await expect(move()).rejects.toMatchObject({ response: { code: 'NOT_A_BLOCK_CARD' } });

        // Two lessons of one member are not two members.
        arrangeCard([tyska(), tyska({ id: FR_LESSON })]);
        await expect(move()).rejects.toMatchObject({ response: { code: 'NOT_A_BLOCK_CARD' } });
        expect(tx.masterLesson.updateMany).not.toHaveBeenCalled();
      });

      it('refuses lessons of two läsår as no card', async () => {
        arrangeCard([tyska(), franskaLesson({ academicYearId: '19191919-1919-4919-8919-191919191919' })]);

        await expect(move()).rejects.toMatchObject({ response: { code: 'NOT_A_BLOCK_CARD' } });
      });

      it('refuses a card with a lesson more than the page named, or one gone since, as stale', async () => {
        // Spanska joined the card after the page read it.
        arrangeCard([tyska(), franskaLesson()], [], posts, [
          franska(),
          franska({ id: '18181818-1818-4818-8818-181818181818', studentGroupId: '1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a' }),
        ]);
        await expect(move()).rejects.toMatchObject({ response: { code: 'BLOCK_CARD_STALE' } });

        arrangeCard([tyska()]);
        await expect(move()).rejects.toMatchObject({ response: { code: 'BLOCK_CARD_STALE' } });
        expect(tx.masterLesson.updateMany).not.toHaveBeenCalled();
      });

      it('gives a member the card lands beside the card’s owner, as a lesson moved onto a card takes it', async () => {
        const SPANSKA = '18181818-1818-4818-8818-181818181818';
        // Spanska was moved alone to Tuesday 09:00 before: the school's.
        arrangeCard([tyska(), franskaLesson()], [], posts, [
          franska(),
          franska({ id: SPANSKA, studentGroupId: '1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a', dayOfWeek: 2, startTime: '09:00', endTime: '10:00', isGenerated: false }),
        ]);

        const result = await move();

        expect(tx.masterLesson.updateMany).toHaveBeenLastCalledWith({
          where: { id: { in: [SPANSKA] } },
          data: { isGenerated: true },
        });
        // What the undo must leave behind, with the owner it had.
        expect(result.joined).toEqual([{ id: SPANSKA, isGenerated: false }]);
      });

      it('answers a lesson it lands beside as taken in even when its owner stays, for the undo to leave', async () => {
        const SPANSKA = '18181818-1818-4818-8818-181818181818';
        arrangeCard([tyska(), franskaLesson()], [], posts, [
          franska(),
          franska({ id: SPANSKA, studentGroupId: '1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a', dayOfWeek: 2, startTime: '09:00', endTime: '10:00' }),
        ]);

        const result = await move();

        expect(tx.masterLesson.updateMany).toHaveBeenCalledTimes(1);
        expect(result.joined).toEqual([{ id: SPANSKA, isGenerated: true }]);
      });

      it('lets an undo leave behind what the move took in, with its owner back, and the card is not stale', async () => {
        const SPANSKA = '18181818-1818-4818-8818-181818181818';
        // The card stands on Tuesday 09:00 with Spanska, which it took in: the
        // undo moves Tyska and Franska back to Monday and leaves Spanska.
        const here = { dayOfWeek: 2, startTime: t('09:00'), endTime: t('10:00') };
        arrangeCard([tyska(here), franskaLesson(here)], [], posts, [
          franska({ dayOfWeek: 2, startTime: '09:00', endTime: '10:00' }),
          franska({ id: SPANSKA, studentGroupId: '1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a', dayOfWeek: 2, startTime: '09:00', endTime: '10:00' }),
        ]);

        // Without it named, Spanska is a lesson more than the page named.
        await expect(move({ dayOfWeek: 1, startTime: '10:00', endTime: '11:00' })).rejects.toMatchObject({
          response: { code: 'BLOCK_CARD_STALE' },
        });
        tx.masterLesson.updateMany.mockClear();

        const result = await move({
          dayOfWeek: 1,
          startTime: '10:00',
          endTime: '11:00',
          leave: [{ id: SPANSKA, isGenerated: false }],
        });

        expect(tx.masterLesson.updateMany).toHaveBeenCalledWith({
          where: { id: { in: [SPANSKA] } },
          data: { isGenerated: false },
        });
        expect(result.joined).toEqual([]);
      });

      it('gives no owner back to a lesson named to leave that has since moved away from the card', async () => {
        const SPANSKA = '18181818-1818-4818-8818-181818181818';
        // Spanska was moved to Wednesday by hand after the move the undo reverses.
        arrangeCard([tyska(), franskaLesson()], [], posts, [
          franska(),
          franska({ id: SPANSKA, studentGroupId: '1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a', dayOfWeek: 3 }),
        ]);

        await move({ leave: [{ id: SPANSKA, isGenerated: false }] });

        expect(tx.masterLesson.updateMany).toHaveBeenCalledTimes(1);
      });

      it('refuses a lesson both moved and left behind as no card', async () => {
        arrangeCard([tyska(), franskaLesson()]);

        await expect(move({ leave: [{ id: FR_LESSON, isGenerated: true }] })).rejects.toMatchObject({
          response: { code: 'NOT_A_BLOCK_CARD' },
        });
      });

      it('refuses a card whose lessons no longer stand together, before and at the write', async () => {
        arrangeCard([tyska(), franskaLesson({ startTime: t('10:05'), endTime: t('11:05') })]);
        await expect(move()).rejects.toMatchObject({ response: { code: 'BLOCK_CARD_STALE' } });

        arrangeCard([tyska(), franskaLesson({ isParked: true })]);
        await expect(move()).rejects.toMatchObject({ response: { code: 'BLOCK_CARD_STALE' } });

        // Moved by someone else between the read and the write.
        arrangeCard([tyska(), franskaLesson()]);
        tx.masterLesson.updateMany.mockResolvedValue({ count: 1 });
        await expect(move()).rejects.toMatchObject({ response: { code: 'BLOCK_CARD_STALE' } });
        expect(tx.scheduleChangeLog.create).not.toHaveBeenCalled();
      });

      describe('Lärarens dag', () => {
        /** The school as the card's read counts it: caps, and day limits of the year. */
        const school = (caps: number, days = 0) => ({
          school: {
            id: SCHOOL_ID,
            timezone: 'Europe/Stockholm',
            _count: { academicYears: 1, teacherWorkRules: caps, teacherEmployments: days },
          },
        });
        /** Tuesday after the move: Tyska led by TEACHER_ID, Franska with CO_TEACHER_ID beside its teacher. */
        const tuesday = [
          taught(OTHER_LESSON_ID, 2, '10:00', '11:30'),
          taught(LESSON_ID, 2, '09:00', '10:00'),
          taught(FR_LESSON, 2, '09:00', '10:00', { teacherId: FR_TEACHER, coTeacherId: CO_TEACHER_ID }),
          taught('00000000-aaaa-4aaa-8aaa-0000000000a4', 2, '13:00', '14:00', { teacherId: CO_TEACHER_ID }),
        ];
        const caps = [
          { userId: TEACHER_ID, maxTeachingMinutesPerDay: 120 },
          { userId: CO_TEACHER_ID, maxTeachingMinutesPerDay: 60 },
        ];

        it('a card moved onto long days warns once per teacher, in each one’s role, from one read for the card', async () => {
          arrangeCard([tyska(school(1)), franskaLesson({ coTeacherId: CO_TEACHER_ID, ...school(1) })]);
          arrangeTeacherDay({ caps, week: tuesday });

          const result = await move();

          expect(result.warnings).toEqual([
            {
              code: 'TEACHER_DAY_TOO_LONG',
              params: { role: 'LEAD', requirement: 'Tyska för Ty7', day: 2, minutes: 150, cap: 120 },
            },
            {
              code: 'TEACHER_DAY_TOO_LONG',
              params: { role: 'CO_TEACHER', requirement: 'Franska för Fr7', day: 2, minutes: 120, cap: 60 },
            },
          ]);
          expect(tx.teacherWorkRule.findMany).toHaveBeenCalledTimes(1);
          expect(tx.teacherWorkRule.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
              where: expect.objectContaining({ userId: { in: [TEACHER_ID, FR_TEACHER, CO_TEACHER_ID] } }),
            }),
          );
          expect(weekReads()).toHaveLength(1);
          // The members' names came with the card: none is read again.
          expect(nameReads()).toEqual([]);
        });

        it('two leads over their caps are told apart by the member each leads', async () => {
          arrangeCard([tyska(school(1)), franskaLesson(school(1))]);
          arrangeTeacherDay({
            caps: [
              { userId: TEACHER_ID, maxTeachingMinutesPerDay: 120 },
              { userId: FR_TEACHER, maxTeachingMinutesPerDay: 60 },
            ],
            week: [
              taught(OTHER_LESSON_ID, 2, '10:00', '11:30'),
              taught(LESSON_ID, 2, '09:00', '10:00'),
              taught(FR_LESSON, 2, '09:00', '10:00', { teacherId: FR_TEACHER }),
              taught('00000000-aaaa-4aaa-8aaa-0000000000a4', 2, '13:00', '14:00', { teacherId: FR_TEACHER }),
            ],
          });

          const result = await move();

          expect(result.warnings).toEqual([
            {
              code: 'TEACHER_DAY_TOO_LONG',
              params: { role: 'LEAD', requirement: 'Tyska för Ty7', day: 2, minutes: 150, cap: 120 },
            },
            {
              code: 'TEACHER_DAY_TOO_LONG',
              params: { role: 'LEAD', requirement: 'Franska för Fr7', day: 2, minutes: 120, cap: 60 },
            },
          ]);
        });

        it('two leads over their days, to a reader without HR-läs: two verdicts, one per member', async () => {
          arrangeCard([tyska(school(0, 1)), franskaLesson(school(0, 1))]);
          arrangeTeacherDay({
            limits: [
              { userId: TEACHER_ID, maxTeachingDaysPerWeek: 1 },
              { userId: FR_TEACHER, maxTeachingDaysPerWeek: 1 },
            ],
            week: [
              taught(LESSON_ID, 2, '09:00', '10:00'),
              taught(OTHER_LESSON_ID, 4, '08:00', '09:00'),
              taught(FR_LESSON, 2, '09:00', '10:00', { teacherId: FR_TEACHER }),
              taught('00000000-aaaa-4aaa-8aaa-0000000000a4', 5, '08:00', '09:00', { teacherId: FR_TEACHER }),
            ],
          });

          const result = await service.moveBlockCard(
            { lessonIds: [LESSON_ID, FR_LESSON], dayOfWeek: 2, startTime: '09:00', endTime: '10:00' } as never,
            scheduler(),
          );

          expect(result.warnings).toEqual([
            { code: 'TEACHER_WEEK_TOO_MANY_DAYS_HIDDEN', params: { role: 'LEAD', requirement: 'Tyska för Ty7' } },
            { code: 'TEACHER_WEEK_TOO_MANY_DAYS_HIDDEN', params: { role: 'LEAD', requirement: 'Franska för Fr7' } },
          ]);
          expect(recordedReads(tx)).toEqual([{ kind: 'EMPLOYMENT', channel: 'WEB', ids: [TEACHER_ID, FR_TEACHER] }]);
        });

        it('two warnings that say the same thing are one: members a toast cannot tell apart', async () => {
          // Two posts of one class whose subjects share a name: both members
          // are Tyska för Ty7, and both leads are over their day of one.
          arrangeCard([
            tyska(school(0, 1)),
            franskaLesson({ subject: { name: 'Tyska' }, studentGroup: { name: 'Ty7' }, ...school(0, 1) }),
          ]);
          arrangeTeacherDay({
            limits: [
              { userId: TEACHER_ID, maxTeachingDaysPerWeek: 1 },
              { userId: FR_TEACHER, maxTeachingDaysPerWeek: 1 },
            ],
            week: [
              taught(LESSON_ID, 2, '09:00', '10:00'),
              taught(OTHER_LESSON_ID, 4, '08:00', '09:00'),
              taught(FR_LESSON, 2, '09:00', '10:00', { teacherId: FR_TEACHER }),
              taught('00000000-aaaa-4aaa-8aaa-0000000000a4', 5, '08:00', '09:00', { teacherId: FR_TEACHER }),
            ],
          });

          const result = await service.moveBlockCard(
            { lessonIds: [LESSON_ID, FR_LESSON], dayOfWeek: 2, startTime: '09:00', endTime: '10:00' } as never,
            scheduler(),
          );

          expect(result.warnings).toEqual([
            { code: 'TEACHER_WEEK_TOO_MANY_DAYS_HIDDEN', params: { role: 'LEAD', requirement: 'Tyska för Ty7' } },
          ]);
          // Both posts told their verdict, and both reads are recorded.
          expect(recordedReads(tx)).toEqual([{ kind: 'EMPLOYMENT', channel: 'WEB', ids: [TEACHER_ID, FR_TEACHER] }]);
        });

        it('a card put back where it stood moves nobody’s day and asks nothing', async () => {
          arrangeCard([tyska(school(1)), franskaLesson({ coTeacherId: CO_TEACHER_ID, ...school(1) })]);
          arrangeTeacherDay({ caps, week: tuesday });

          const result = await move({ dayOfWeek: 1, startTime: '10:00', endTime: '11:00' });

          expect(result.warnings).toEqual([]);
          expect(tx.teacherWorkRule.findMany).not.toHaveBeenCalled();
        });

        it('a school without a rule: not one statement more, the gate counted in the card’s own read', async () => {
          arrangeCard([tyska(school(0)), franskaLesson({ coTeacherId: CO_TEACHER_ID, ...school(0) })]);
          arrangeTeacherDay({ caps, week: tuesday });

          await expect(move()).resolves.toMatchObject({ warnings: [] });
          expect(tx.teacherWorkRule.findMany).not.toHaveBeenCalled();
          expect(tx.teacherEmployment.findMany).not.toHaveBeenCalled();
          expect(weekReads()).toHaveLength(0);
          const cardRead = (tx.masterLesson.findMany.mock.calls as Array<[Query]>).find(
            ([query]) => query.where && 'id' in query.where && (query.where.id as Row).in,
          )![0];
          expect(cardRead.select!.school.select._count.select).toMatchObject({
            teacherWorkRules: { where: { maxTeachingMinutesPerDay: { not: null } } },
            teacherEmployments: {
              where: {
                maxTeachingDaysPerWeek: { not: null },
                academicYear: { is: { masterLessons: { some: { id: LESSON_ID } } } },
              },
            },
          });
        });

        it('the days of a card’s teacher, hidden from a schemaläggare without HR-läs and recorded', async () => {
          arrangeCard([tyska(school(0, 1)), franskaLesson(school(0, 1))]);
          arrangeTeacherDay({
            limits: [{ userId: FR_TEACHER, maxTeachingDaysPerWeek: 1 }],
            week: [
              taught(FR_LESSON, 2, '09:00', '10:00', { teacherId: FR_TEACHER }),
              taught(OTHER_LESSON_ID, 4, '08:00', '09:00', { teacherId: FR_TEACHER }),
            ],
          });

          const result = await service.moveBlockCard(
            { lessonIds: [LESSON_ID, FR_LESSON], dayOfWeek: 2, startTime: '09:00', endTime: '10:00' } as never,
            scheduler(),
          );

          expect(result.warnings).toEqual([
            { code: 'TEACHER_WEEK_TOO_MANY_DAYS_HIDDEN', params: { role: 'LEAD', requirement: 'Franska för Fr7' } },
          ]);
          expect(recordedReads(tx)).toEqual([{ kind: 'EMPLOYMENT', channel: 'WEB', ids: [FR_TEACHER] }]);
        });
      });
    });

    describe('lockBlock', () => {
      const lessons = [
        lessonRecord(),
        lessonRecord({ id: FR_LESSON, studentGroupId: FR_GROUP, subjectId: FR_SUBJECT, isLocked: true }),
        lessonRecord({ id: OTHER_LESSON_ID, dayOfWeek: 3 }),
        // On the tray: no placement to keep, and counted.
        lessonRecord({ id: CAL_LESSON_ID, isParked: true }),
      ];
      const arrangeLock = () => {
        tx.teachingBlock.findUnique.mockResolvedValue({
          id: BLOCK_ID,
          schoolId: SCHOOL_ID,
          academicYearId: YEAR_ID,
          requirements: [
            { studentGroupId: GROUP_ID, subjectId: SUBJECT_ID },
            { studentGroupId: FR_GROUP, subjectId: FR_SUBJECT },
          ],
        });
        tx.masterLesson.findMany.mockImplementation(answerRows(lessons));
      };

      it('locks every lesson of the block not already locked, in one statement, and answers those', async () => {
        arrangeLock();

        const result = await service.lockBlock({ blockId: BLOCK_ID, isLocked: true }, testUser());

        expect(tx.masterLesson.updateMany).toHaveBeenCalledWith({
          where: { id: { in: [LESSON_ID, OTHER_LESSON_ID] } },
          data: { isLocked: true },
        });
        expect(result).toEqual({ blockId: BLOCK_ID, isLocked: true, lessonIds: [LESSON_ID, OTHER_LESSON_ID], parked: 1 });
        expect(tx.scheduleChangeLog.create).toHaveBeenCalledTimes(2);
      });

      it('unlocks only the lessons an undo names, and refuses one that is not the block’s', async () => {
        arrangeLock();

        const result = await service.lockBlock(
          { blockId: BLOCK_ID, isLocked: false, lessonIds: [FR_LESSON] },
          testUser(),
        );
        expect(result.lessonIds).toEqual([FR_LESSON]);

        await expect(
          service.lockBlock({ blockId: BLOCK_ID, isLocked: true, lessonIds: [CAL_LESSON_ID] }, testUser()),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('writes nothing when every lesson is already as asked, and answers 404 for no block', async () => {
        arrangeLock();
        await service.lockBlock({ blockId: BLOCK_ID, isLocked: false, lessonIds: [LESSON_ID] }, testUser());
        expect(tx.masterLesson.updateMany).not.toHaveBeenCalled();
        expect(realtime.notifyMasterTimetableChanged).not.toHaveBeenCalled();

        tx.teachingBlock.findUnique.mockResolvedValue(null);
        await expect(service.lockBlock({ blockId: BLOCK_ID, isLocked: true }, testUser())).rejects.toBeInstanceOf(
          NotFoundException,
        );
      });
    });
  });
});

describe('teacherDayWarning', () => {
  const cap = { kind: 'DAILY_CAP' as const, dayOfWeek: 3, minutes: 330, cap: 300, lessonIds: ['a'] };
  const days = { kind: 'WORK_DAYS' as const, days: 4, max: 3, lessonIds: ['a', 'b'] };

  const SLOJD = ['Slöjd för 7A'];

  it('the cap’s figures go to every reader: the work rule is staff-readable', () => {
    const told = {
      code: 'TEACHER_DAY_TOO_LONG',
      params: { role: 'CO_TEACHER', requirement: 'Slöjd för 7A', day: 3, minutes: 330, cap: 300 },
    };
    expect(teacherDayWarning(cap, 'CO_TEACHER', SLOJD, true)).toEqual(told);
    expect(teacherDayWarning(cap, 'CO_TEACHER', SLOJD, false)).toEqual(told);
  });

  it('the days’ figures go to a reader with HR-läs, and the verdict alone to anybody else', () => {
    expect(teacherDayWarning(days, 'LEAD', SLOJD, true)).toEqual({
      code: 'TEACHER_WEEK_TOO_MANY_DAYS',
      params: { role: 'LEAD', requirement: 'Slöjd för 7A', days: 4, max: 3 },
    });
    expect(teacherDayWarning(days, 'LEAD', SLOJD, false)).toEqual({
      code: 'TEACHER_WEEK_TOO_MANY_DAYS_HIDDEN',
      params: { role: 'LEAD', requirement: 'Slöjd för 7A' },
    });
  });

  it('of several lessons, names the first as Swedish sorts them, whatever order they came in', () => {
    // Å before Ä in Swedish; a sort by code unit would put Ä first.
    const several = ['Ämnesval för 9A', 'Åttans tema för 8A', 'Tyska för Ty7'];
    expect(teacherDayWarning(days, 'LEAD', several, false).params.requirement).toBe('Tyska för Ty7');
    expect(teacherDayWarning(cap, 'LEAD', several.slice(0, 2), false).params.requirement).toBe('Åttans tema för 8A');
    expect(teacherDayWarning(cap, 'LEAD', [...several.slice(0, 2)].reverse(), false).params.requirement).toBe(
      'Åttans tema för 8A',
    );
  });
});
