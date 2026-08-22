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
const CAL_LESSON_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_CAL_LESSON_ID = '11111111-2222-4333-8444-666666666666';
/** testUser()'s default userId — the audit-trail actor. */
const USER_ID = '22222222-2222-4222-8222-222222222222';

/** "HH:MM" → the Date shape Prisma returns for a `@db.Time` column. */
const t = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`);

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
    tx.masterLesson.findMany.mockResolvedValue([]);
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
    startTime: t('10:30'),
    endTime: t('11:30'),
    subject: { name: 'Math' },
    extraGroups: [] as Array<{ studentGroupId: string }>,
    participants: [] as Array<{ studentId: string }>,
    ...overrides,
  });

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
      tx.academicYear.findUnique.mockResolvedValue({
        id: YEAR_ID,
        schoolId: SCHOOL_ID,
      });
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
          roomId: ROOM_ID,
          dayOfWeek: 1,
          startTime: new Date('1970-01-01T10:00:00.000Z'),
          endTime: new Date('1970-01-01T11:00:00.000Z'),
          isLocked: false,
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
      ).rejects.toThrow(NotFoundException);
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

    // SUSPECTED BUG: unlike studentIds (deduped via `new Set` one line below),
    // extraGroupIds are passed through as-is. MasterLessonGroups has
    // @@unique([masterLessonId, studentGroupId]), so a payload with the same
    // group twice makes the nested create violate the constraint — a Prisma
    // P2002 surfacing as a 500 instead of a clean 400/409. Pinning current
    // behaviour; do not "fix" this test without fixing the service.
    it('currently forwards duplicate extraGroupIds to the nested create (suspected bug)', async () => {
      arrangeCreate();

      await service.create(
        createDto({ extraGroupIds: [EXTRA_GROUP_ID, EXTRA_GROUP_ID] }),
        testUser(),
      );

      expect(tx.masterLesson.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            extraGroups: {
              create: [
                { schoolId: SCHOOL_ID, studentGroupId: EXTRA_GROUP_ID },
                { schoolId: SCHOOL_ID, studentGroupId: EXTRA_GROUP_ID },
              ],
            },
          }),
        }),
      );
    });

    it('scans conflicts across the whole year without excluding any lesson', async () => {
      arrangeCreate();

      await service.create(createDto(), testUser());

      expect(tx.masterLesson.findMany).toHaveBeenCalledWith({
        where: { academicYearId: YEAR_ID, dayOfWeek: 1 },
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
      tx.masterLesson.findMany.mockResolvedValue([
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
      tx.masterLesson.findMany.mockResolvedValue([
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
      tx.masterLesson.findMany.mockResolvedValue([
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
      tx.masterLesson.findMany.mockResolvedValue([
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
      tx.masterLesson.findMany.mockResolvedValue([
        otherLesson({ studentGroupId: EXTRA_GROUP_ID }),
      ]);

      await expect(
        service.create(
          createDto({ extraGroupIds: [EXTRA_GROUP_ID] }),
          testUser(),
        ),
      ).rejects.toThrow(ConflictException);
    });

    it("409s when the primary group is among the other lesson's extra groups", async () => {
      arrangeCreate();
      tx.masterLesson.findMany.mockResolvedValue([
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
      tx.masterLesson.findMany.mockResolvedValue([
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
      tx.masterLesson.findMany.mockResolvedValue([
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
      tx.masterLesson.findMany.mockResolvedValue([
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
      tx.masterLesson.findMany.mockResolvedValue([
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
      tx.masterLesson.findMany.mockResolvedValue([otherLesson()]);

      await expect(
        service.create(createDto({ studentIds: [STUDENT_ID] }), testUser()),
      ).resolves.toMatchObject({ id: LESSON_ID });
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
      tx.masterLesson.findUnique.mockResolvedValue(
        storedLesson(lessonOverrides),
      );
      tx.masterLesson.update.mockResolvedValue(lessonRecord(updatedOverrides));
    };

    it('404s on an unknown lesson', async () => {
      tx.masterLesson.findUnique.mockResolvedValue(null);

      await expect(
        service.update(LESSON_ID, { dayOfWeek: 2 }, testUser()),
      ).rejects.toThrow(NotFoundException);
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
      ).rejects.toThrow(BadRequestException);
      expect(tx.masterLesson.update).not.toHaveBeenCalled();
    });

    it("409s when the stored co-teacher clashes, without updating", async () => {
      arrangeUpdate({ coTeacherId: CO_TEACHER_ID });
      tx.masterLesson.findMany.mockResolvedValue([
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
      // timezone on the way in.
      expect(tx.masterLesson.update).toHaveBeenCalledWith({
        where: { id: LESSON_ID },
        data: {
          dayOfWeek: 1,
          endDate: new Date('2026-09-07T00:00:00.000Z'),
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

    // SUSPECTED BUG (lower confidence): recipients are computed from the
    // PRE-update extraGroups snapshot, so a class added by this very update
    // never hears about the moved lessons it now attends. Pinning current
    // behaviour.
    it('currently notifies the pre-update group list, not the new one (suspected bug)', async () => {
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
        EXTRA_GROUP_ID, // the replaced group — not OTHER_EXTRA_GROUP_ID
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
  });

  // -------------------------------------------------------------------
  // remove
  // -------------------------------------------------------------------

  describe('remove', () => {
    const arrangeRemove = () => {
      tx.masterLesson.findUnique.mockResolvedValue({
        ...lessonRecord(),
        schoolId: SCHOOL_ID,
      });
      tx.calendarLesson.deleteMany.mockResolvedValue({ count: 3 });
    };

    it('404s on an unknown lesson and deletes nothing', async () => {
      tx.masterLesson.findUnique.mockResolvedValue(null);

      await expect(service.remove(LESSON_ID, testUser())).rejects.toThrow(
        NotFoundException,
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
