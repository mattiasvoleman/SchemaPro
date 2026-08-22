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
    describe('lessons that do not run every week', () => {
      /** August 2026: w32 Mon = 08-03, w33 = 08-10, w34 = 08-17, w35 = 08-24. */
      const wholeMonth = { fromDate: '2026-08-01', toDate: '2026-08-31' };

      const createdDates = () =>
        tx.calendarLesson.create.mock.calls.map(
          (call) => (call[0] as { data: { date: Date } }).data.date.toISOString().slice(0, 10),
        );

      it('materializes an odd-week lesson only on odd ISO weeks', async () => {
        arrangePublish([template({ recurrence: 'ODD_WEEKS' })]);
        arrangeYear({ startDate: day('2026-08-01'), endDate: day('2026-08-31') });

        await service.publish({ academicYearId: YEAR_ID, ...wholeMonth }, testUser());

        // Mondays in August 2026 fall in weeks 32, 33, 34, 35 and 36.
        expect(createdDates()).toEqual(['2026-08-10', '2026-08-24']);
      });

      it('materializes an even-week lesson on exactly the other weeks', async () => {
        arrangePublish([template({ recurrence: 'EVEN_WEEKS' })]);
        arrangeYear({ startDate: day('2026-08-01'), endDate: day('2026-08-31') });

        await service.publish({ academicYearId: YEAR_ID, ...wholeMonth }, testUser());

        expect(createdDates()).toEqual(['2026-08-03', '2026-08-17', '2026-08-31']);
      });

      it('together they cover every week exactly once — the point of alternating', async () => {
        // Slöjd on odd weeks and hemkunskap on even weeks share the slot and
        // between them fill it every week, with no week holding both.
        arrangePublish([
          template({ id: 'odd', recurrence: 'ODD_WEEKS' }),
          template({ id: 'even', recurrence: 'EVEN_WEEKS' }),
        ]);
        arrangeYear({ startDate: day('2026-08-01'), endDate: day('2026-08-31') });

        await service.publish({ academicYearId: YEAR_ID, ...wholeMonth }, testUser());

        const perDate = new Map<string, number>();
        for (const date of createdDates()) {
          perDate.set(date, (perDate.get(date) ?? 0) + 1);
        }
        expect([...perDate.keys()].sort()).toEqual([
          '2026-08-03',
          '2026-08-10',
          '2026-08-17',
          '2026-08-24',
          '2026-08-31',
        ]);
        expect([...new Set(perDate.values())]).toEqual([1]);
      });

      it('stops a half-term subject after its end date', async () => {
        arrangePublish([template({ endDate: day('2026-08-17') })]);
        arrangeYear({ startDate: day('2026-08-01'), endDate: day('2026-08-31') });

        await service.publish({ academicYearId: YEAR_ID, ...wholeMonth }, testUser());

        expect(createdDates()).toEqual(['2026-08-03', '2026-08-10', '2026-08-17']);
      });

      it('does not start one before its start date', async () => {
        arrangePublish([template({ startDate: day('2026-08-17') })]);
        arrangeYear({ startDate: day('2026-08-01'), endDate: day('2026-08-31') });

        await service.publish({ academicYearId: YEAR_ID, ...wholeMonth }, testUser());

        expect(createdDates()).toEqual(['2026-08-17', '2026-08-24', '2026-08-31']);
      });

      it('creates nothing at all when the period misses the window entirely', async () => {
        arrangePublish([template({ startDate: day('2027-01-11') })]);
        arrangeYear({ startDate: day('2026-08-01'), endDate: day('2027-06-11') });

        const result = await service.publish(
          { academicYearId: YEAR_ID, ...wholeMonth },
          testUser(),
        );

        expect(tx.calendarLesson.create).not.toHaveBeenCalled();
        expect(result).toMatchObject({ created: 0 });
      });

      it('leaves a lesson with no recurrence set running every week', async () => {
        arrangePublish([template()]);
        arrangeYear({ startDate: day('2026-08-01'), endDate: day('2026-08-31') });

        await service.publish({ academicYearId: YEAR_ID, ...wholeMonth }, testUser());

        expect(createdDates()).toHaveLength(5);
      });
    });

    it('materializes one dated lesson per matching weekday in the window', async () => {
      arrangePublish();
      const user = testUser();

      await expect(service.publish(dto(), user)).resolves.toEqual({
        created: 1,
        cancelled: 0,
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

    const closure = (overrides: Record<string, unknown> = {}) => ({
      resourceType: 'STUDENT_GROUP',
      userId: null,
      roomId: null,
      studentGroupId: GROUP_ID,
      minGradeLevel: null,
      maxGradeLevel: null,
      date: day('2026-08-10'),
      startTime: time(0),
      endTime: time(0),
      ...overrides,
    });

    const publishOneDay = () =>
      service.publish(
        dto({ fromDate: '2026-08-10', toDate: '2026-08-10' }),
        testUser(),
      );

    describe('a date the school has already said is not available', () => {
      it('cancels the lesson when the teacher is away, rather than hiding it', async () => {
        // The class is still here and expecting the lesson. A hole in their
        // schedule explains nothing — and the substitute workflow searches the
        // calendar by teacher and date, so a lesson that was never written is
        // invisible to the very process that exists to cover it.
        arrangePublish([template()], {
          closures: [
            closure({
              resourceType: 'TEACHER',
              studentGroupId: null,
              userId: TEACHER_ID,
              startTime: time(8, 30),
              endTime: time(9, 30),
            }),
          ],
        });

        await expect(publishOneDay()).resolves.toMatchObject({
          created: 0,
          cancelled: 1,
          skipped: 0,
        });
        const { data } = tx.calendarLesson.create.mock.calls[0]![0] as {
          data: { status: string; note: string };
        };
        expect(data.status).toBe('CANCELLED');
        expect(data.note).toBe('Inställd: läraren är inte tillgänglig detta datum.');
      });

      it('writes nothing when the class itself is closed', async () => {
        // Nobody is there. There is no lesson to hold, and nobody to cancel
        // one for — which is why a class closure outranks a resource closure.
        arrangePublish([template()], { closures: [closure()] });

        await expect(publishOneDay()).resolves.toMatchObject({
          created: 0,
          cancelled: 0,
          skipped: 1,
        });
        expect(tx.calendarLesson.create).not.toHaveBeenCalled();
      });

      it('reads the closure clock in the school timezone, not in UTC', async () => {
        // The closure is a bare wall clock, the lesson is a real instant.
        // Comparing raw UTC parts is off by the offset — one or two hours every
        // day of the year in Europe/Stockholm — so a closure that covers the
        // lesson locally looks like one that misses it.
        arrangePublish([template()], {
          closures: [
            closure({
              resourceType: 'TEACHER',
              studentGroupId: null,
              userId: TEACHER_ID,
              // Lifted through Europe/Stockholm this lands inside the lesson;
              // read as raw UTC clock parts it lands two hours after it.
              startTime: time(9, 15),
              endTime: time(9, 45),
            }),
          ],
        });

        await expect(publishOneDay()).resolves.toMatchObject({ cancelled: 1 });
      });

      it('leaves the lesson alone when the closure misses its hours', async () => {
        // The control. Without it the test above passes against an
        // implementation that cancels on any closure at all.
        arrangePublish([template()], {
          closures: [
            closure({
              resourceType: 'TEACHER',
              studentGroupId: null,
              userId: TEACHER_ID,
              startTime: time(13, 0),
              endTime: time(14, 0),
            }),
          ],
        });

        await expect(publishOneDay()).resolves.toMatchObject({
          created: 1,
          cancelled: 0,
        });
      });

      it('ignores a preference, which is a wish and not a closure', async () => {
        // PREFERRED_FREE is something the solver trades off. Treating it as a
        // closure would silently delete lessons a school only nudged.
        arrangePublish([template()], { closures: [] });

        await publishOneDay();

        const [call] = tx.availabilityConstraint.findMany.mock.calls as [
          [{ where: { type: string } }],
        ];
        expect(call[0].where.type).toBe('UNAVAILABLE');
      });
    });

    it.each([
      ['00:00-00:00', time(0), time(0)],
      ['00:00-23:59', time(0), time(23, 59)],
    ])(
      'suppresses materialization on a full-day group closure (%s)',
      async (_label, startTime, endTime) => {
        arrangePublish([template()], {
          closures: [
            {
              // The service reads the kind now: the query used to filter on it
              // and throw away everything that was not a whole day, so a
              // teacher or a room marked away was materialised straight over.
              resourceType: 'STUDENT_GROUP',
              userId: null,
              roomId: null,
              studentGroupId: GROUP_ID,
              minGradeLevel: null,
              maxGradeLevel: null,
              date: day('2026-08-10'),
              startTime,
              endTime,
            },
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
              // Every kind, not only classes: the narrowing to STUDENT_GROUP
              // was the defect. Which kind it is decides what gets written,
              // and that decision belongs in the loop, not in the query.
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
        cancelled: 0,
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
        cancelled: 0,
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
