import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  createPrismaMock,
  createTxMock,
  testUser,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { CalendarLessonsService } from './calendar-lessons.service';

const LESSON_ID = '44444444-4444-4444-8444-444444444444';
const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const GROUP_ID = '55555555-5555-4555-8555-555555555555';
const ROOM_ID = '66666666-6666-4666-8666-666666666666';
const NEW_ROOM_ID = '77777777-7777-4777-8777-777777777777';
const SUBJECT_ID = '88888888-8888-4888-8888-888888888888';
const TEACHER_ID = '99999999-9999-4999-8999-999999999999';
const SUB_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STUDENT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const GUARDIAN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const STARTS_AT = new Date('2026-08-10T08:00:00.000Z');
const ENDS_AT = new Date('2026-08-10T09:00:00.000Z');

describe('CalendarLessonsService', () => {
  let service: CalendarLessonsService;
  let tx: TxMock;
  let prisma: PrismaMock;
  let realtime: { notifyLessonChanged: jest.Mock };
  let notifications: { notifyUsers: jest.Mock; recipientsForGroups: jest.Mock };

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    realtime = { notifyLessonChanged: jest.fn().mockResolvedValue(undefined) };
    notifications = {
      notifyUsers: jest.fn().mockResolvedValue(2),
      recipientsForGroups: jest.fn().mockResolvedValue([STUDENT_ID, GUARDIAN_ID]),
    };
    service = new CalendarLessonsService(
      prisma as unknown as PrismaService,
      realtime as unknown as RealtimeService,
      notifications as unknown as NotificationsService,
    );
  });

  /** The shape `requireLesson` selects. */
  const baseLesson = (overrides: Record<string, unknown> = {}) => ({
    id: LESSON_ID,
    schoolId: SCHOOL_ID,
    status: 'SCHEDULED',
    note: null,
    date: new Date('2026-08-10T00:00:00.000Z'),
    startsAt: STARTS_AT,
    endsAt: ENDS_AT,
    roomId: ROOM_ID,
    subjectId: SUBJECT_ID,
    studentGroupId: GROUP_ID,
    subject: { name: 'Mathematics' },
    teachers: [{ teacherId: TEACHER_ID }],
    ...overrides,
  });

  describe('cancel', () => {
    const arrangeCancel = (overrides: Record<string, unknown> = {}) => {
      tx.calendarLesson.findUnique.mockResolvedValue(baseLesson(overrides));
      tx.calendarLesson.update.mockImplementation(({ data }: any) =>
        Promise.resolve({ id: LESSON_ID, status: data.status, note: data.note }),
      );
    };

    it('cancels a scheduled lesson, storing the reason as the note', async () => {
      arrangeCancel();
      const user = testUser();

      await expect(
        service.cancel(LESSON_ID, { reason: 'Fire drill' }, user),
      ).resolves.toEqual({ id: LESSON_ID, status: 'CANCELLED', note: 'Fire drill' });

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(prisma.withSystemTransaction).not.toHaveBeenCalled();
      expect(tx.calendarLesson.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: LESSON_ID },
          data: { status: 'CANCELLED', note: 'Fire drill' },
        }),
      );
    });

    it('keeps the existing note when no reason is given', async () => {
      arrangeCancel({ note: 'Bring calculators' });

      await service.cancel(LESSON_ID, {}, testUser());

      expect(tx.calendarLesson.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: 'CANCELLED', note: 'Bring calculators' },
        }),
      );
    });

    it('broadcasts the change and notifies the class plus the assigned teachers', async () => {
      arrangeCancel();

      await service.cancel(LESSON_ID, { reason: 'Fire drill' }, testUser());

      expect(realtime.notifyLessonChanged).toHaveBeenCalledWith(tx, LESSON_ID);
      expect(notifications.recipientsForGroups).toHaveBeenCalledWith(tx, [GROUP_ID]);
      expect(notifications.notifyUsers).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          schoolId: SCHOOL_ID,
          userIds: [STUDENT_ID, GUARDIAN_ID, TEACHER_ID],
          type: 'LESSON_CANCELLED',
          meta: {
            subjectName: 'Mathematics',
            startsAt: '2026-08-10T08:00:00.000Z',
          },
          email: {
            subject: 'Lesson cancelled: Mathematics',
            body: expect.stringContaining('Reason: Fire drill'),
          },
        }),
      );
    });

    it('deduplicates a teacher who is also a group recipient', async () => {
      arrangeCancel();
      notifications.recipientsForGroups.mockResolvedValue([STUDENT_ID, TEACHER_ID]);

      await service.cancel(LESSON_ID, {}, testUser());

      expect(notifications.notifyUsers).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ userIds: [STUDENT_ID, TEACHER_ID] }),
      );
    });

    it.each(['CANCELLED', 'COMPLETED', 'RESCHEDULED'])(
      'refuses to cancel a %s lesson',
      async (status) => {
        arrangeCancel({ status });

        await expect(service.cancel(LESSON_ID, {}, testUser())).rejects.toThrow(
          'Only scheduled lessons can be cancelled.',
        );
        expect(tx.calendarLesson.update).not.toHaveBeenCalled();
        expect(notifications.notifyUsers).not.toHaveBeenCalled();
      },
    );

    it('404s on an unknown lesson', async () => {
      tx.calendarLesson.findUnique.mockResolvedValue(null);

      await expect(service.cancel(LESSON_ID, {}, testUser())).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('reinstate', () => {
    it('re-schedules a cancelled lesson and broadcasts, without notifying', async () => {
      tx.calendarLesson.findUnique.mockResolvedValue(baseLesson({ status: 'CANCELLED' }));
      tx.calendarLesson.update.mockResolvedValue({
        id: LESSON_ID,
        status: 'SCHEDULED',
        note: null,
      });
      const user = testUser();

      await expect(service.reinstate(LESSON_ID, user)).resolves.toEqual({
        id: LESSON_ID,
        status: 'SCHEDULED',
        note: null,
      });

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.calendarLesson.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: LESSON_ID },
          data: { status: 'SCHEDULED' },
        }),
      );
      expect(realtime.notifyLessonChanged).toHaveBeenCalledWith(tx, LESSON_ID);
      expect(notifications.notifyUsers).not.toHaveBeenCalled();
    });

    it.each(['SCHEDULED', 'COMPLETED', 'RESCHEDULED'])(
      'refuses to reinstate a %s lesson',
      async (status) => {
        tx.calendarLesson.findUnique.mockResolvedValue(baseLesson({ status }));

        await expect(service.reinstate(LESSON_ID, testUser())).rejects.toThrow(
          'Only cancelled lessons can be reinstated.',
        );
        expect(tx.calendarLesson.update).not.toHaveBeenCalled();
      },
    );

    it('404s on an unknown lesson', async () => {
      tx.calendarLesson.findUnique.mockResolvedValue(null);

      await expect(service.reinstate(LESSON_ID, testUser())).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('assignSubstitute', () => {
    const arrangeAssign = (overrides: Record<string, unknown> = {}) => {
      tx.calendarLesson.findUnique.mockResolvedValue(baseLesson(overrides));
      tx.user.findUnique.mockResolvedValue({
        id: SUB_ID,
        role: 'TEACHER',
        isActive: true,
      });
      tx.calendarLesson.findFirst.mockResolvedValue(null); // no clash
      tx.calendarLesson.update.mockResolvedValue({
        id: LESSON_ID,
        status: 'SCHEDULED',
        note: null,
      });
    };

    it('replaces all assignments with a single SUBSTITUTE row in the lesson tenant', async () => {
      arrangeAssign();
      const user = testUser();

      await expect(
        service.assignSubstitute(LESSON_ID, { teacherId: SUB_ID }, user),
      ).resolves.toEqual({ id: LESSON_ID, status: 'SCHEDULED', note: null });

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.calendarLessonTeacher.deleteMany).toHaveBeenCalledWith({
        where: { calendarLessonId: LESSON_ID },
      });
      expect(tx.calendarLessonTeacher.create).toHaveBeenCalledWith({
        data: {
          schoolId: SCHOOL_ID,
          calendarLessonId: LESSON_ID,
          teacherId: SUB_ID,
          role: 'SUBSTITUTE',
        },
      });
    });

    it('checks the substitute for overlap against other scheduled lessons only', async () => {
      arrangeAssign();

      await service.assignSubstitute(LESSON_ID, { teacherId: SUB_ID }, testUser());

      expect(tx.calendarLesson.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: { not: LESSON_ID },
            status: 'SCHEDULED',
            startsAt: { lt: ENDS_AT },
            endsAt: { gt: STARTS_AT },
            teachers: { some: { teacherId: SUB_ID } },
          },
        }),
      );
    });

    it('stores the note only when one is provided', async () => {
      arrangeAssign();

      await service.assignSubstitute(LESSON_ID, { teacherId: SUB_ID }, testUser());
      expect(tx.calendarLesson.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: {} }),
      );

      await service.assignSubstitute(
        LESSON_ID,
        { teacherId: SUB_ID, note: 'Covering for illness' },
        testUser(),
      );
      expect(tx.calendarLesson.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: { note: 'Covering for illness' } }),
      );
    });

    it('notifies the class, the outgoing teacher and the substitute', async () => {
      arrangeAssign();

      await service.assignSubstitute(LESSON_ID, { teacherId: SUB_ID }, testUser());

      expect(realtime.notifyLessonChanged).toHaveBeenCalledWith(tx, LESSON_ID);
      expect(notifications.notifyUsers).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          schoolId: SCHOOL_ID,
          userIds: [STUDENT_ID, GUARDIAN_ID, TEACHER_ID, SUB_ID],
          type: 'LESSON_SUBSTITUTE',
          email: expect.objectContaining({
            subject: 'Substitute assigned: Mathematics',
          }),
        }),
      );
    });

    it.each([
      ['unknown', null],
      ['inactive', { id: SUB_ID, role: 'TEACHER', isActive: false }],
      ['non-teacher', { id: SUB_ID, role: 'STUDENT', isActive: true }],
    ])('rejects an %s substitute', async (_label, substitute) => {
      arrangeAssign();
      tx.user.findUnique.mockResolvedValue(substitute);

      await expect(
        service.assignSubstitute(LESSON_ID, { teacherId: SUB_ID }, testUser()),
      ).rejects.toThrow('The substitute must be an active teacher.');
      expect(tx.calendarLessonTeacher.deleteMany).not.toHaveBeenCalled();
    });

    it('rejects a substitute who already teaches an overlapping lesson', async () => {
      arrangeAssign();
      tx.calendarLesson.findFirst.mockResolvedValue({ id: 'clashing-lesson' });

      await expect(
        service.assignSubstitute(LESSON_ID, { teacherId: SUB_ID }, testUser()),
      ).rejects.toThrow(ConflictException);
      expect(tx.calendarLessonTeacher.deleteMany).not.toHaveBeenCalled();
      expect(tx.calendarLessonTeacher.create).not.toHaveBeenCalled();
    });

    it('refuses to reassign a completed lesson before looking anyone up', async () => {
      arrangeAssign({ status: 'COMPLETED' });

      await expect(
        service.assignSubstitute(LESSON_ID, { teacherId: SUB_ID }, testUser()),
      ).rejects.toThrow('Completed lessons cannot be reassigned.');
      expect(tx.user.findUnique).not.toHaveBeenCalled();
    });

    it('404s on an unknown lesson', async () => {
      tx.calendarLesson.findUnique.mockResolvedValue(null);

      await expect(
        service.assignSubstitute(LESSON_ID, { teacherId: SUB_ID }, testUser()),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('changeRoom', () => {
    const arrangeMove = (overrides: Record<string, unknown> = {}) => {
      tx.calendarLesson.findUnique.mockResolvedValue(baseLesson(overrides));
      tx.room.findUnique.mockResolvedValue({ id: NEW_ROOM_ID });
      tx.calendarLesson.findFirst.mockResolvedValue(null);
      tx.roomBooking.findFirst.mockResolvedValue(null);
      tx.calendarLesson.update.mockImplementation(({ data }: any) =>
        Promise.resolve({ id: LESSON_ID, status: 'SCHEDULED', note: data.note ?? null }),
      );
    };

    it('moves the lesson to a free room and notifies the audience', async () => {
      arrangeMove();
      const user = testUser();

      await expect(
        service.changeRoom(LESSON_ID, { roomId: NEW_ROOM_ID }, user),
      ).resolves.toEqual({ id: LESSON_ID, status: 'SCHEDULED', note: null });

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.calendarLesson.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: LESSON_ID },
          data: { roomId: NEW_ROOM_ID },
        }),
      );
      expect(realtime.notifyLessonChanged).toHaveBeenCalledWith(tx, LESSON_ID);
      expect(notifications.notifyUsers).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ type: 'LESSON_ROOM_CHANGED' }),
      );
    });

    it('excludes the lesson itself from the clash check and only counts APPROVED bookings', async () => {
      arrangeMove();

      await service.changeRoom(LESSON_ID, { roomId: NEW_ROOM_ID }, testUser());

      expect(tx.calendarLesson.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: { not: LESSON_ID },
            status: 'SCHEDULED',
            roomId: NEW_ROOM_ID,
            startsAt: { lt: ENDS_AT },
            endsAt: { gt: STARTS_AT },
          },
        }),
      );
      // PENDING self-service bookings do not block a lesson move.
      expect(tx.roomBooking.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            roomId: NEW_ROOM_ID,
            status: 'APPROVED',
            startsAt: { lt: ENDS_AT },
            endsAt: { gt: STARTS_AT },
          },
        }),
      );
    });

    it('is a silent no-op when the room is unchanged and no note is given', async () => {
      arrangeMove({ note: 'unchanged' });

      await expect(
        service.changeRoom(LESSON_ID, { roomId: ROOM_ID }, testUser()),
      ).resolves.toEqual({ id: LESSON_ID, status: 'SCHEDULED', note: 'unchanged' });

      expect(tx.calendarLesson.update).not.toHaveBeenCalled();
      expect(realtime.notifyLessonChanged).not.toHaveBeenCalled();
      expect(notifications.notifyUsers).not.toHaveBeenCalled();
    });

    it('same room with a note is not a no-op and records the note', async () => {
      arrangeMove();
      tx.room.findUnique.mockResolvedValue({ id: ROOM_ID });

      await service.changeRoom(
        LESSON_ID,
        { roomId: ROOM_ID, note: 'Projector broken' },
        testUser(),
      );

      expect(tx.calendarLesson.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { roomId: ROOM_ID, note: 'Projector broken' },
        }),
      );
    });

    it('clears the room without running any availability checks', async () => {
      arrangeMove();

      await service.changeRoom(LESSON_ID, { roomId: null }, testUser());

      expect(tx.calendarLesson.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { roomId: null } }),
      );
      expect(tx.room.findUnique).not.toHaveBeenCalled();
      expect(tx.calendarLesson.findFirst).not.toHaveBeenCalled();
      expect(tx.roomBooking.findFirst).not.toHaveBeenCalled();
    });

    it('rejects an unknown target room', async () => {
      arrangeMove();
      tx.room.findUnique.mockResolvedValue(null);

      await expect(
        service.changeRoom(LESSON_ID, { roomId: NEW_ROOM_ID }, testUser()),
      ).rejects.toThrow('Room not found.');
      expect(tx.calendarLesson.update).not.toHaveBeenCalled();
    });

    it('rejects a room held by another scheduled lesson', async () => {
      arrangeMove();
      tx.calendarLesson.findFirst.mockResolvedValue({ id: 'other-lesson' });

      await expect(
        service.changeRoom(LESSON_ID, { roomId: NEW_ROOM_ID }, testUser()),
      ).rejects.toThrow('That room is already booked by another lesson at this time.');
      expect(tx.calendarLesson.update).not.toHaveBeenCalled();
    });

    it('rejects a room reserved by an approved self-service booking', async () => {
      arrangeMove();
      tx.roomBooking.findFirst.mockResolvedValue({ id: 'approved-booking' });

      await expect(
        service.changeRoom(LESSON_ID, { roomId: NEW_ROOM_ID }, testUser()),
      ).rejects.toThrow('That room is reserved by an approved booking at this time.');
      expect(tx.calendarLesson.update).not.toHaveBeenCalled();
    });

    it('refuses to change a completed lesson', async () => {
      arrangeMove({ status: 'COMPLETED' });

      await expect(
        service.changeRoom(LESSON_ID, { roomId: NEW_ROOM_ID }, testUser()),
      ).rejects.toThrow('Completed lessons cannot be changed.');
    });

    it('404s on an unknown lesson', async () => {
      tx.calendarLesson.findUnique.mockResolvedValue(null);

      await expect(
        service.changeRoom(LESSON_ID, { roomId: NEW_ROOM_ID }, testUser()),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('suggestSubstitutes', () => {
    const PRIMARY_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const OTHER_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const CO_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const OTHER_GROUP_ID = '12121212-1212-4212-8212-121212121212';

    it('ranks class-and-subject teachers first, drops assigned and busy ones', async () => {
      tx.calendarLesson.findUnique.mockResolvedValue(baseLesson());
      tx.teachingRequirement.findMany.mockResolvedValue([
        // Teaches this exact class+subject → primary.
        { teacherId: PRIMARY_ID, coTeacherId: null, studentGroupId: GROUP_ID },
        // Teaches the subject elsewhere → fallbacks (incl. the co-teacher).
        { teacherId: OTHER_ID, coTeacherId: CO_ID, studentGroupId: OTHER_GROUP_ID },
        // Already assigned to this lesson → never suggested.
        { teacherId: TEACHER_ID, coTeacherId: null, studentGroupId: GROUP_ID },
      ]);
      tx.user.findMany.mockResolvedValue([
        { id: OTHER_ID },
        { id: PRIMARY_ID },
        { id: CO_ID },
      ]);
      // CO_ID is busy at the lesson's time; everyone else is free.
      tx.calendarLesson.findFirst.mockImplementation(({ where }: any) =>
        Promise.resolve(
          where.teachers.some.teacherId === CO_ID ? { id: 'clash' } : null,
        ),
      );
      const user = testUser();

      await expect(service.suggestSubstitutes(LESSON_ID, user)).resolves.toEqual([
        { teacherId: PRIMARY_ID, isPrimary: true },
        { teacherId: OTHER_ID, isPrimary: false },
      ]);

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.teachingRequirement.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { subjectId: SUBJECT_ID } }),
      );
      expect(tx.user.findMany).toHaveBeenCalledWith({
        where: {
          id: { in: [PRIMARY_ID, OTHER_ID, CO_ID] },
          role: 'TEACHER',
          isActive: true,
        },
        select: { id: true },
      });
      // The already-assigned teacher must not even be queried.
      const queried = tx.user.findMany.mock.calls[0][0].where.id.in as string[];
      expect(queried).not.toContain(TEACHER_ID);
    });

    it('returns [] without querying users when nobody else is qualified', async () => {
      tx.calendarLesson.findUnique.mockResolvedValue(baseLesson());
      tx.teachingRequirement.findMany.mockResolvedValue([
        { teacherId: TEACHER_ID, coTeacherId: null, studentGroupId: GROUP_ID },
      ]);

      await expect(service.suggestSubstitutes(LESSON_ID, testUser())).resolves.toEqual([]);
      expect(tx.user.findMany).not.toHaveBeenCalled();
    });

    it('returns [] when no requirements exist for the subject', async () => {
      tx.calendarLesson.findUnique.mockResolvedValue(baseLesson());
      tx.teachingRequirement.findMany.mockResolvedValue([]);

      await expect(service.suggestSubstitutes(LESSON_ID, testUser())).resolves.toEqual([]);
    });

    it('404s on an unknown lesson', async () => {
      tx.calendarLesson.findUnique.mockResolvedValue(null);

      await expect(service.suggestSubstitutes(LESSON_ID, testUser())).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // Not covered deliberately: assignSubstitute/changeRoom on a CANCELLED
  // lesson are allowed by the code (only COMPLETED is blocked). That looks
  // intentional (prepare a lesson before reinstating it), so no test pins it
  // either way.
  it('rejects with BadRequestException, not a plain Error, on state violations', async () => {
    tx.calendarLesson.findUnique.mockResolvedValue(baseLesson({ status: 'COMPLETED' }));

    await expect(service.cancel(LESSON_ID, {}, testUser())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
