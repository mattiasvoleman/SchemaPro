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

const same = (a: unknown, b: unknown): boolean =>
  a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;

/** The operators publish filters with: equality, in, not, gte, lte, some. */
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([column, condition]) => {
    const value = row[column];
    if (value === undefined) return true;
    if (condition === null || typeof condition !== 'object' || condition instanceof Date) {
      return same(value, condition);
    }
    return Object.entries(condition as Row).every(([operator, operand]) => {
      switch (operator) {
        case 'in':
          return (operand as unknown[]).some((candidate) => same(value, candidate));
        case 'not':
          return !same(value, operand);
        case 'gte':
          return value !== null && value >= operand;
        case 'lte':
          return value !== null && value <= operand;
        case 'some':
          return (value as Row[]).some((item) => matches(item, operand));
        default:
          // A to-one relation: the filter applies to the related row.
          return matches(value, { [operator]: operand });
      }
    });
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

/** create: the written row, with the database's own columns, as selected. */
const answerCreate =
  (generated: Row) =>
  (query: Query = {}) => {
    refuseEmptySelect(query.select);
    return Promise.resolve(project({ ...generated, ...query.data }, query.select));
  };

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
    tx.academicYear.findUnique.mockImplementation(
      answerUnique([
        {
          id: YEAR_ID,
          startDate: day('2026-08-01'),
          endDate: day('2026-08-31'),
          school: { timezone: 'UTC' },
          ...overrides,
        },
      ]),
    );
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
    tx.rast.findMany.mockImplementation(answerRows(rasts));
    tx.studentGroup.findMany.mockImplementation(answerRows(groups));
    tx.calendarRast.create.mockResolvedValue({ id: 'created-rast' });
    tx.calendarRast.deleteMany.mockResolvedValue({ count: 0 });
    tx.masterLesson.findMany.mockImplementation(answerRows(templates));
    tx.calendarLesson.findMany.mockImplementation(answerRows(existing));
    tx.availabilityConstraint.findMany.mockImplementation(answerRows(closures));
    tx.schoolBreak.findMany.mockImplementation(answerRows(breaks));
    tx.calendarLesson.create.mockImplementation(answerCreate({ id: 'created-lesson' }));
    tx.lunchSitting.findMany.mockImplementation(answerRows(sittings));
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
      // And a lesson that runs carries no cancellation note for pupils to read.
      expect(data).not.toHaveProperty('note');
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

      it('publishes rasts only to the classes of the year being published', async () => {
        // Last year's 5A is a class in åk 5 as well, and would be handed this
        // year's breaks by a query that forgot which year it was asked about.
        arrangePublish([template()], {
          rasts: [rastRow()],
          groups: [
            { id: GROUP_ID, gradeLevel: 5, kind: 'CLASS', academicYearId: YEAR_ID },
            { id: 'last-years-5a', gradeLevel: 5, kind: 'CLASS', academicYearId: 'last-year' },
          ],
        });

        await publishOneDay();

        const classes = tx.calendarRast.create.mock.calls.map(
          ([call]) => (call as { data: { studentGroupId: string } }).data.studentGroupId,
        );
        expect(classes).toEqual([GROUP_ID]);
      });

      it("publishes this school's rasts as declared, and no other school's", async () => {
        arrangePublish([template()], {
          rasts: [
            { ...rastRow(), school: { academicYears: [{ id: YEAR_ID }] } },
            {
              ...rastRow({ name: 'Grannskolans rast' }),
              school: { academicYears: [{ id: 'grannskolans-lasar' }] },
            },
          ],
          groups: [{ id: GROUP_ID, gradeLevel: 5, kind: 'CLASS' }],
        });

        await publishOneDay();

        expect(tx.calendarRast.create.mock.calls.map(([call]) => call)).toEqual([
          {
            data: {
              schoolId: SCHOOL_ID,
              studentGroupId: GROUP_ID,
              name: 'Förmiddagsrast',
              date: day('2026-08-10'),
              startsAt: new Date('2026-08-10T09:40:00.000Z'),
              endsAt: new Date('2026-08-10T10:00:00.000Z'),
            },
          },
        ]);
      });

      it('serves every class that eats on the weekday, not only the last one read', async () => {
        arrangePublish([template()], {
          sittings: [sitting(), sitting({ studentGroupId: EXTRA_GROUP_ID })],
        });

        await publishOneDay();

        expect(lunchData().map((meal) => meal.studentGroupId)).toEqual([
          GROUP_ID,
          EXTRA_GROUP_ID,
        ]);
      });

      it('serves only the sittings of the year being published', async () => {
        arrangePublish([template()], {
          sittings: [
            sitting({ academicYearId: YEAR_ID }),
            sitting({ studentGroupId: 'last-years-5a', academicYearId: 'last-year' }),
          ],
        });

        await publishOneDay();

        expect(lunchData().map((meal) => meal.studentGroupId)).toEqual([GROUP_ID]);
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

      /*
       * Whose closure it is decides what is written, and only this lesson's own
       * teacher, co-teacher, room or class may decide it. Each case has a
       * neighbour that differs in exactly that.
       */
      const OTHER_TEACHER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      const OTHER_ROOM_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      const away = (overrides: Record<string, unknown>) =>
        closure({ resourceType: 'TEACHER', studentGroupId: null, ...overrides });

      it('cancels the lesson when its co-teacher is away', async () => {
        arrangePublish([template({ coTeacherId: CO_TEACHER_ID })], {
          closures: [away({ userId: CO_TEACHER_ID })],
        });

        await expect(publishOneDay()).resolves.toMatchObject({
          created: 0,
          cancelled: 1,
          skipped: 0,
        });
        expect(tx.calendarLesson.create.mock.calls[0]![0].data).toMatchObject({
          status: 'CANCELLED',
          note: 'Inställd: läraren är inte tillgänglig detta datum.',
        });
      });

      it('leaves the lesson alone when another teacher is away', async () => {
        arrangePublish([template()], { closures: [away({ userId: OTHER_TEACHER_ID })] });

        await expect(publishOneDay()).resolves.toMatchObject({
          created: 1,
          cancelled: 0,
          skipped: 0,
        });
      });

      it('cancels the lesson with the room note when its room is closed', async () => {
        // The note is what every pupil and guardian reads, so it says it was
        // the room — not that the teacher could not come.
        arrangePublish([template()], {
          closures: [closure({ resourceType: 'ROOM', studentGroupId: null, roomId: ROOM_ID })],
        });

        await expect(publishOneDay()).resolves.toMatchObject({
          created: 0,
          cancelled: 1,
          skipped: 0,
        });
        expect(tx.calendarLesson.create.mock.calls[0]![0].data).toMatchObject({
          status: 'CANCELLED',
          note: 'Inställd: salen är inte tillgänglig detta datum.',
        });
      });

      it('leaves the lesson alone when another room is closed', async () => {
        arrangePublish([template()], {
          closures: [
            closure({ resourceType: 'ROOM', studentGroupId: null, roomId: OTHER_ROOM_ID }),
          ],
        });

        await expect(publishOneDay()).resolves.toMatchObject({
          created: 1,
          cancelled: 0,
          skipped: 0,
        });
      });

      it('leaves a lesson with no room alone when a closure names no room either', async () => {
        // Idrott on the field has no room, and neither has a teacher closure.
        // Two missing rooms are not the same room.
        arrangePublish([template({ roomId: null })], {
          closures: [away({ userId: OTHER_TEACHER_ID })],
        });

        await expect(publishOneDay()).resolves.toMatchObject({
          created: 1,
          cancelled: 0,
          skipped: 0,
        });
      });

      it('leaves the lesson alone when another class is closed', async () => {
        arrangePublish([template()], {
          closures: [closure({ studentGroupId: EXTRA_GROUP_ID })],
        });

        await expect(publishOneDay()).resolves.toMatchObject({
          created: 1,
          cancelled: 0,
          skipped: 0,
        });
      });

      it('honours every closure on the date, not only the last one read', async () => {
        arrangePublish([template()], {
          closures: [closure(), away({ userId: OTHER_TEACHER_ID })],
        });

        await expect(publishOneDay()).resolves.toMatchObject({
          created: 0,
          cancelled: 0,
          skipped: 1,
        });
      });

      it.each([
        ['ends as the lesson begins', time(8), time(9)],
        ['begins as the lesson ends', time(10), time(11)],
        ['is over before the lesson begins', time(7), time(8)],
      ])('leaves the lesson alone when the closure %s', async (_label, startTime, endTime) => {
        // Touching is not covering, from either side.
        arrangePublish([template()], {
          closures: [away({ userId: TEACHER_ID, startTime, endTime })],
        });

        await expect(publishOneDay()).resolves.toMatchObject({ created: 1, cancelled: 0 });
      });

      /*
       * Only midnight to midnight, or to 23:59, is the whole day. A closure
       * that reaches one edge of the day still has hours, and a lesson outside
       * them is held.
       */
      it.each([
        ['from 13:00 to the end of the day', time(13), time(23, 59), template()],
        ['from midnight until 08:00', time(0), time(8), template()],
        [
          'from midnight until 22:30, against a lesson at 22:45',
          time(0),
          time(22, 30),
          template({ startTime: time(22, 45), endTime: time(23, 30) }),
        ],
      ])('reads a closure %s as part of a day', async (_label, startTime, endTime, lesson) => {
        arrangePublish([lesson], {
          closures: [away({ userId: TEACHER_ID, startTime, endTime })],
        });

        await expect(publishOneDay()).resolves.toMatchObject({ created: 1, cancelled: 0 });
      });

      it('reads no group years when only a teacher is away', async () => {
        arrangePublish([template()], { closures: [away({ userId: OTHER_TEACHER_ID })] });

        await publishOneDay();

        expect(tx.studentGroup.findMany).not.toHaveBeenCalled();
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

    describe('a closure for a span of years', () => {
      /** "Åk min–max cannot be taught today", as a GRADE_LEVEL row says it. */
      const yearsClosed = (minGradeLevel: number | null, maxGradeLevel: number | null) =>
        closure({
          resourceType: 'GRADE_LEVEL',
          studentGroupId: null,
          minGradeLevel,
          maxGradeLevel,
        });

      const closedDay = { created: 0, cancelled: 0, skipped: 1 };
      const heldLesson = { created: 1, cancelled: 0, skipped: 0 };

      /*
       * Both edges of a span, and both of its open ends. A class whose own year
       * sits inside is not in school, and nothing is written for it — the
       * answer a STUDENT_GROUP closure gives. A group with no year of its own
       * cannot be shown to be inside any span, and erasing its lesson on a
       * guess is the worse mistake.
       */
      it.each([
        ['inside åk 7–9', 7, 9, 8, closedDay],
        ['at the lower edge of åk 7–9', 7, 9, 7, closedDay],
        ['at the upper edge of åk 7–9', 7, 9, 9, closedDay],
        ['just below åk 7–9', 7, 9, 6, heldLesson],
        ['just above åk 7–9', 7, 9, 10, heldLesson],
        ['inside åk 9 and up', 9, null, 9, closedDay],
        ['below åk 9 and up', 9, null, 8, heldLesson],
        ['inside up to åk 3', null, 3, 3, closedDay],
        ['above up to åk 3', null, 3, 4, heldLesson],
        ['with no year, under up to åk 9', null, 9, null, heldLesson],
      ])('resolves a class %s', async (_label, min, max, gradeLevel, expected) => {
        arrangePublish([template()], {
          closures: [yearsClosed(min, max)],
          groups: [{ id: GROUP_ID, gradeLevel, kind: 'CLASS' }],
        });

        await expect(publishOneDay()).resolves.toMatchObject(expected);
      });

      it("does not read another resource's closure as one for the class's year", async () => {
        // A teacher closure names no span at all. Read as a span of years it
        // would be one that reaches every year, and close the class.
        arrangePublish([template()], {
          closures: [
            yearsClosed(1, 3),
            closure({
              resourceType: 'TEACHER',
              studentGroupId: null,
              userId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            }),
          ],
          groups: [{ id: GROUP_ID, gradeLevel: 8, kind: 'CLASS' }],
        });

        await expect(publishOneDay()).resolves.toMatchObject(heldLesson);
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

      /*
       * A span open at one end: "åk 7 and up", "up to åk 3". The bound that is
       * there still bounds; the one that is missing reaches as far as the
       * school goes.
       */
      it.each([
        ['åk 7 and up takes a group in åk 8', 7, null, 8, { created: 0, skipped: 1 }],
        ['åk 7 and up leaves a group in åk 4', 7, null, 4, { created: 1, skipped: 0 }],
        ['up to åk 3 takes a group in åk 2', null, 3, 2, { created: 0, skipped: 1 }],
        ['up to åk 3 leaves a group in åk 5', null, 3, 5, { created: 1, skipped: 0 }],
        ['up to åk 9 leaves a group with no year', null, 9, null, { created: 1, skipped: 0 }],
      ])(
        'reads a span open at one end: %s',
        async (_label, minGradeLevel, maxGradeLevel, gradeLevel, expected) => {
          arrangePublish([template()], {
            breaks: [schoolBreak({ minGradeLevel, maxGradeLevel })],
          });
          tx.studentGroup.findMany.mockResolvedValue([{ id: GROUP_ID, gradeLevel }]);

          await expect(publishOneDay()).resolves.toMatchObject(expected);
        },
      );

      it('reads group years when any break in the window names a span', async () => {
        // A studiedag for the whole school on the Tuesday and a prao for åk 7–9
        // on the Monday. The first needs no years and the second does; one
        // break asking is enough.
        arrangePublish([template()], {
          breaks: [
            schoolBreak({ startDate: day('2026-08-11'), endDate: day('2026-08-11') }),
            schoolBreak({ minGradeLevel: 7, maxGradeLevel: 9 }),
          ],
        });
        tx.studentGroup.findMany.mockResolvedValue([{ id: GROUP_ID, gradeLevel: 8 }]);

        await expect(
          service.publish(dto({ fromDate: '2026-08-10', toDate: '2026-08-11' }), testUser()),
        ).resolves.toMatchObject({ created: 0, skipped: 1 });
      });

      it('takes every break on a day, not only the last one read', async () => {
        // A lov for the whole school and a prao for the lower years on the same
        // Monday. The class is in åk 8, so it is the lov that sends it home.
        arrangePublish([template()], {
          breaks: [schoolBreak(), schoolBreak({ minGradeLevel: 1, maxGradeLevel: 3 })],
        });
        tx.studentGroup.findMany.mockResolvedValue([{ id: GROUP_ID, gradeLevel: 8 }]);

        await expect(publishOneDay()).resolves.toMatchObject({ created: 0, skipped: 1 });
      });

      it('reads no group years for a publish with no breaks, closures or rasts', async () => {
        arrangePublish([template()]);

        await publishOneDay();

        expect(tx.studentGroup.findMany).not.toHaveBeenCalled();
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

    it('writes each lesson once when the window holds more than one batch of them', async () => {
      // The writes go out fifty at a time. Eleven Monday lessons over the five
      // Mondays of August make fifty-five: one full batch and the start of a
      // second, which must not replay the first.
      arrangePublish(
        Array.from({ length: 11 }, (_, index) => template({ id: `monday-${index}` })),
      );

      await expect(
        service.publish(dto({ fromDate: '2026-08-01', toDate: '2026-08-31' }), testUser()),
      ).resolves.toMatchObject({ created: 55 });
      expect(tx.calendarLesson.create).toHaveBeenCalledTimes(55);
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
        new NotFoundException('Academic year not found.'),
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
