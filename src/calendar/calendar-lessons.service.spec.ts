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

/*
 * The database as Prisma answers it.
 *
 * A stub that resolves a whole row hands the service every column whether its
 * query asked for it or not, so a `select` that forgot a column the service
 * goes on to read passes here and fails in production as `undefined`. These
 * answer the way Prisma 5 does: only the selected columns come back, a select
 * with nothing truthy in it is refused before anything is read, a relation
 * named as `{}` comes back whole, and a findUnique or update without its key
 * is refused.
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

/** findFirst: the query is validated whether or not anything is found. */
const answerFirst =
  (hit: Row | null) =>
  (query: Query = {}) => {
    refuseEmptySelect(query.select);
    return Promise.resolve(hit ? project(hit, query.select) : null);
  };

/** update by id: the stored row with the write applied, as selected. */
const answerUpdate =
  (stored: Row) =>
  (query: Query = {}) => {
    refuseEmptySelect(query.select);
    if (query.where?.id === undefined) {
      throw new Error('Prisma refuses an update without its unique key.');
    }
    return Promise.resolve(project({ ...stored, ...query.data }, query.select));
  };

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

  /** The lesson as the database holds it; `requireLesson` reads it by id. */
  const storeLesson = (overrides: Record<string, unknown> = {}) =>
    tx.calendarLesson.findUnique.mockImplementation(answerById([baseLesson(overrides)]));

  describe('cancel', () => {
    const arrangeCancel = (overrides: Record<string, unknown> = {}) => {
      storeLesson(overrides);
      tx.calendarLesson.update.mockImplementation(answerUpdate(baseLesson(overrides)));
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
          data: { status: 'CANCELLED', note: 'Fire drill', cancelCause: 'MANUAL' },
        }),
      );
    });

    it('records the cause the caller names, and MANUAL when it names none', async () => {
      // The teacher-absence page says why; the free-text reason stays the
      // note pupils read, and is never a category.
      arrangeCancel();
      await expect(
        service.cancel(LESSON_ID, { reason: 'Sjuk', cause: 'TEACHER_UNAVAILABLE' }, testUser()),
      ).resolves.toEqual({ id: LESSON_ID, status: 'CANCELLED', note: 'Sjuk' });
      expect(tx.calendarLesson.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: 'CANCELLED', note: 'Sjuk', cancelCause: 'TEACHER_UNAVAILABLE' },
        }),
      );
    });

    it('keeps the existing note when no reason is given', async () => {
      arrangeCancel({ note: 'Bring calculators' });

      await service.cancel(LESSON_ID, {}, testUser());

      expect(tx.calendarLesson.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: 'CANCELLED', note: 'Bring calculators', cancelCause: 'MANUAL' },
        }),
      );
      // And the email says no more than it was told: no reason, no "Reason:".
      expect(notifications.notifyUsers).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          email: {
            subject: 'Lesson cancelled: Mathematics',
            body: 'Mathematics on 2026-08-10T08:00:00.000Z has been cancelled.',
          },
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
        new NotFoundException('Lesson not found.'),
      );
    });
  });

  describe('reinstate', () => {
    it('re-schedules a cancelled lesson and broadcasts, without notifying', async () => {
      storeLesson({ status: 'CANCELLED' });
      tx.calendarLesson.update.mockImplementation(
        answerUpdate(baseLesson({ status: 'CANCELLED' })),
      );
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
          // Held after all: the cause of a cancellation that no longer is goes.
          data: { status: 'SCHEDULED', cancelCause: null },
        }),
      );
      expect(realtime.notifyLessonChanged).toHaveBeenCalledWith(tx, LESSON_ID);
      expect(notifications.notifyUsers).not.toHaveBeenCalled();
    });

    it.each(['SCHEDULED', 'COMPLETED', 'RESCHEDULED'])(
      'refuses to reinstate a %s lesson',
      async (status) => {
        storeLesson({ status });

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
      storeLesson(overrides);
      tx.user.findUnique.mockImplementation(
        answerById([{ id: SUB_ID, role: 'TEACHER', isActive: true }]),
      );
      tx.calendarLesson.findFirst.mockImplementation(answerFirst(null)); // no clash
      tx.calendarLesson.update.mockImplementation(answerUpdate(baseLesson(overrides)));
    };

    it('replaces all assignments with a single SUBSTITUTE row in the lesson tenant', async () => {
      arrangeAssign();
      const user = testUser();

      await expect(
        service.assignSubstitute(LESSON_ID, { teacherId: SUB_ID }, user),
      ).resolves.toEqual({ id: LESSON_ID, status: 'SCHEDULED', note: null, warnings: [] });

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

    /*
     * A vikarie is asked the staffing policy's behörighet question for this
     * class and subject on the lesson's own date — and is never refused: under
     * REFUSE the finding comes back as a warning and the cover is assigned.
     */
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
        tx.subject.findUnique.mockResolvedValue({ name: 'Engelska' });
        // The lesson's year, asked with its class as a relation filter.
        tx.academicYear.findFirst.mockResolvedValue({ id: 'year-1', isActive: true, predecessorId: null });
        tx.studentGroup.findMany.mockResolvedValue([{ id: GROUP_ID, gradeLevel: 5 }]);
      };
      const held = (overrides: Record<string, unknown> = {}) => ({
        userId: SUB_ID,
        subjectId: SUBJECT_ID,
        minGradeLevel: 4,
        maxGradeLevel: 6,
        kind: 'BEHORIG',
        validFrom: null,
        validTo: null,
        ...overrides,
      });

      it('REFUSE warns and still assigns: an obehörig vikarie is the rektor’s call, not a refusal at 07:45', async () => {
        arrangeAssign();
        arrangePolicy('REFUSE', [held({ userId: 'someone-else' })]);

        await expect(
          service.assignSubstitute(LESSON_ID, { teacherId: SUB_ID }, testUser()),
        ).resolves.toMatchObject({
          warnings: [
            { code: 'STAFF_TEACHER_NOT_QUALIFIED', params: { role: 'SUBSTITUTE', subject: 'Engelska', grades: '5' } },
          ],
        });
        expect(tx.calendarLessonTeacher.create).toHaveBeenCalledTimes(1);
      });

      it('asks about the lesson’s whole attendance: an extra åk 7 group widens the class’s 5 to 5–7', async () => {
        // A combined lesson. The master-lesson PATCH already derived the span
        // from every group and named pupil; the vikarie path read the main
        // group alone, so a 4–6 behörighet passed for åk 7 pupils unsaid.
        const EXTRA_GROUP = '15151515-1515-4515-8515-151515151515';
        arrangeAssign({ extraGroups: [{ studentGroupId: EXTRA_GROUP }], participants: [] });
        arrangePolicy('WARN', [held()]);
        tx.studentGroup.findMany.mockResolvedValue([
          { id: GROUP_ID, gradeLevel: 5 },
          { id: EXTRA_GROUP, gradeLevel: 7 },
        ]);

        const result = await service.assignSubstitute(LESSON_ID, { teacherId: SUB_ID }, testUser());

        expect(result.warnings).toEqual([
          { code: 'STAFF_TEACHER_NOT_QUALIFIED', params: { role: 'SUBSTITUTE', subject: 'Engelska', grades: '5–7' } },
        ]);
      });

      it('reads validity on the lesson’s date, not over the year', async () => {
        arrangeAssign();
        // Valid from the day after the lesson (2026-08-10).
        arrangePolicy('WARN', [held({ validFrom: new Date('2026-08-11T00:00:00.000Z') })]);

        const result = await service.assignSubstitute(LESSON_ID, { teacherId: SUB_ID }, testUser());

        expect(result.warnings).toHaveLength(1);
      });

      it('a vikarie behörig for the class on the day has nothing said about them', async () => {
        arrangeAssign();
        arrangePolicy('REFUSE', [held()]);

        await expect(
          service.assignSubstitute(LESSON_ID, { teacherId: SUB_ID }, testUser()),
        ).resolves.toMatchObject({ warnings: [] });
      });

      it('OFF asks nothing', async () => {
        arrangeAssign();
        arrangePolicy('OFF', [held({ userId: 'someone-else' })]);

        await expect(
          service.assignSubstitute(LESSON_ID, { teacherId: SUB_ID }, testUser()),
        ).resolves.toMatchObject({ warnings: [] });
        expect(tx.teacherSubjectQualification.findMany).not.toHaveBeenCalled();
      });
    });

    it('leaves a CANCELLED lesson cancelled when a substitute is put on it through the API', async () => {
      // The UIs offer a vikarie on scheduled rows only; the API allows it on a
      // cancelled one. Neither the status nor the cause moves, so the
      // timplan's genomförd tid keeps counting the lesson as lost — the
      // school cancelled it, and a teacher row does not hold it.
      arrangeAssign({ status: 'CANCELLED', cancelCause: 'TEACHER_UNAVAILABLE' });

      await service.assignSubstitute(LESSON_ID, { teacherId: SUB_ID }, testUser());

      const writes = tx.calendarLesson.update.mock.calls.map(([query]) => (query as { data: object }).data);
      expect(writes).toEqual([{}]);
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
          email: {
            subject: 'Substitute assigned: Mathematics',
            body: 'Mathematics on 2026-08-10T08:00:00.000Z will be covered by a substitute teacher.',
          },
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
      ).rejects.toThrow(
        new ConflictException('The substitute already teaches another lesson at this time.'),
      );
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
      storeLesson(overrides);
      tx.room.findUnique.mockImplementation(answerById([{ id: NEW_ROOM_ID }]));
      tx.calendarLesson.findFirst.mockImplementation(answerFirst(null));
      tx.roomBooking.findFirst.mockImplementation(answerFirst(null));
      tx.calendarLesson.update.mockImplementation(answerUpdate(baseLesson(overrides)));
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
      // The class and the lesson's own teachers, told what moved and when.
      expect(notifications.notifyUsers).toHaveBeenCalledWith(tx, {
        schoolId: SCHOOL_ID,
        userIds: [STUDENT_ID, GUARDIAN_ID, TEACHER_ID],
        type: 'LESSON_ROOM_CHANGED',
        meta: { subjectName: 'Mathematics', startsAt: '2026-08-10T08:00:00.000Z' },
        email: {
          subject: 'Room changed: Mathematics',
          body: 'Mathematics on 2026-08-10T08:00:00.000Z has moved to a different room.',
        },
      });
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

    beforeEach(() => {
      // A school that has recorded no behörighet at all: the picker runs on
      // the requirement heuristic alone, exactly as it did before the table
      // existed. The tests below that are about qualifications say so.
      tx.teacherSubjectQualification.count.mockResolvedValue(0);
    });

    it('ranks class-and-subject teachers first, drops assigned and busy ones', async () => {
      storeLesson();
      tx.teachingRequirement.findMany.mockImplementation(answerRows([
        // Teaches this exact class+subject → primary.
        { teacherId: PRIMARY_ID, coTeacherId: null, studentGroupId: GROUP_ID },
        // Teaches the subject elsewhere → fallbacks (incl. the co-teacher).
        { teacherId: OTHER_ID, coTeacherId: CO_ID, studentGroupId: OTHER_GROUP_ID },
        // Already assigned to this lesson → never suggested.
        { teacherId: TEACHER_ID, coTeacherId: null, studentGroupId: GROUP_ID },
      ]));
      tx.user.findMany.mockResolvedValue([
        { id: OTHER_ID },
        { id: PRIMARY_ID },
        { id: CO_ID },
      ]);
      // CO_ID is busy at the lesson's time; everyone else is free.
      tx.calendarLesson.findFirst.mockImplementation((query: Query) =>
        answerFirst(query.where?.teachers.some.teacherId === CO_ID ? { id: 'clash' } : null)(
          query,
        ),
      );
      const user = testUser();

      await expect(service.suggestSubstitutes(LESSON_ID, user)).resolves.toEqual([
        { teacherId: PRIMARY_ID, isPrimary: true, qualificationKind: null },
        { teacherId: OTHER_ID, isPrimary: false, qualificationKind: null },
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
      storeLesson();
      tx.teachingRequirement.findMany.mockResolvedValue([
        { teacherId: TEACHER_ID, coTeacherId: null, studentGroupId: GROUP_ID },
      ]);

      await expect(service.suggestSubstitutes(LESSON_ID, testUser())).resolves.toEqual([]);
      expect(tx.user.findMany).not.toHaveBeenCalled();
    });

    it('returns [] when no requirements exist for the subject', async () => {
      storeLesson();
      tx.teachingRequirement.findMany.mockResolvedValue([]);

      await expect(service.suggestSubstitutes(LESSON_ID, testUser())).resolves.toEqual([]);
    });

    it('404s on an unknown lesson', async () => {
      tx.calendarLesson.findUnique.mockResolvedValue(null);

      await expect(service.suggestSubstitutes(LESSON_ID, testUser())).rejects.toThrow(
        NotFoundException,
      );
    });

    it('reads no behörigheter and no roster when the school has recorded none', async () => {
      storeLesson();
      tx.teachingRequirement.findMany.mockResolvedValue([
        { teacherId: OTHER_ID, coTeacherId: null, studentGroupId: OTHER_GROUP_ID },
      ]);
      tx.user.findMany.mockResolvedValue([{ id: OTHER_ID }]);
      tx.calendarLesson.findFirst.mockImplementation(answerFirst(null));

      await service.suggestSubstitutes(LESSON_ID, testUser());

      expect(tx.teacherSubjectQualification.findMany).not.toHaveBeenCalled();
      expect(tx.academicYear.findFirst).not.toHaveBeenCalled();
    });

    describe('with behörigheter recorded', () => {
      const LEGIT_ID = '13131313-1313-4313-8313-131313131313';
      const TILLATEN_ID = '14141414-1414-4414-8414-141414141414';
      const qualification = (overrides: Record<string, unknown> = {}) => ({
        userId: LEGIT_ID,
        minGradeLevel: 7,
        maxGradeLevel: 9,
        kind: 'LEGITIMATION',
        validFrom: null,
        validTo: null,
        ...overrides,
      });

      beforeEach(() => {
        storeLesson();
        tx.teacherSubjectQualification.count.mockResolvedValue(3);
        // The lesson's class is a plain åk 7 class with no roster rows, so its
        // span is its own year, 7-7 — derived through the proxy's helper.
        tx.academicYear.findFirst.mockImplementation(({ where }: Query) =>
          Promise.resolve(
            (where?.studentGroups as { some?: { id?: string } } | undefined)?.some?.id === GROUP_ID
              ? { id: 'year-1', isActive: true, predecessorId: null }
              : null,
          ),
        );
        // The year's groups, which the span is derived over (attendanceSpan).
        tx.studentGroup.findMany.mockResolvedValue([{ id: GROUP_ID, gradeLevel: 7 }]);
        tx.studentGroupMember.findMany.mockResolvedValue([]);
        tx.teachingRequirement.findMany.mockResolvedValue([
          // Teaches this class, no behörighet recorded.
          { teacherId: PRIMARY_ID, coTeacherId: null, studentGroupId: GROUP_ID },
          // Teaches the subject elsewhere, no behörighet recorded.
          { teacherId: OTHER_ID, coTeacherId: null, studentGroupId: OTHER_GROUP_ID },
        ]);
        // The roster read asks about pupils; the candidate read asks by id.
        tx.user.findMany.mockImplementation((query: Query) =>
          Promise.resolve(
            query.where?.role === 'TEACHER'
              ? (query.where.id.in as string[]).map((id) => ({ id }))
              : [],
          ),
        );
        tx.calendarLesson.findFirst.mockImplementation(answerFirst(null));
      });

      it('puts a legitimerad teacher on no requirement ahead of the class’s own, and the tillåten one between', async () => {
        tx.teacherSubjectQualification.findMany.mockImplementation(
          answerRows([
            qualification(),
            qualification({ userId: TILLATEN_ID, kind: 'TILLATEN' }),
          ]),
        );

        await expect(service.suggestSubstitutes(LESSON_ID, testUser())).resolves.toEqual([
          { teacherId: LEGIT_ID, isPrimary: false, qualificationKind: 'LEGITIMATION' },
          { teacherId: TILLATEN_ID, isPrimary: false, qualificationKind: 'TILLATEN' },
          { teacherId: PRIMARY_ID, isPrimary: true, qualificationKind: null },
          { teacherId: OTHER_ID, isPrimary: false, qualificationKind: null },
        ]);
        expect(tx.teacherSubjectQualification.findMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: { subjectId: SUBJECT_ID } }),
        );
      });

      it('badges the class’s own teacher when they hold a behörighet, and ranks them above an equal outsider', async () => {
        tx.teacherSubjectQualification.findMany.mockImplementation(
          answerRows([
            qualification({ userId: PRIMARY_ID, kind: 'BEHORIG' }),
            qualification({ userId: OTHER_ID, kind: 'BEHORIG' }),
          ]),
        );

        await expect(service.suggestSubstitutes(LESSON_ID, testUser())).resolves.toEqual([
          { teacherId: PRIMARY_ID, isPrimary: true, qualificationKind: 'BEHORIG' },
          { teacherId: OTHER_ID, isPrimary: false, qualificationKind: 'BEHORIG' },
        ]);
      });

      it('ignores a behörighet whose span misses the class, and one not valid on the lesson’s date', async () => {
        tx.teacherSubjectQualification.findMany.mockImplementation(
          answerRows([
            // Lågstadiet only: does not reach åk 7.
            qualification({ userId: LEGIT_ID, minGradeLevel: 1, maxGradeLevel: 6 }),
            // Expired before 2026-08-10.
            qualification({ userId: TILLATEN_ID, kind: 'TILLATEN', validTo: new Date('2026-06-30T00:00:00.000Z') }),
            // Subject teacher with a span that covers: badged.
            qualification({ userId: OTHER_ID, kind: 'BEHORIG' }),
          ]),
        );

        await expect(service.suggestSubstitutes(LESSON_ID, testUser())).resolves.toEqual([
          { teacherId: OTHER_ID, isPrimary: false, qualificationKind: 'BEHORIG' },
          { teacherId: PRIMARY_ID, isPrimary: true, qualificationKind: null },
        ]);
      });

      it('reads the span from the lesson’s whole attendance, as the vikarie warning does', async () => {
        // An extra åk 9 group on an åk 7 lesson: a 7–7 behörighet does not
        // cover it, a 7–9 one does. The picker's badge and the warning the
        // assignment answers with must read the same span.
        storeLesson({ extraGroups: [{ studentGroupId: OTHER_GROUP_ID }], participants: [] });
        tx.studentGroup.findMany.mockResolvedValue([
          { id: GROUP_ID, gradeLevel: 7 },
          { id: OTHER_GROUP_ID, gradeLevel: 9 },
        ]);
        tx.teacherSubjectQualification.findMany.mockImplementation(
          answerRows([
            qualification({ userId: LEGIT_ID, minGradeLevel: 7, maxGradeLevel: 7 }),
            qualification({ userId: TILLATEN_ID, kind: 'TILLATEN' }),
          ]),
        );

        await expect(service.suggestSubstitutes(LESSON_ID, testUser())).resolves.toEqual([
          { teacherId: TILLATEN_ID, isPrimary: false, qualificationKind: 'TILLATEN' },
          { teacherId: PRIMARY_ID, isPrimary: true, qualificationKind: null },
          { teacherId: OTHER_ID, isPrimary: false, qualificationKind: null },
        ]);
      });

      it('never suggests a teacher already on the lesson, however qualified', async () => {
        tx.teacherSubjectQualification.findMany.mockImplementation(
          answerRows([qualification({ userId: TEACHER_ID })]),
        );

        const answer = await service.suggestSubstitutes(LESSON_ID, testUser());

        expect(answer.map((s) => s.teacherId)).not.toContain(TEACHER_ID);
      });
    });
  });

  // Not covered deliberately: assignSubstitute/changeRoom on a CANCELLED
  // lesson are allowed by the code (only COMPLETED is blocked). That looks
  // intentional (prepare a lesson before reinstating it), so no test pins it
  // either way.
  it('rejects with BadRequestException, not a plain Error, on state violations', async () => {
    storeLesson({ status: 'COMPLETED' });

    await expect(service.cancel(LESSON_ID, {}, testUser())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
