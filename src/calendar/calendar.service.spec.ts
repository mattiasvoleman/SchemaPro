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

  /** A lov, at the outer level so both the lessons and the meals can use one. */
  const schoolBreakFixture = (overrides: Record<string, unknown> = {}) => ({
    startDate: day('2026-08-10'),
    endDate: day('2026-08-10'),
    minGradeLevel: null,
    maxGradeLevel: null,
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

  /** A rast row as Prisma hands it back: `@db.Time` values anchored at 1970. */
  const rastRow = (
    overrides: {
      name?: string;
      minGradeLevel?: number;
      maxGradeLevel?: number;
      dayOfWeek?: number | null;
      start?: string;
      end?: string;
    } = {},
  ) => ({
    name: overrides.name ?? 'Förmiddagsrast',
    minGradeLevel: overrides.minGradeLevel ?? 4,
    maxGradeLevel: overrides.maxGradeLevel ?? 6,
    dayOfWeek: overrides.dayOfWeek ?? null,
    startTime: new Date(`1970-01-01T${overrides.start ?? '09:40'}:00.000Z`),
    endTime: new Date(`1970-01-01T${overrides.end ?? '10:00'}:00.000Z`),
  });

  const arrangePublish = (
    templates: Record<string, unknown>[] = [template()],
    {
      existing = [] as Record<string, unknown>[],
      closures = [] as Record<string, unknown>[],
      breaks = [] as Record<string, unknown>[],
      /** Weekly meals, as the solver stored them. */
      sittings = [] as Record<string, unknown>[],
      /** Meals already materialised in the window. */
      existingLunches = [] as Record<string, unknown>[],
      /** Declared rasts, and the groups they are published to. */
      rasts = [] as Record<string, unknown>[],
      groups = [] as Record<string, unknown>[],
    } = {},
  ) => {
    arrangeYear();
    tx.rast.findMany.mockResolvedValue(rasts);
    tx.studentGroup.findMany.mockResolvedValue(groups);
    tx.calendarRast.create.mockResolvedValue({ id: 'created-rast' });
    tx.calendarRast.deleteMany.mockResolvedValue({ count: 0 });
    tx.masterLesson.findMany.mockResolvedValue(templates);
    tx.calendarLesson.findMany.mockResolvedValue(existing);
    tx.availabilityConstraint.findMany.mockResolvedValue(closures);
    tx.schoolBreak.findMany.mockResolvedValue(breaks);
    tx.calendarLesson.create.mockResolvedValue({ id: 'created-lesson' });
    tx.lunchSitting.findMany.mockResolvedValue(sittings);
    tx.calendarLunch.findMany.mockResolvedValue(existingLunches);
    tx.calendarLunch.create.mockResolvedValue({ id: 'created-lunch' });
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

    describe('the meals', () => {
      /** A weekly sitting, as the solver stored it. 2026-08-10 is a Monday. */
      const sitting = (overrides: Record<string, unknown> = {}) => ({
        studentGroupId: GROUP_ID,
        dayOfWeek: 1,
        startTime: time(11),
        endTime: time(12),
        ...overrides,
      });

      // The meal is upserted, not created: a sitting that has moved must rewrite
      // the published row rather than be skipped past. `create` is the branch
      // that runs on a first publish, and it is what these assertions describe.
      const lunchData = () =>
        tx.calendarLunch.upsert.mock.calls.map(
          (call) => (call[0] as { create: Record<string, unknown> }).create,
        );

      it('publishes a rast to every class the span reaches', async () => {
        arrangePublish([template()], {
          rasts: [rastRow()],
          groups: [
            { id: GROUP_ID, gradeLevel: 5, kind: 'CLASS' },
            { id: EXTRA_GROUP_ID, gradeLevel: 5, kind: 'CLASS' },
          ],
        });

        await publishOneDay();

        expect(tx.calendarRast.create).toHaveBeenCalledTimes(2);
      });

      it('publishes no rast to a teaching group', async () => {
        // A teaching group is nobody's home and has no year of its own. A rast
        // published to it would be a second copy of a break its members already
        // have through their class — the same answer the meal's persist gives.
        arrangePublish([template()], {
          rasts: [rastRow()],
          groups: [
            { id: GROUP_ID, gradeLevel: 5, kind: 'CLASS' },
            // WITH a year, which is the case that discriminates: a null one is
            // already refused by the grade lookup, so a fixture using it would
            // pass with the kind check removed.
            { id: 'g-ma71', gradeLevel: 5, kind: 'TEACHING_GROUP' },
          ],
        });

        await publishOneDay();

        expect(tx.calendarRast.create).toHaveBeenCalledTimes(1);
      });

      it('publishes no rast to a class the span does not reach', async () => {
        arrangePublish([template()], {
          rasts: [rastRow({ minGradeLevel: 7, maxGradeLevel: 9 })],
          groups: [{ id: GROUP_ID, gradeLevel: 5, kind: 'CLASS' }],
        });

        await publishOneDay();

        expect(tx.calendarRast.create).not.toHaveBeenCalled();
      });

      it('serves no rast on a day the lov covers', async () => {
        // The same object, the same breakCoversGroup and the same walk the
        // lessons and the meal use. Deriving "which days does this school
        // teach" a second time is how a lov stops being honoured in two
        // surfaces out of three.
        arrangePublish([template()], {
          rasts: [rastRow()],
          groups: [{ id: GROUP_ID, gradeLevel: 5, kind: 'CLASS' }],
          breaks: [schoolBreakFixture()],
        });

        await publishOneDay();

        expect(tx.calendarRast.create).not.toHaveBeenCalled();
      });

      it('keeps a stage\'s other rasts on the day a weekday row replaces one', async () => {
        // The rule that separates a rast from a lunch serving. Replacing every
        // every-day row would publish a Monday missing this stage's afternoon
        // break — silently, to every pupil in it.
        arrangePublish([template()], {
          rasts: [
            rastRow({ name: 'Förmiddag', start: '09:40', end: '10:00' }),
            rastRow({ name: 'Eftermiddag', start: '13:00', end: '13:15' }),
            rastRow({ name: 'Måndag', start: '09:30', end: '09:50', dayOfWeek: 1 }),
          ],
          groups: [{ id: GROUP_ID, gradeLevel: 5, kind: 'CLASS' }],
        });

        await publishOneDay();

        const names = tx.calendarRast.create.mock.calls.map(
          ([call]) => (call as { data: { name: string } }).data.name,
        );
        expect(names).toEqual(['Måndag', 'Eftermiddag']);
      });

      it('clears the window before it writes, so a deleted rast disappears', async () => {
        // An upsert alone keeps a rast the school has REMOVED: nothing would
        // ever delete the row, and a pupil would go on being told about a break
        // that no longer exists. Safe here for the reason it is not safe for a
        // lesson — a CalendarRast carries no attendance and nothing about the
        // past.
        arrangePublish([template()], {
          rasts: [],
          groups: [{ id: GROUP_ID, gradeLevel: 5, kind: 'CLASS' }],
        });

        await publishOneDay();

        const [[call]] = tx.calendarRast.deleteMany.mock.calls as [
          [{ where: { studentGroup: unknown; date: unknown } }],
        ];
        expect(call.where.studentGroup).toEqual({
          is: { academicYearId: YEAR_ID },
        });
        // Scoped to this publish's own window, so republishing one week does
        // not empty another.
        expect(call.where.date).toEqual({
          gte: new Date('2026-08-10T00:00:00.000Z'),
          lte: new Date('2026-08-10T00:00:00.000Z'),
        });
      });

      it('materialises no lesson that is set aside on the tray', async () => {
        arrangePublish([template()]);

        await publishOneDay();

        // Excluded at the query, not filtered afterwards: the memory of where
        // a parked lesson was is not a placement, and must not be read as one.
        expect(tx.masterLesson.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({ isParked: false }),
          }),
        );
      });

      it('rewrites a meal whose sitting has moved', async () => {
        // The bug this replaced. Publish read the already-materialised meals
        // into a set and continued past every one, calling it "the same
        // idempotency the lessons get from existingKeys". It is not the same: a
        // CalendarLesson may carry AttendanceRecords, so rewriting one would
        // rewrite what happened; a CalendarLunch carries no attendance, no
        // status and no participants, so a skipped one is simply out of date —
        // and stayed on a pupil's phone for ever.
        arrangePublish([template()], { sittings: [sitting()] });

        await publishOneDay();

        const [[call]] = tx.calendarLunch.upsert.mock.calls as [
          [{ where: unknown; update: Record<string, unknown> }],
        ];
        expect(call.where).toEqual({
          studentGroupId_date: {
            studentGroupId: GROUP_ID,
            date: new Date('2026-08-10T00:00:00.000Z'),
          },
        });
        expect(call.update).toEqual({
          startsAt: new Date('2026-08-10T11:00:00.000Z'),
          endsAt: new Date('2026-08-10T12:00:00.000Z'),
        });
      });

      it('materialises a meal on the weekday its sitting names', async () => {
        arrangePublish([template()], { sittings: [sitting()] });

        await publishOneDay();

        expect(lunchData()).toEqual([
          {
            schoolId: testUser().schoolId,
            studentGroupId: GROUP_ID,
            date: day('2026-08-10'),
            startsAt: new Date('2026-08-10T11:00:00.000Z'),
            endsAt: new Date('2026-08-10T12:00:00.000Z'),
          },
        ]);
      });

      it('writes nothing on a weekday no sitting names', async () => {
        arrangePublish([template()], { sittings: [sitting({ dayOfWeek: 3 })] });

        await publishOneDay();

        expect(tx.calendarLunch.upsert).not.toHaveBeenCalled();
      });

      it('serves no meal on a lov day', async () => {
        /*
         * The whole reason the meals are dated HERE rather than derived in the
         * portals. "Which days does this school teach" is answered once, by the
         * same breakCoversGroup the lessons ask — three separate derivations is
         * how a lov stops being honoured in two of them.
         */
        arrangePublish([template()], {
          sittings: [sitting()],
          breaks: [schoolBreakFixture()],
        });

        await publishOneDay();

        expect(tx.calendarLunch.upsert).not.toHaveBeenCalled();
      });

      it('serves no meal to a stage the lov names, and serves the others', async () => {
        // A prao week for åk 9 is a break with a grade span. The years come off
        // the group, exactly as they do for the lessons.
        arrangePublish([template()], {
          sittings: [sitting()],
          breaks: [schoolBreakFixture({ minGradeLevel: 9, maxGradeLevel: 9 })],
        });

        await publishOneDay();

        // GROUP_ID's own year is not 9 in this fixture, so the meal stands.
        expect(tx.calendarLunch.upsert).toHaveBeenCalledTimes(1);
      });

      it('republishes an unchanged window without failing on the unique key', async () => {
        /*
         * This test used to assert the opposite — that an already-materialised
         * meal was SKIPPED — and called it "the same idempotency the lessons get
         * from their existing-key set". Skipping is the right answer for a
         * lesson, which may carry AttendanceRecords a rewrite would falsify. It
         * was the wrong answer here, and it is the bug: a CalendarLunch carries
         * no attendance, no status and no participants, so a skipped one is
         * merely out of date, and a republished week kept last month's lunch
         * time for ever.
         *
         * What survives is the requirement the old test was protecting: a second
         * publish of the same window must not fail on (studentGroupId, date).
         * The unique key now provides that through the upsert instead of
         * through a set this loop had to build and consult.
         */
        arrangePublish([template()], {
          sittings: [sitting()],
          existingLunches: [
            { studentGroupId: GROUP_ID, date: day('2026-08-10') },
          ],
        });

        await publishOneDay();

        expect(tx.calendarLunch.upsert).toHaveBeenCalledTimes(1);
      });

      it('writes the meals even when no lesson falls on the day', async () => {
        // The meal loop runs before the templates are looked up, so a day whose
        // teaching is entirely hand-placed still feeds its classes.
        arrangePublish([template({ dayOfWeek: 3 })], { sittings: [sitting()] });

        await publishOneDay();

        expect(tx.calendarLunch.upsert).toHaveBeenCalledTimes(1);
        expect(tx.calendarLesson.create).not.toHaveBeenCalled();
      });
    });

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

    describe('lov och studiedagar', () => {
      /** A `SchoolBreak` row, as the publish query selects it. */
      const schoolBreak = (overrides: Record<string, unknown> = {}) => ({
        startDate: day('2026-08-10'),
        endDate: day('2026-08-10'),
        minGradeLevel: null,
        maxGradeLevel: null,
        ...overrides,
      });

      /** The template each `create` came from, in the order they were made. */
      const createdIds = () =>
        tx.calendarLesson.create.mock.calls.map(
          (call) => (call[0] as { data: { masterLessonId: string } }).data.masterLessonId,
        );

      it('writes no lesson at all on a lov day', async () => {
        // Nothing is written and nothing is cancelled: a cancellation says "this
        // lesson was supposed to happen and did not", and on a lov there was
        // never a lesson to hold — the class is not in the building.
        arrangePublish([template()], { breaks: [schoolBreak()] });

        await expect(publishOneDay()).resolves.toMatchObject({
          created: 0,
          cancelled: 0,
          skipped: 1,
        });
        expect(tx.calendarLesson.create).not.toHaveBeenCalled();
      });

      it('takes both edges of the range on the school local date, and stops there', async () => {
        // The trap: a lov is a DATE and a lesson an instant, so in Stockholm
        // (UTC+2 in August) a lesson at 00:15 on the lov's first day is
        // 22:15Z the day BEFORE it, and 00:15 the day after the lov ends is
        // 22:15Z on its last day. Compared as UTC instants the range misses
        // the first lesson and swallows the fourth — one day out in both
        // directions at once. 2026-08-09 is a Sunday, 08-13 a Thursday.
        const early = (id: string, dayOfWeek: number) =>
          template({ id, dayOfWeek, startTime: time(0, 15), endTime: time(1) });
        const late = (id: string, dayOfWeek: number) =>
          template({ id, dayOfWeek, startTime: time(23, 30), endTime: time(23, 59) });

        arrangePublish(
          [
            late('sunday-before', 7), // 08-09 23:30 local = 21:30Z, same day
            early('monday-first', 1), // 08-10 00:15 local = 08-09 22:15Z
            late('wednesday-last', 3), // 08-12 23:30 local = 21:30Z, same day
            early('thursday-after', 4), // 08-13 00:15 local = 08-12 22:15Z
          ],
          {
            breaks: [
              schoolBreak({ startDate: day('2026-08-10'), endDate: day('2026-08-12') }),
            ],
          },
        );
        arrangeYear({ school: { timezone: 'Europe/Stockholm' } });

        await expect(
          service.publish(dto({ fromDate: '2026-08-09', toDate: '2026-08-13' }), testUser()),
        ).resolves.toMatchObject({ created: 2, cancelled: 0, skipped: 2 });

        // Both ends of the lov are inclusive; the days around it are not.
        expect(createdIds()).toEqual(['sunday-before', 'thursday-after']);
      });

      it('outranks a teacher closure — a lov leaves nothing to cancel', async () => {
        arrangePublish([template()], {
          breaks: [schoolBreak()],
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
          cancelled: 0,
          skipped: 1,
        });
        expect(tx.calendarLesson.create).not.toHaveBeenCalled();
      });

      it('does not read group years for a school-wide lov', async () => {
        // The common case by far, and it must not cost an extra query.
        arrangePublish([template()], { breaks: [schoolBreak()] });

        await publishOneDay();

        expect(tx.studentGroup.findMany).not.toHaveBeenCalled();
      });

      it('reads group years for a lov that names a span, and takes the group inside it', async () => {
        // Prao för åk 9: the years are only looked up because this row asks.
        arrangePublish([template()], {
          breaks: [schoolBreak({ minGradeLevel: 7, maxGradeLevel: 9 })],
        });
        tx.studentGroup.findMany.mockResolvedValue([{ id: GROUP_ID, gradeLevel: 8 }]);

        await expect(publishOneDay()).resolves.toMatchObject({ created: 0, skipped: 1 });
        expect(tx.studentGroup.findMany).toHaveBeenCalled();
      });

      /*
       * Both edges of the span, which nothing touched.
       *
       * The fixture uses 7-9 with a group in åk 8, so an inclusive/exclusive
       * slip at either end — or losing the lower bound entirely, which turns a
       * prao för åk 9 into a school-wide lov — passed the whole suite. The two
       * years just outside are here for the same reason: a span that has
       * quietly become unbounded satisfies the two inside on its own.
       */
      it.each([
        ['the lower edge, åk 7', 7, { created: 0, skipped: 1 }],
        ['the upper edge, åk 9', 9, { created: 0, skipped: 1 }],
        ['just below it, åk 6', 6, { created: 1, skipped: 0 }],
        ['just above it, åk 10', 10, { created: 1, skipped: 0 }],
      ])('resolves %s the way the span reads', async (_label, gradeLevel, expected) => {
        arrangePublish([template()], {
          breaks: [schoolBreak({ minGradeLevel: 7, maxGradeLevel: 9 })],
        });
        tx.studentGroup.findMany.mockResolvedValue([{ id: GROUP_ID, gradeLevel }]);

        await expect(publishOneDay()).resolves.toMatchObject(expected);
      });

      it('leaves a group outside the span teaching as usual', async () => {
        arrangePublish([template()], {
          breaks: [schoolBreak({ minGradeLevel: 7, maxGradeLevel: 9 })],
        });
        tx.studentGroup.findMany.mockResolvedValue([{ id: GROUP_ID, gradeLevel: 4 }]);

        await expect(publishOneDay()).resolves.toMatchObject({ created: 1, skipped: 0 });
      });

      it('keeps the lesson for a group with no year of its own', async () => {
        // A nivågrupp cannot be shown to be inside the span, and erasing a
        // lesson on a guess is the worse mistake of the two.
        arrangePublish([template()], {
          breaks: [schoolBreak({ minGradeLevel: 7, maxGradeLevel: 9 })],
        });
        tx.studentGroup.findMany.mockResolvedValue([{ id: GROUP_ID, gradeLevel: null }]);

        await expect(publishOneDay()).resolves.toMatchObject({ created: 1, skipped: 0 });
      });

      it('asks for the breaks that overlap the window, not only those inside it', async () => {
        arrangePublish([template()]);

        await publishOneDay();

        expect(tx.schoolBreak.findMany).toHaveBeenCalledWith({
          where: {
            academicYearId: YEAR_ID,
            // A jullov that began before the window still closes the days of
            // it that fall inside — overlap, not containment.
            startDate: { lte: day('2026-08-10') },
            endDate: { gte: day('2026-08-10') },
          },
          // No `kind`: HOLIDAY and STAFF_DAY suppress identically, so the two
          // arrive here as the same row and there is nothing to branch on.
          // What separates them is what the day means for staff.
          select: {
            startDate: true,
            endDate: true,
            minGradeLevel: true,
            maxGradeLevel: true,
          },
        });
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
