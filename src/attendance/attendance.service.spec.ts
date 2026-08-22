import { ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  createPrismaMock,
  createTxMock,
  testUser,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import { Role } from '../auth/enums/role.enum';
import type { PrismaService } from '../database/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { AttendanceService } from './attendance.service';
import type { ReportAttendanceDto } from './dto/report-attendance.dto';

const NOW = new Date('2026-09-02T06:05:00.000Z');
const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const LESSON_ID = '44444444-4444-4444-8444-444444444444';
const PRIMARY_GROUP = '11111111-1111-4111-8111-aaaaaaaaaaaa';
const EXTRA_GROUP = '11111111-1111-4111-8111-bbbbbbbbbbbb';
const TEACHER_ID = '22222222-2222-4222-8222-222222222222';
const STUDENT_A = '55555555-5555-4555-8555-555555555555';
const STUDENT_B = '66666666-6666-4666-8666-666666666666';
const GUARDIAN_ID = '77777777-7777-4777-8777-777777777777';

/**
 * A Wednesday 09:00–09:45 lesson at a Europe/Stockholm school, materialized the
 * way CalendarService.publish materializes it: `startsAt`/`endsAt` are the UTC
 * instants for that wall clock (CEST, +02:00 in September), not the clock parts.
 */
const lessonRow = (overrides: Record<string, unknown> = {}) => ({
  id: LESSON_ID,
  schoolId: SCHOOL_ID,
  studentGroupId: PRIMARY_GROUP,
  date: new Date('2026-09-02T00:00:00.000Z'),
  startsAt: new Date('2026-09-02T07:00:00.000Z'),
  endsAt: new Date('2026-09-02T07:45:00.000Z'),
  subject: { name: 'Matematik' },
  school: { timezone: 'Europe/Stockholm' },
  extraGroups: [] as Array<{ studentGroupId: string }>,
  ...overrides,
});

/** A `@db.Time` value as Prisma returns it: wall clock on the UTC epoch day. */
const wallClock = (hhmm: string): Date => new Date(`1970-01-01T${hhmm}:00.000Z`);

const dto = (
  records: ReportAttendanceDto['records'],
): ReportAttendanceDto => ({ calendarLessonId: LESSON_ID, records });

describe('AttendanceService', () => {
  let service: AttendanceService;
  let tx: TxMock;
  let prisma: PrismaMock;
  let notifications: { guardiansOf: jest.Mock; notifyUsers: jest.Mock };

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    notifications = {
      guardiansOf: jest.fn().mockResolvedValue([GUARDIAN_ID]),
      notifyUsers: jest.fn().mockResolvedValue(1),
    };
    service = new AttendanceService(
      prisma as unknown as PrismaService,
      notifications as unknown as NotificationsService,
    );

    tx.calendarLesson.findUnique.mockResolvedValue(lessonRow());
    tx.calendarLessonTeacher.findUnique.mockResolvedValue({ id: 'assignment' });
    tx.attendanceRecord.upsert.mockResolvedValue({
      createdAt: NOW,
      updatedAt: NOW,
    });
    // Nothing in the register yet — the ordinary first report.
    tx.attendanceRecord.findMany.mockResolvedValue([]);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const teacher = () => testUser({ role: Role.TEACHER, userId: TEACHER_ID });

  /**
   * `tx.user.findMany` serves two different reads — the home-class half of the
   * roster and the names of students whose guardians get alerted. Only the
   * first constrains `studentGroupId`, which is what tells them apart.
   */
  const arrangeUsers = (options: {
    homeClass?: string[];
    named?: Array<{ id: string; firstName: string; lastName: string }>;
  }) => {
    tx.user.findMany.mockImplementation(
      ({ where }: { where: { studentGroupId?: unknown } }) =>
        Promise.resolve(
          where.studentGroupId
            ? (options.homeClass ?? []).map((id) => ({ id }))
            : (options.named ?? []),
        ),
    );
  };

  /** The common case: everybody in the batch is a member of the home class. */
  const arrangeRoster = (studentIds: string[]) =>
    arrangeUsers({ homeClass: studentIds });

  // -------------------------------------------------------------------------
  // Writing records
  // -------------------------------------------------------------------------

  describe('writing records', () => {
    it('upserts one row per entry and separates creates from updates', async () => {
      arrangeRoster([STUDENT_A, STUDENT_B]);
      tx.attendanceRecord.upsert
        .mockResolvedValueOnce({ createdAt: NOW, updatedAt: NOW })
        .mockResolvedValueOnce({
          createdAt: NOW,
          updatedAt: new Date(NOW.getTime() + 60_000),
        });
      const user = teacher();

      await expect(
        service.reportAttendance(
          dto([
            { studentId: STUDENT_A, status: 'PRESENT' as never },
            { studentId: STUDENT_B, status: 'LATE' as never, note: 'Buss sen' },
          ]),
          user,
        ),
      ).resolves.toEqual({ created: 1, updated: 1 });

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.attendanceRecord.upsert).toHaveBeenNthCalledWith(2, {
        where: {
          calendarLessonId_studentId: {
            calendarLessonId: LESSON_ID,
            studentId: STUDENT_B,
          },
        },
        create: {
          schoolId: SCHOOL_ID,
          calendarLessonId: LESSON_ID,
          studentId: STUDENT_B,
          status: 'LATE',
          recordedById: TEACHER_ID,
          recordedAt: NOW,
          note: 'Buss sen',
        },
        update: {
          status: 'LATE',
          recordedById: TEACHER_ID,
          recordedAt: NOW,
          note: 'Buss sen',
        },
        select: { createdAt: true, updatedAt: true },
      });
    });

    it('stores a missing note and a principal without a userId as null', async () => {
      arrangeRoster([STUDENT_A]);

      await service.reportAttendance(
        dto([{ studentId: STUDENT_A, status: 'PRESENT' as never }]),
        testUser({ role: Role.SCHOOL_ADMIN, userId: undefined }),
      );

      expect(tx.attendanceRecord.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ note: null, recordedById: null }),
          update: expect.objectContaining({ note: null, recordedById: null }),
        }),
      );
    });

    it('throws NotFound when RLS hides the lesson', async () => {
      tx.calendarLesson.findUnique.mockResolvedValue(null);

      await expect(
        service.reportAttendance(
          dto([{ studentId: STUDENT_A, status: 'PRESENT' as never }]),
          teacher(),
        ),
      ).rejects.toThrow(NotFoundException);
      expect(tx.attendanceRecord.upsert).not.toHaveBeenCalled();
    });

    it('rejects a teacher who is not assigned to the lesson', async () => {
      arrangeRoster([STUDENT_A]);
      tx.calendarLessonTeacher.findUnique.mockResolvedValue(null);

      await expect(
        service.reportAttendance(
          dto([{ studentId: STUDENT_A, status: 'PRESENT' as never }]),
          teacher(),
        ),
      ).rejects.toThrow('You are not assigned to this lesson');
      expect(tx.attendanceRecord.upsert).not.toHaveBeenCalled();
    });

    it('rejects a teacher principal that carries no userId', async () => {
      arrangeRoster([STUDENT_A]);

      await expect(
        service.reportAttendance(
          dto([{ studentId: STUDENT_A, status: 'PRESENT' as never }]),
          testUser({ role: Role.TEACHER, userId: undefined }),
        ),
      ).rejects.toThrow('Teacher userId is missing');
      expect(tx.calendarLessonTeacher.findUnique).not.toHaveBeenCalled();
    });

    it('does not look for a teacher assignment when an admin reports', async () => {
      arrangeRoster([STUDENT_A]);

      await service.reportAttendance(
        dto([{ studentId: STUDENT_A, status: 'PRESENT' as never }]),
        testUser({ role: Role.SCHOOL_ADMIN }),
      );

      expect(tx.calendarLessonTeacher.findUnique).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Roster — finding 3
  // -------------------------------------------------------------------------

  describe('roster', () => {
    it('resolves membership from the lesson group, its extra groups and the participant list', async () => {
      tx.calendarLesson.findUnique.mockResolvedValue(
        lessonRow({ extraGroups: [{ studentGroupId: EXTRA_GROUP }] }),
      );
      arrangeRoster([STUDENT_A]);

      // The same student twice: the roster lookup is asked once, not twice.
      await service.reportAttendance(
        dto([
          { studentId: STUDENT_A, status: 'PRESENT' as never },
          { studentId: STUDENT_A, status: 'PRESENT' as never },
        ]),
        teacher(),
      );

      expect(tx.user.findMany).toHaveBeenCalledWith({
        where: {
          id: { in: [STUDENT_A] },
          studentGroupId: { in: [PRIMARY_GROUP, EXTRA_GROUP] },
        },
        select: { id: true },
      });
      expect(tx.studentGroupMember.findMany).toHaveBeenCalledWith({
        where: {
          studentId: { in: [STUDENT_A] },
          studentGroupId: { in: [PRIMARY_GROUP, EXTRA_GROUP] },
        },
        select: { studentId: true },
      });
      expect(tx.calendarLessonStudent.findMany).toHaveBeenCalledWith({
        where: { calendarLessonId: LESSON_ID, studentId: { in: [STUDENT_A] } },
        select: { studentId: true },
      });
    });

    it('accepts a student whose home class is the lesson group', async () => {
      arrangeUsers({ homeClass: [STUDENT_A] });

      await expect(
        service.reportAttendance(
          dto([{ studentId: STUDENT_A, status: 'PRESENT' as never }]),
          teacher(),
        ),
      ).resolves.toEqual({ created: 1, updated: 0 });
    });

    it('accepts a student who only holds a teaching-group membership', async () => {
      // A nivågrupp has no home-class members at all — StudentGroupMembers is
      // the only place its roster exists.
      arrangeUsers({ homeClass: [] });
      tx.studentGroupMember.findMany.mockResolvedValue([
        { studentId: STUDENT_A },
      ]);

      await expect(
        service.reportAttendance(
          dto([{ studentId: STUDENT_A, status: 'PRESENT' as never }]),
          teacher(),
        ),
      ).resolves.toEqual({ created: 1, updated: 0 });
    });

    it('accepts a student named individually on the lesson', async () => {
      arrangeUsers({ homeClass: [] });
      tx.calendarLessonStudent.findMany.mockResolvedValue([
        { studentId: STUDENT_A },
      ]);

      await expect(
        service.reportAttendance(
          dto([{ studentId: STUDENT_A, status: 'PRESENT' as never }]),
          teacher(),
        ),
      ).resolves.toEqual({ created: 1, updated: 0 });
    });

    it('rejects a student on none of the membership sources, naming the id', async () => {
      arrangeUsers({ homeClass: [] });

      const promise = service.reportAttendance(
        dto([{ studentId: STUDENT_B, status: 'ABSENT' as never }]),
        teacher(),
      );

      await expect(promise).rejects.toThrow(ForbiddenException);
      await expect(promise).rejects.toThrow(
        `These students are not on the roster for lesson ${LESSON_ID}: ${STUDENT_B}`,
      );
      expect(tx.attendanceRecord.upsert).not.toHaveBeenCalled();
      expect(notifications.notifyUsers).not.toHaveBeenCalled();
    });

    it('writes nothing at all when one entry of a batch is off the roster', async () => {
      arrangeUsers({ homeClass: [STUDENT_A] });

      await expect(
        service.reportAttendance(
          dto([
            { studentId: STUDENT_A, status: 'PRESENT' as never },
            { studentId: STUDENT_B, status: 'PRESENT' as never },
          ]),
          teacher(),
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(tx.attendanceRecord.upsert).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Unreported-absence alert — finding 12
  // -------------------------------------------------------------------------

  describe('unreported-absence alert', () => {
    const reportAbsent = (user = teacher()) =>
      service.reportAttendance(
        dto([{ studentId: STUDENT_A, status: 'ABSENT' as never }]),
        user,
      );

    beforeEach(() => {
      arrangeUsers({
        homeClass: [STUDENT_A],
        named: [{ id: STUDENT_A, firstName: 'Åsa', lastName: 'Åkesson' }],
      });
    });

    it('keeps the time the teacher marked it, not the time it arrived', async () => {
      // A batch can sit in the offline queue for a day. Stamping arrival puts
      // the whole class in the register at one instant hours after the lesson,
      // and the register is what an absence follow-up is read from.
      await service.reportAttendance(
        {
          calendarLessonId: LESSON_ID,
          records: [
            {
              studentId: STUDENT_A,
              status: 'PRESENT' as never,
              recordedAt: '2026-09-01T09:10:00.000Z',
            },
          ],
        } as never,
        teacher(),
      );

      const call = tx.attendanceRecord.upsert.mock.calls[0]?.[0] as {
        create: { recordedAt: Date };
      };
      expect(call.create.recordedAt).toEqual(new Date('2026-09-01T09:10:00.000Z'));
    });

    it.each([
      ['a time in the future', '2099-01-01T00:00:00.000Z'],
      ['a time older than a school term', '2020-01-01T00:00:00.000Z'],
      ['a value that is not a date at all', 'imorgon'],
    ])('falls back to the server clock for %s', async (_label, recordedAt) => {
      // The device clock is not trusted blindly: these are a broken device,
      // not a teacher who marked attendance in 2099.
      await service.reportAttendance(
        {
          calendarLessonId: LESSON_ID,
          records: [{ studentId: STUDENT_A, status: 'PRESENT' as never, recordedAt }],
        } as never,
        teacher(),
      );

      const call = tx.attendanceRecord.upsert.mock.calls[0]?.[0] as {
        create: { recordedAt: Date };
      };
      expect(call.create.recordedAt).toEqual(NOW);
    });

    it('stays silent when the pupil was already absent in the register', async () => {
      // The device retries whenever a response is lost. The write is idempotent
      // — upsert on (lesson, student) — but the alert was not, so every retry
      // told the guardian about the same absence again. A guardian who is told
      // four times learns to ignore the fifth.
      tx.attendanceRecord.findMany.mockResolvedValue([
        { studentId: STUDENT_A, status: 'ABSENT' },
      ]);

      await reportAbsent();

      expect(notifications.notifyUsers).not.toHaveBeenCalled();
      // The record itself is still written: a replay must converge, not be
      // refused.
      expect(tx.attendanceRecord.upsert).toHaveBeenCalled();
    });

    it('alerts when a correction turns a present pupil absent', async () => {
      // Not a replay — the register said something else a moment ago, and this
      // is the first time anybody could have been told.
      tx.attendanceRecord.findMany.mockResolvedValue([
        { studentId: STUDENT_A, status: 'PRESENT' },
      ]);

      await reportAbsent();

      expect(notifications.notifyUsers).toHaveBeenCalledTimes(1);
    });

    it('alerts the guardians when no absence report exists', async () => {
      await reportAbsent();

      expect(tx.absenceReport.findMany).toHaveBeenCalledWith({
        where: {
          studentId: { in: [STUDENT_A] },
          date: new Date('2026-09-02T00:00:00.000Z'),
        },
        select: { studentId: true, startTime: true, endTime: true },
      });
      expect(notifications.notifyUsers).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          schoolId: SCHOOL_ID,
          userIds: [GUARDIAN_ID],
          type: 'ABSENCE_UNREPORTED',
          meta: {
            studentName: 'Åsa Åkesson',
            subjectName: 'Matematik',
            date: '2026-09-02',
          },
        }),
      );
    });

    it('stays silent for a full-day report', async () => {
      tx.absenceReport.findMany.mockResolvedValue([
        { studentId: STUDENT_A, startTime: null, endTime: null },
      ]);

      await reportAbsent();

      expect(notifications.notifyUsers).not.toHaveBeenCalled();
    });

    it('stays silent when a partial-day report covers the lesson in the school timezone', async () => {
      // 08:00–12:00 local covers a 09:00–09:45 local lesson. Comparing the raw
      // UTC parts makes the report look like it starts at 08:00 against a
      // lesson at 07:00, and the guardian gets an alarm for a morning they
      // reported themselves.
      tx.absenceReport.findMany.mockResolvedValue([
        {
          studentId: STUDENT_A,
          startTime: wallClock('08:00'),
          endTime: wallClock('12:00'),
        },
      ]);

      await reportAbsent();

      expect(notifications.notifyUsers).not.toHaveBeenCalled();
    });

    it('alerts when the report ends before the lesson starts in local time', async () => {
      // 06:00–08:00 local ends an hour before the lesson. Comparing UTC parts
      // makes it look like it runs 06:00–08:00 against a 07:00 lesson, and a
      // genuinely unreported absence goes unnoticed.
      tx.absenceReport.findMany.mockResolvedValue([
        {
          studentId: STUDENT_A,
          startTime: wallClock('06:00'),
          endTime: wallClock('08:00'),
        },
      ]);

      await reportAbsent();

      expect(notifications.notifyUsers).toHaveBeenCalledTimes(1);
    });

    /**
     * A school in UTC, where the conversion must be a no-op. Both ends of the
     * report are pinned: a zone applied to only one of them still shifts the
     * window, so each direction gets its own case.
     */
    describe('at a school whose timezone is UTC', () => {
      beforeEach(() => {
        tx.calendarLesson.findUnique.mockResolvedValue(
          lessonRow({
            school: { timezone: 'UTC' },
            startsAt: new Date('2026-09-02T09:00:00.000Z'),
            endsAt: new Date('2026-09-02T09:45:00.000Z'),
          }),
        );
      });

      it('stays silent for a report inside the lesson', async () => {
        tx.absenceReport.findMany.mockResolvedValue([
          {
            studentId: STUDENT_A,
            startTime: wallClock('09:15'),
            endTime: wallClock('09:30'),
          },
        ]);

        await reportAbsent();

        expect(notifications.notifyUsers).not.toHaveBeenCalled();
      });

      it('alerts for a report that begins after the lesson has ended', async () => {
        tx.absenceReport.findMany.mockResolvedValue([
          {
            studentId: STUDENT_A,
            startTime: wallClock('10:30'),
            endTime: wallClock('12:00'),
          },
        ]);

        await reportAbsent();

        expect(notifications.notifyUsers).toHaveBeenCalledTimes(1);
      });
    });

    it('takes the offset from the lesson date, so winter is CET not CEST', async () => {
      // January is +01:00, not the +02:00 that holds in September. A report of
      // 09:30–09:45 overlaps the last quarter of a 09:00–09:45 lesson under CET
      // and misses it entirely under CEST.
      tx.calendarLesson.findUnique.mockResolvedValue(
        lessonRow({
          date: new Date('2026-01-14T00:00:00.000Z'),
          startsAt: new Date('2026-01-14T08:00:00.000Z'),
          endsAt: new Date('2026-01-14T08:45:00.000Z'),
        }),
      );
      tx.absenceReport.findMany.mockResolvedValue([
        {
          studentId: STUDENT_A,
          startTime: wallClock('09:30'),
          endTime: wallClock('09:45'),
        },
      ]);

      await reportAbsent();

      expect(notifications.notifyUsers).not.toHaveBeenCalled();
    });

    it('does not notify a student without guardians', async () => {
      notifications.guardiansOf.mockResolvedValue([]);

      await reportAbsent();

      expect(notifications.notifyUsers).not.toHaveBeenCalled();
    });

    it('does not query absence reports when nobody was marked absent', async () => {
      await service.reportAttendance(
        dto([{ studentId: STUDENT_A, status: 'PRESENT' as never }]),
        teacher(),
      );

      expect(tx.absenceReport.findMany).not.toHaveBeenCalled();
    });
  });
});
