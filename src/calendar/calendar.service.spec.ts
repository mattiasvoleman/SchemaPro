import {
  BadRequestException,
  ForbiddenException,
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
import { CalendarService } from './calendar.service';

const NOW = new Date('2026-08-12T08:00:00.000Z'); // a Wednesday
const YEAR_ID = '44444444-4444-4444-8444-444444444444';
const ML_ID = '55555555-5555-4555-8555-555555555555';
const SUBJECT_ID = '66666666-6666-4666-8666-666666666666';
const GROUP_ID = '77777777-7777-4777-8777-777777777777';
const EXTRA_GROUP_ID = '88888888-8888-4888-8888-888888888888';
const ROOM_ID = '99999999-9999-4999-8999-999999999999';
const TEACHER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CO_TEACHER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const STUDENT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
/** The tenant on the default testUser() principal. */
const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';

/** A Prisma `@db.Time` value: 1970-01-01 with the wall-clock time in UTC. */
const time = (h: number, m = 0) => new Date(Date.UTC(1970, 0, 1, h, m, 0));
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('CalendarService', () => {
  let service: CalendarService;
  let tx: TxMock;
  let prisma: PrismaMock;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new CalendarService(prisma as unknown as PrismaService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /** A Monday-09:00–10:00 template with a single lead teacher. */
  const template = (overrides: Record<string, unknown> = {}) => ({
    id: ML_ID,
    subjectId: SUBJECT_ID,
    studentGroupId: GROUP_ID,
    teacherId: TEACHER_ID,
    coTeacherId: null,
    extraGroups: [],
    participants: [],
    roomId: ROOM_ID,
    dayOfWeek: 1,
    startTime: time(9),
    endTime: time(10),
    ...overrides,
  });

  const arrangeYear = (overrides: Record<string, unknown> = {}) => {
    tx.academicYear.findUnique.mockResolvedValue({
      id: YEAR_ID,
      startDate: day('2026-08-01'),
      endDate: day('2026-08-31'),
      school: { timezone: 'UTC' },
      ...overrides,
    });
  };

  const arrangePublish = (
    templates: Record<string, unknown>[] = [template()],
    {
      existing = [] as Record<string, unknown>[],
      closures = [] as Record<string, unknown>[],
    } = {},
  ) => {
    arrangeYear();
    tx.masterLesson.findMany.mockResolvedValue(templates);
    tx.calendarLesson.findMany.mockResolvedValue(existing);
    tx.availabilityConstraint.findMany.mockResolvedValue(closures);
    tx.calendarLesson.create.mockResolvedValue({ id: 'created-lesson' });
  };

  const dto = (overrides: Record<string, string | undefined> = {}) => ({
    academicYearId: YEAR_ID,
    fromDate: '2026-08-10', // a Monday
    toDate: '2026-08-16', // the following Sunday
    ...overrides,
  });

  describe('publish', () => {
    it('materializes one dated lesson per matching weekday in the window', async () => {
      arrangePublish();
      const user = testUser();

      await expect(service.publish(dto(), user)).resolves.toEqual({
        created: 1,
        skipped: 0,
        fromDate: '2026-08-10',
        toDate: '2026-08-16',
      });

      expect(tx.calendarLesson.create).toHaveBeenCalledTimes(1);
      const { data } = tx.calendarLesson.create.mock.calls[0][0];
      expect(data).toMatchObject({
        schoolId: SCHOOL_ID,
        masterLessonId: ML_ID,
        subjectId: SUBJECT_ID,
        studentGroupId: GROUP_ID,
        roomId: ROOM_ID,
        date: day('2026-08-10'),
        startsAt: new Date('2026-08-10T09:00:00.000Z'),
        endsAt: new Date('2026-08-10T10:00:00.000Z'),
        status: 'SCHEDULED',
        teachers: {
          create: [{ schoolId: SCHOOL_ID, teacherId: TEACHER_ID, role: 'LEAD' }],
        },
      });
      // Empty relations are omitted entirely, not created as empty lists.
      expect(data.extraGroups).toBeUndefined();
      expect(data.participants).toBeUndefined();
    });

    it('runs under the caller RLS context with the extended timeout', async () => {
      arrangePublish();
      const user = testUser();

      await service.publish(dto(), user);

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function), {
        timeoutMs: 120_000,
      });
      expect(prisma.withSystemTransaction).not.toHaveBeenCalled();
      expect(prisma.withServicePrincipal).not.toHaveBeenCalled();
    });

    it('rejects a principal with no school before opening any transaction', async () => {
      await expect(
        service.publish(dto(), testUser({ schoolId: undefined })),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('only materializes templates whose weekday falls inside the window', async () => {
      const monday = template();
      const tuesday = template({ id: 'tuesday-template', dayOfWeek: 2 });
      arrangePublish([monday, tuesday]);

      // Single-day window: Monday 2026-08-10 only.
      const result = await service.publish(
        dto({ fromDate: '2026-08-10', toDate: '2026-08-10' }),
        testUser(),
      );

      expect(result).toMatchObject({ created: 1, skipped: 0 });
      expect(tx.calendarLesson.create).toHaveBeenCalledTimes(1);
      expect(tx.calendarLesson.create.mock.calls[0][0].data.masterLessonId).toBe(ML_ID);
    });

    it('skips (masterLesson, date) pairs that are already materialized', async () => {
      arrangePublish([template()], {
        existing: [{ masterLessonId: ML_ID, date: day('2026-08-10') }],
      });

      await expect(
        service.publish(dto({ fromDate: '2026-08-10', toDate: '2026-08-10' }), testUser()),
      ).resolves.toMatchObject({ created: 0, skipped: 1 });

      expect(tx.calendarLesson.create).not.toHaveBeenCalled();
      // The idempotency set is scoped to this year's templates and the window.
      expect(tx.calendarLesson.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            masterLessonId: { in: [ML_ID] },
            date: { gte: day('2026-08-10'), lte: day('2026-08-10') },
          },
        }),
      );
    });

    it.each([
      ['00:00-00:00', time(0), time(0)],
      ['00:00-23:59', time(0), time(23, 59)],
    ])(
      'suppresses materialization on a full-day group closure (%s)',
      async (_label, startTime, endTime) => {
        arrangePublish([template()], {
          closures: [
            { studentGroupId: GROUP_ID, date: day('2026-08-10'), startTime, endTime },
          ],
        });

        await expect(
          service.publish(
            dto({ fromDate: '2026-08-10', toDate: '2026-08-10' }),
            testUser(),
          ),
        ).resolves.toMatchObject({ created: 0, skipped: 1 });
        expect(tx.calendarLesson.create).not.toHaveBeenCalled();

        expect(tx.availabilityConstraint.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              resourceType: 'STUDENT_GROUP',
              type: 'UNAVAILABLE',
              date: { not: null, gte: day('2026-08-10'), lte: day('2026-08-10') },
            },
          }),
        );
      },
    );

    it('ignores partial-day closures and closures for other groups', async () => {
      arrangePublish([template()], {
        closures: [
          // Partial day for this group — does not close the day.
          { studentGroupId: GROUP_ID, date: day('2026-08-10'), startTime: time(8), endTime: time(10) },
          // Full day, but a different group.
          { studentGroupId: EXTRA_GROUP_ID, date: day('2026-08-10'), startTime: time(0), endTime: time(23, 59) },
        ],
      });

      await expect(
        service.publish(dto({ fromDate: '2026-08-10', toDate: '2026-08-10' }), testUser()),
      ).resolves.toMatchObject({ created: 1, skipped: 0 });
    });

    it('clamps an oversized window to the academic year', async () => {
      arrangePublish();

      // Mondays in Aug 2026: 3, 10, 17, 24, 31.
      await expect(
        service.publish(
          dto({ fromDate: '2026-07-01', toDate: '2026-09-15' }),
          testUser(),
        ),
      ).resolves.toEqual({
        created: 5,
        skipped: 0,
        fromDate: '2026-08-01',
        toDate: '2026-08-31',
      });
    });

    it('defaults the window to today..yearEnd', async () => {
      arrangePublish();

      // NOW is Wed 2026-08-12; remaining Mondays: 17, 24, 31.
      await expect(
        service.publish(dto({ fromDate: undefined, toDate: undefined }), testUser()),
      ).resolves.toEqual({
        created: 3,
        skipped: 0,
        fromDate: '2026-08-12',
        toDate: '2026-08-31',
      });
    });

    it('rejects an inverted window without loading the timetable', async () => {
      arrangeYear();

      await expect(
        service.publish(
          dto({ fromDate: '2026-08-20', toDate: '2026-08-10' }),
          testUser(),
        ),
      ).rejects.toThrow('fromDate must not be after toDate.');
      expect(tx.masterLesson.findMany).not.toHaveBeenCalled();
    });

    it('404s on an unknown academic year', async () => {
      tx.academicYear.findUnique.mockResolvedValue(null);

      await expect(service.publish(dto(), testUser())).rejects.toThrow(
        NotFoundException,
      );
    });

    it('rejects publishing when no master timetable exists', async () => {
      arrangeYear();
      tx.masterLesson.findMany.mockResolvedValue([]);

      await expect(service.publish(dto(), testUser())).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.publish(dto(), testUser())).rejects.toThrow(
        'No master timetable exists for this academic year. Generate a schedule first.',
      );
    });

    it('converts template wall-clock times using the school timezone', async () => {
      arrangePublish();
      arrangeYear({ school: { timezone: 'Europe/Stockholm' } });

      await service.publish(
        dto({ fromDate: '2026-08-10', toDate: '2026-08-10' }),
        testUser(),
      );

      // 09:00 CEST (UTC+2 in August) is 07:00 UTC.
      const { data } = tx.calendarLesson.create.mock.calls[0][0];
      expect(data.startsAt).toEqual(new Date('2026-08-10T07:00:00.000Z'));
      expect(data.endsAt).toEqual(new Date('2026-08-10T08:00:00.000Z'));
    });

    it('materializes co-teacher, extra groups and participants with the tenant stamped', async () => {
      arrangePublish([
        template({
          coTeacherId: CO_TEACHER_ID,
          extraGroups: [{ studentGroupId: EXTRA_GROUP_ID }],
          participants: [{ studentId: STUDENT_ID }],
        }),
      ]);

      await service.publish(
        dto({ fromDate: '2026-08-10', toDate: '2026-08-10' }),
        testUser(),
      );

      const { data } = tx.calendarLesson.create.mock.calls[0][0];
      expect(data.teachers).toEqual({
        create: [
          { schoolId: SCHOOL_ID, teacherId: TEACHER_ID, role: 'LEAD' },
          { schoolId: SCHOOL_ID, teacherId: CO_TEACHER_ID, role: 'ASSISTANT' },
        ],
      });
      expect(data.extraGroups).toEqual({
        create: [{ schoolId: SCHOOL_ID, studentGroupId: EXTRA_GROUP_ID }],
      });
      expect(data.participants).toEqual({
        create: [{ schoolId: SCHOOL_ID, studentId: STUDENT_ID }],
      });
    });

    it('creates an ASSISTANT-only assignment for a co-teacher-only template', async () => {
      arrangePublish([template({ teacherId: null, coTeacherId: CO_TEACHER_ID })]);

      await service.publish(
        dto({ fromDate: '2026-08-10', toDate: '2026-08-10' }),
        testUser(),
      );

      const { data } = tx.calendarLesson.create.mock.calls[0][0];
      expect(data.teachers).toEqual({
        create: [{ schoolId: SCHOOL_ID, teacherId: CO_TEACHER_ID, role: 'ASSISTANT' }],
      });
    });

    it('omits the teachers relation entirely for a teacherless template', async () => {
      arrangePublish([template({ teacherId: null, coTeacherId: null })]);

      await service.publish(
        dto({ fromDate: '2026-08-10', toDate: '2026-08-10' }),
        testUser(),
      );

      expect(tx.calendarLesson.create.mock.calls[0][0].data.teachers).toBeUndefined();
    });
  });
});
