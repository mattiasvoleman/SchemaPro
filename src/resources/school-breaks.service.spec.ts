import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
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
import { lockingRead, rawSql, transactionsOf, type LockedTable } from '../../test/utils/locking-read';
import type { PrismaService } from '../database/prisma.service';
import { SchoolBreaksService } from './school-breaks.service';
import type {
  CreateSchoolBreakDto,
  UpdateSchoolBreakDto,
} from './dto/school-break.dto';

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const YEAR_ID = '99999999-9999-4999-8999-999999999999';
const BREAK_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

/** Frozen "now", so "future lessons only" means the same thing every run. */
const NOW = new Date('2027-02-10T09:00:00.000Z');
/** A real zone, not UTC: the purge's "today" is the school's day, and a zone
 *  that is always +00:00 cannot show an off-by-a-day. */
const SCHOOL_TIMEZONE = 'Europe/Stockholm';

/** The läsår every range in these tests is measured against. */
const YEAR = {
  startDate: new Date('2026-08-17T00:00:00.000Z'),
  endDate: new Date('2027-06-11T00:00:00.000Z'),
};

/**
 * AcademicYears as a period writer's read of the year has to name it: FOR
 * SHARE, the lock a year PATCH moving the bounds waits on.
 */
const YEARS: LockedTable = {
  name: 'AcademicYears',
  columns: [
    'id', 'schoolId', 'name', 'startDate', 'endDate', 'isActive', 'createdAt',
    'updatedAt',
  ],
  lock: 'FOR SHARE',
};

/** The SQL of that read, as the tagged template sends it. */
const YEAR_READ =
  /SELECT "startDate", "endDate"\s+FROM "AcademicYears"\s+WHERE "id" = \?::uuid\s+FOR SHARE/;

const date = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

const prismaError = (code: string): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError(`Simulated ${code}`, {
    code,
    clientVersion: Prisma.prismaVersion.client,
  });

type Selection = Record<string, unknown>;

/**
 * What Prisma hands back for a `select`: the fields asked for and nothing else,
 * a relation through its own nested `select` (or whole, when it is named
 * without one), and a refusal for a selection with no truthy field in it
 * ("needs at least one truthy value"). A stub that returns the whole row
 * whatever the query asked for lets a read that forgets a field feed
 * `undefined` to the check behind it — and every check in this service passes
 * on `undefined`.
 */
function selected(
  row: Record<string, unknown>,
  select?: Selection,
): Record<string, unknown> {
  if (select === undefined) return row;
  const fields = Object.entries(select).filter(([, value]) => value);
  if (fields.length === 0) {
    throw new Error('Prisma: a `select` needs at least one truthy value.');
  }
  return Object.fromEntries(
    fields.map(([field, value]) => {
      const nested = (value as { select?: Selection }).select;
      const related = row[field];
      if (!nested) return [field, related];
      return [
        field,
        Array.isArray(related)
          ? related.map((entry: Record<string, unknown>) => selected(entry, nested))
          : selected(related as Record<string, unknown>, nested),
      ];
    }),
  );
}

/** A `findUnique` that finds `row` by its id, and nothing by anything else. */
const byId =
  (id: string, row: Record<string, unknown>) =>
  ({ where, select }: { where?: { id?: string }; select?: Selection }) => {
    if (where?.id === undefined) {
      throw new Error('Prisma: findUnique needs a unique field in `where`.');
    }
    return Promise.resolve(where.id === id ? selected(row, select) : null);
  };

/** A stored break, as `create`/`update` hand it back from the database. */
const storedBreak = (overrides: Record<string, unknown> = {}) => ({
  id: BREAK_ID,
  schoolId: SCHOOL_ID,
  academicYearId: YEAR_ID,
  name: 'Sportlov',
  kind: 'HOLIDAY',
  startDate: date('2027-02-22'),
  endDate: date('2027-02-26'),
  minGradeLevel: null,
  maxGradeLevel: null,
  ...overrides,
});

// ---------------------------------------------------------------------------
// A calendar the delete actually runs against.
//
// Asserting the `where` object literally would prove the service builds the
// filter someone typed, which is the same thing twice — rename `status` to
// `state` in both places and the test still passes while every lesson in the
// school survives. So the fixtures below are filtered BY the where clause the
// service produced, and the tests name the lessons that must be gone.
//
// The interpreter understands exactly the keys this service emits and THROWS on
// anything else. That is the point: dropping a protection makes extra lessons
// disappear and fails a test, and adding a condition the interpreter has never
// heard of fails loudly instead of being silently ignored.
// ---------------------------------------------------------------------------

interface FixtureLesson {
  id: string;
  date: string;
  status: string;
  hasAttendance: boolean;
  gradeLevel: number | null;
}

const lesson = (overrides: Partial<FixtureLesson>): FixtureLesson => ({
  id: 'lesson',
  date: '2027-02-23',
  status: 'SCHEDULED',
  hasAttendance: false,
  gradeLevel: 8,
  ...overrides,
});

function matches(
  where: Record<string, unknown>,
  row: FixtureLesson,
): boolean {
  let keep = true;
  for (const [key, condition] of Object.entries(where)) {
    switch (key) {
      case 'date': {
        const { gte, lte, ...rest } = condition as {
          gte: Date;
          lte: Date;
        } & Record<string, unknown>;
        if (Object.keys(rest).length > 0) {
          throw new Error(`Unhandled date condition: ${Object.keys(rest)}`);
        }
        keep &&= date(row.date) >= gte && date(row.date) <= lte;
        break;
      }
      case 'status':
        keep &&= row.status === condition;
        break;
      case 'attendanceRecords':
        expect(condition).toEqual({ none: {} });
        keep &&= !row.hasAttendance;
        break;
      case 'studentGroup': {
        const { gte, lte } = (
          condition as { is: { gradeLevel: { gte: unknown; lte: unknown } } }
        ).is.gradeLevel;
        // Prisma refuses a null bound on an Int filter, so a half-stated span
        // that reaches the delete as one is a failed request, not a filter.
        if (typeof gte !== 'number' || typeof lte !== 'number') {
          throw new Error(`A grade filter needs two numeric bounds, got ${gte} and ${lte}`);
        }
        // NULL is not a number and matches neither bound — the behaviour the
        // service relies on for teaching groups, restated here rather than
        // inherited, so the fixture cannot pass by accident.
        keep &&=
          row.gradeLevel !== null && row.gradeLevel >= gte && row.gradeLevel <= lte;
        break;
      }
      default:
        throw new Error(`The delete filter grew a condition tests do not know: ${key}`);
    }
  }
  return keep;
}

describe('SchoolBreaksService', () => {
  let service: SchoolBreaksService;
  let tx: TxMock;
  let prisma: PrismaMock;
  /** Whatever survived the last purge, in fixture order. */
  let survivors: FixtureLesson[];
  /** The years the read of the bounds can find: none until a test stores one. */
  let years: Record<string, unknown>[];
  /** The read of the year's bounds. */
  let queryRaw: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new SchoolBreaksService(prisma as unknown as PrismaService);
    survivors = [];
    years = [];
    // The auto-vivifying mock would hand back a model proxy for `$queryRaw`,
    // and a proxy is not callable. It answers as the table would, from the
    // year a test stored, and throws on a read that takes another lock or
    // none. A year nobody stored is one RLS hides.
    queryRaw = jest.fn((...call: unknown[]) =>
      Promise.resolve(lockingRead(YEARS, years, call)),
    );
    Object.assign(tx, { $queryRaw: queryRaw });
    tx.calendarLesson.deleteMany.mockResolvedValue({ count: 0 });
    // The purge reads the school to learn its timezone, because "today" has to
    // be the school's day and not the server's — an hour after midnight in
    // Stockholm the UTC day is still yesterday, and this number decides which
    // lessons may be deleted.
    tx.school.findUnique.mockImplementation(
      byId(SCHOOL_ID, { id: SCHOOL_ID, name: 'Ekbackeskolan', timezone: SCHOOL_TIMEZONE }),
    );
  });

  /** The läsår, stored where the read of the bounds finds it by its own id. */
  const givenYear = (): void => {
    years = [
      { id: YEAR_ID, schoolId: SCHOOL_ID, name: '2026/2027', isActive: true, ...YEAR },
    ];
  };

  afterEach(() => {
    jest.useRealTimers();
  });

  /** Runs the service's own delete filter over `lessons`; returns the deleted. */
  const givenCalendar = (lessons: FixtureLesson[]): void => {
    tx.calendarLesson.deleteMany.mockImplementation(
      ({ where }: { where: Record<string, unknown> }) => {
        const deleted = lessons.filter((row) => matches(where, row));
        survivors = lessons.filter((row) => !deleted.includes(row));
        return Promise.resolve({ count: deleted.length });
      },
    );
  };

  const dto = (
    overrides: Partial<CreateSchoolBreakDto> = {},
  ): CreateSchoolBreakDto => ({
    academicYearId: YEAR_ID,
    name: 'Sportlov',
    startDate: '2027-02-22',
    endDate: '2027-02-26',
    ...overrides,
  });

  describe('create', () => {
    it('stores an inclusive, school-wide range', async () => {
      givenYear();
      tx.schoolBreak.create.mockResolvedValue(storedBreak());
      const user = testUser();

      await service.create(dto(), user);

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.schoolBreak.create).toHaveBeenCalledWith({
        data: {
          schoolId: SCHOOL_ID,
          academicYearId: YEAR_ID,
          name: 'Sportlov',
          startDate: date('2027-02-22'),
          endDate: date('2027-02-26'),
          minGradeLevel: null,
          maxGradeLevel: null,
        },
      });
    });

    it('stores the grade span it was given, and the kind', async () => {
      /*
       * Nothing checked this, and the failure is not small: a prao for åk 9
       * whose span is dropped on the way in becomes a SCHOOL-WIDE lov, and the
       * purge that runs a line later deletes every group's lessons for that
       * week. The row above only ever asserted the school-wide shape, which is
       * exactly what the bug produces.
       */
      givenYear();
      tx.schoolBreak.create.mockResolvedValue(
        storedBreak({ kind: 'STAFF_DAY', minGradeLevel: 7, maxGradeLevel: 9 }),
      );

      await service.create(
        dto({ kind: 'STAFF_DAY', minGradeLevel: 7, maxGradeLevel: 9 }),
        testUser(),
      );

      const { data } = tx.schoolBreak.create.mock.calls[0][0];
      expect(data).toMatchObject({
        kind: 'STAFF_DAY',
        minGradeLevel: 7,
        maxGradeLevel: 9,
      });
    });

    it('keeps a zero lower bound, which is a real year and not an absent one', async () => {
      // Förskoleklass is grade 0, and `0 || null` is null. A span written that
      // way silently widens "åk 0-3" into a school-wide lov.
      givenYear();
      tx.schoolBreak.create.mockResolvedValue(
        storedBreak({ minGradeLevel: 0, maxGradeLevel: 3 }),
      );

      await service.create(dto({ minGradeLevel: 0, maxGradeLevel: 3 }), testUser());

      const { data } = tx.schoolBreak.create.mock.calls[0][0];
      expect(data.minGradeLevel).toBe(0);
      expect(data.maxGradeLevel).toBe(3);
    });

    it('answers with the range as dates, not as invented midnight instants', async () => {
      givenYear();
      tx.schoolBreak.create.mockResolvedValue(storedBreak());

      await expect(service.create(dto(), testUser())).resolves.toMatchObject({
        startDate: '2027-02-22',
        endDate: '2027-02-26',
      });
    });

    // AcademicYearsService.update counts the lov outside the bounds it is about
    // to store, and this create measures the range against the bounds it
    // reads. withRls runs READ COMMITTED, so read without a lock the two pass
    // each other: the PATCH counts before the lov commits, the lov reads the
    // bounds before the PATCH commits, and both land a lov outside its year,
    // where it no longer keeps lessons out of the week it closes. FOR SHARE is
    // what the PATCH's FOR NO KEY UPDATE waits on, and it holds only while the
    // transaction that took it is open.
    it('reads the year FOR SHARE, in the transaction that stores the lov', async () => {
      givenYear();
      tx.schoolBreak.create.mockResolvedValue(storedBreak());
      const ranIn = transactionsOf(prisma);
      const readIn = ranIn(queryRaw);
      const createdIn = ranIn(tx.schoolBreak.create);

      await service.create(dto(), testUser());

      expect(readIn).toEqual([expect.stringMatching(/^withRls#\d+$/)]);
      expect(createdIn).toEqual(readIn);
      const [call] = queryRaw.mock.calls;
      expect(rawSql(call)).toMatch(YEAR_READ);
      expect(call.slice(1)).toEqual([YEAR_ID]);
      expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.schoolBreak.create.mock.invocationCallOrder[0],
      );
    });

    it('refuses a range that reaches past the end of the läsår', async () => {
      givenYear();

      await expect(
        service.create(
          dto({ startDate: '2027-06-08', endDate: '2027-06-20' }),
          testUser(),
        ),
      ).rejects.toThrow(
        // Names the field and the year's own bounds: the admin has to know
        // which date picker to move, and how far.
        new BadRequestException(
          'endDate must fall inside the academic year (2026-08-17 to 2027-06-11).',
        ),
      );
      expect(tx.schoolBreak.create).not.toHaveBeenCalled();
      expect(tx.calendarLesson.deleteMany).not.toHaveBeenCalled();
    });

    it('refuses a range that starts before the läsår does', async () => {
      givenYear();

      // The whole point of the containment check: this lov belongs to LAST
      // year, and saving it would delete a week of that year's lessons.
      await expect(
        service.create(
          dto({ startDate: '2026-02-22', endDate: '2026-02-26' }),
          testUser(),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(tx.schoolBreak.create).not.toHaveBeenCalled();
    });

    it('accepts a range that ends exactly on the last day of the läsår', async () => {
      givenYear();
      tx.schoolBreak.create.mockResolvedValue(storedBreak());

      // Both bounds are inclusive; the last day of the year is inside it.
      await expect(
        service.create(
          dto({ startDate: '2027-06-11', endDate: '2027-06-11' }),
          testUser(),
        ),
      ).resolves.toBeDefined();
    });

    it('accepts a range that starts exactly on the first day of the läsår', async () => {
      // The other inclusive edge: uppstartsdagar on the year's very first day.
      givenYear();
      tx.schoolBreak.create.mockResolvedValue(
        storedBreak({ startDate: date('2026-08-17'), endDate: date('2026-08-18') }),
      );

      await expect(
        service.create(
          dto({ startDate: '2026-08-17', endDate: '2026-08-18' }),
          testUser(),
        ),
      ).resolves.toBeDefined();
    });

    it('refuses an end before its start instead of letting the CHECK 500', async () => {
      givenYear();

      await expect(
        service.create(
          dto({ startDate: '2027-02-26', endDate: '2027-02-22' }),
          testUser(),
        ),
      ).rejects.toThrow(new BadRequestException('endDate must not be before startDate.'));
      expect(tx.schoolBreak.create).not.toHaveBeenCalled();
    });

    it('refuses half a year span', async () => {
      await expect(
        service.create(dto({ minGradeLevel: 9 }), testUser()),
      ).rejects.toThrow(
        new BadRequestException('State both minGradeLevel and maxGradeLevel, or neither.'),
      );
      // Refused before the transaction opens: nothing about the year is even
      // asked, so a malformed span cannot cost a round trip.
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('refuses an inverted year span', async () => {
      await expect(
        service.create(
          dto({ minGradeLevel: 9, maxGradeLevel: 4 }),
          testUser(),
        ),
      ).rejects.toThrow(
        new BadRequestException('minGradeLevel must not be greater than maxGradeLevel.'),
      );
    });

    it('says nothing about a year RLS hides, and lets the FK refuse it', async () => {
      // No year stored: the read of the bounds finds no row, which is what a
      // year belonging to another school reads as.
      tx.schoolBreak.create.mockRejectedValue(prismaError('P2003'));

      // Not 400 "outside its year": that answer would confirm the year exists.
      await expect(service.create(dto(), testUser())).rejects.toThrow(
        ConflictException,
      );
      expect(tx.schoolBreak.create).toHaveBeenCalled();
    });

    it('rejects a principal with no school', async () => {
      await expect(
        service.create(dto(), testUser({ schoolId: undefined })),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.withRls).not.toHaveBeenCalled();
    });
  });

  describe('the lessons a break throws away', () => {
    beforeEach(() => {
      givenYear();
    });

    it('removes the future scheduled lessons inside the range and nothing else', async () => {
      tx.schoolBreak.create.mockResolvedValue(storedBreak());
      const inside = lesson({ id: 'inside', date: '2027-02-23' });
      const firstDay = lesson({ id: 'first-day', date: '2027-02-22' });
      const lastDay = lesson({ id: 'last-day', date: '2027-02-26' });
      const dayBefore = lesson({ id: 'day-before', date: '2027-02-21' });
      const dayAfter = lesson({ id: 'day-after', date: '2027-02-27' });
      givenCalendar([inside, firstDay, lastDay, dayBefore, dayAfter]);

      const result = await service.create(dto(), testUser());

      // Both ends inclusive: the day the lov starts and the day it ends go.
      expect(result.removedCalendarLessons).toBe(3);
      expect(survivors.map((row) => row.id)).toEqual([
        'day-before',
        'day-after',
      ]);
    });

    it('leaves the protected lessons standing', async () => {
      tx.schoolBreak.create.mockResolvedValue(storedBreak());
      const ordinary = lesson({ id: 'ordinary' });
      const cancelled = lesson({ id: 'cancelled', status: 'CANCELLED' });
      const completed = lesson({ id: 'completed', status: 'COMPLETED' });
      const registered = lesson({ id: 'registered', hasAttendance: true });
      givenCalendar([ordinary, cancelled, completed, registered]);

      const result = await service.create(dto(), testUser());

      // What already happened, was cancelled by hand, or had a register taken
      // against it is a record of the school's day and is not a lov's to edit.
      expect(result.removedCalendarLessons).toBe(1);
      expect(survivors.map((row) => row.id)).toEqual([
        'cancelled',
        'completed',
        'registered',
      ]);
    });

    it('trims a lov that started before today instead of rewriting the past', async () => {
      tx.schoolBreak.create.mockResolvedValue(
        storedBreak({
          startDate: date('2027-02-08'),
          endDate: date('2027-02-12'),
        }),
      );
      const beforeToday = lesson({ id: 'before-today', date: '2027-02-09' });
      const today = lesson({ id: 'today', date: '2027-02-10' });
      const afterToday = lesson({ id: 'after-today', date: '2027-02-11' });
      givenCalendar([beforeToday, today, afterToday]);

      const result = await service.create(
        dto({ startDate: '2027-02-08', endDate: '2027-02-12' }),
        testUser(),
      );

      // Today counts as future — the lessons have not been taught yet.
      expect(result.removedCalendarLessons).toBe(2);
      expect(survivors.map((row) => row.id)).toEqual(['before-today']);
    });

    it("uses the SCHOOL's today, not the server's, when it trims", async () => {
      /*
       * 23:30 UTC on the 10th is 00:30 on the 11th in Stockholm. Rounding
       * `new Date()` down in UTC therefore says "today is the 10th" — a day the
       * school has already taught in full — and the purge would take its
       * lessons while the comment above it promises the past is left alone.
       *
       * The window is an hour or two after local midnight, every night, which
       * is exactly when a bulk job or a tired administrator is plausible.
       */
      jest.setSystemTime(new Date('2027-02-10T23:30:00.000Z'));
      tx.schoolBreak.create.mockResolvedValue(
        storedBreak({
          startDate: date('2027-02-08'),
          endDate: date('2027-02-12'),
        }),
      );
      const alreadyTaught = lesson({ id: 'the-10th', date: '2027-02-10' });
      const stillToCome = lesson({ id: 'the-11th', date: '2027-02-11' });
      givenCalendar([alreadyTaught, stillToCome]);

      const result = await service.create(
        dto({ startDate: '2027-02-08', endDate: '2027-02-12' }),
        testUser(),
      );

      expect(result.removedCalendarLessons).toBe(1);
      expect(survivors.map((row) => row.id)).toEqual(['the-10th']);
    });

    it('purges nothing when the school itself cannot be read', async () => {
      // Unreachable for a caller's own school, and the recoverable half if it
      // ever happens: a lesson left standing on a lov day is visible in the
      // calendar the admin is already looking at.
      tx.school.findUnique.mockResolvedValue(null);
      tx.schoolBreak.create.mockResolvedValue(
        storedBreak({
          startDate: date('2027-02-15'),
          endDate: date('2027-02-19'),
        }),
      );
      givenCalendar([lesson({ id: 'inside', date: '2027-02-16' })]);

      const result = await service.create(
        dto({ startDate: '2027-02-15', endDate: '2027-02-19' }),
        testUser(),
      );

      expect(result.removedCalendarLessons).toBe(0);
      expect(tx.calendarLesson.deleteMany).not.toHaveBeenCalled();
    });

    it('removes nothing at all for a lov that is entirely behind us', async () => {
      tx.schoolBreak.create.mockResolvedValue(
        storedBreak({
          startDate: date('2026-10-26'),
          endDate: date('2026-10-30'),
        }),
      );
      givenCalendar([lesson({ id: 'höstlov', date: '2026-10-28' })]);

      const result = await service.create(
        dto({ startDate: '2026-10-26', endDate: '2026-10-30' }),
        testUser(),
      );

      expect(result.removedCalendarLessons).toBe(0);
      expect(survivors.map((row) => row.id)).toEqual(['höstlov']);
    });

    it('lets a prao for åk 9 leave every other year alone', async () => {
      tx.schoolBreak.create.mockResolvedValue(
        storedBreak({ name: 'Prao åk 9', minGradeLevel: 9, maxGradeLevel: 9 }),
      );
      const nine = lesson({ id: 'åk9', gradeLevel: 9 });
      const eight = lesson({ id: 'åk8', gradeLevel: 8 });
      const seven = lesson({ id: 'åk7', gradeLevel: 7 });
      givenCalendar([nine, eight, seven]);

      const result = await service.create(
        dto({ name: 'Prao åk 9', minGradeLevel: 9, maxGradeLevel: 9 }),
        testUser(),
      );

      expect(result.removedCalendarLessons).toBe(1);
      expect(survivors.map((row) => row.id)).toEqual(['åk8', 'åk7']);
    });

    it('covers every year inside a wider span, inclusive at both ends', async () => {
      tx.schoolBreak.create.mockResolvedValue(
        storedBreak({ minGradeLevel: 4, maxGradeLevel: 6 }),
      );
      givenCalendar([
        lesson({ id: 'åk3', gradeLevel: 3 }),
        lesson({ id: 'åk4', gradeLevel: 4 }),
        lesson({ id: 'åk5', gradeLevel: 5 }),
        lesson({ id: 'åk6', gradeLevel: 6 }),
        lesson({ id: 'åk7', gradeLevel: 7 }),
      ]);

      const result = await service.create(
        dto({ minGradeLevel: 4, maxGradeLevel: 6 }),
        testUser(),
      );

      expect(result.removedCalendarLessons).toBe(3);
      expect(survivors.map((row) => row.id)).toEqual(['åk3', 'åk7']);
    });

    it('spares a teaching group, which has no year to be inside the span', async () => {
      tx.schoolBreak.create.mockResolvedValue(
        storedBreak({ minGradeLevel: 9, maxGradeLevel: 9 }),
      );
      const spanska = lesson({ id: 'spanska', gradeLevel: null });
      givenCalendar([spanska, lesson({ id: 'åk9', gradeLevel: 9 })]);

      const result = await service.create(
        dto({ minGradeLevel: 9, maxGradeLevel: 9 }),
        testUser(),
      );

      // Deliberate, and the safe direction: a språkval lesson that should have
      // gone is visible on a lov day in the calendar the admin is already
      // looking at. One deleted by mistake looks like a lesson that was never
      // scheduled and is found by a teacher in an empty room.
      expect(result.removedCalendarLessons).toBe(1);
      expect(survivors.map((row) => row.id)).toEqual(['spanska']);
    });

    it('takes a school-wide lov across every group, year or none', async () => {
      tx.schoolBreak.create.mockResolvedValue(storedBreak());
      givenCalendar([
        lesson({ id: 'åk1', gradeLevel: 1 }),
        lesson({ id: 'åk9', gradeLevel: 9 }),
        lesson({ id: 'spanska', gradeLevel: null }),
      ]);

      const result = await service.create(dto(), testUser());

      // No span means no group filter, so the teaching group goes too — the
      // school is shut and there is nobody to teach it.
      expect(result.removedCalendarLessons).toBe(3);
      expect(survivors).toEqual([]);
    });

    it.each([
      ['a lower year and no upper one', { minGradeLevel: 7, maxGradeLevel: null }],
      ['an upper year and no lower one', { minGradeLevel: null, maxGradeLevel: 7 }],
    ])('purges a row stating only %s as the whole school, never as half a range', async (_half, span) => {
      /*
       * The table's CHECK and assertGradeSpanIsWhole keep this row from being
       * written today. The purge tests the pair anyway so that a row some
       * future path writes cannot become a filter with one bound — which Prisma
       * refuses, failing the save — or one that quietly spares the years on the
       * open side. Read from the row the update hands back, because that is the
       * row the purge reads.
       */
      tx.schoolBreak.findUnique.mockImplementation(
        byId(BREAK_ID, { ...storedBreak(), academicYear: { id: YEAR_ID, ...YEAR } }),
      );
      tx.schoolBreak.update.mockResolvedValue(storedBreak(span));
      givenCalendar([
        lesson({ id: 'åk8', gradeLevel: 8 }),
        lesson({ id: 'åk3', gradeLevel: 3 }),
      ]);

      const result = await service.update(BREAK_ID, { name: 'Studiedag' }, testUser());

      expect(result.removedCalendarLessons).toBe(2);
      expect(survivors).toEqual([]);
    });
  });

  describe('update', () => {
    /**
     * The row as stored, read back through the query sent for it, and its year
     * where the read of the bounds finds it by the id the row names.
     */
    const givenExisting = (overrides: Record<string, unknown> = {}) => {
      givenYear();
      tx.schoolBreak.findUnique.mockImplementation(
        byId(BREAK_ID, { ...storedBreak(), ...overrides }),
      );
    };

    it('sends only the fields the PATCH carried', async () => {
      givenExisting();
      tx.schoolBreak.update.mockResolvedValue(storedBreak({ name: 'Vinterlov' }));

      await service.update(BREAK_ID, { name: 'Vinterlov' }, testUser());

      expect(tx.schoolBreak.update).toHaveBeenCalledWith({
        where: { id: BREAK_ID },
        data: { name: 'Vinterlov' },
      });
    });

    it('measures a one-sided move against the date already on the row', async () => {
      givenExisting();

      // Nothing in this PATCH is wrong on its own; it is wrong against the
      // start it inherits, which is why the row is read first.
      await expect(
        service.update(BREAK_ID, { endDate: '2027-02-20' }, testUser()),
      ).rejects.toThrow(BadRequestException);
      expect(tx.schoolBreak.update).not.toHaveBeenCalled();
      expect(tx.calendarLesson.deleteMany).not.toHaveBeenCalled();
    });

    it('refuses a move that walks the range out of its läsår', async () => {
      givenExisting();

      await expect(
        service.update(BREAK_ID, { startDate: '2026-07-01' }, testUser()),
      ).rejects.toThrow(BadRequestException);
      expect(tx.schoolBreak.update).not.toHaveBeenCalled();
    });

    it('refuses a PATCH that clears only one half of the year span', async () => {
      givenExisting({ minGradeLevel: 4, maxGradeLevel: 6 });

      await expect(
        service.update(BREAK_ID, { maxGradeLevel: null }, testUser()),
      ).rejects.toThrow(BadRequestException);
      expect(tx.schoolBreak.update).not.toHaveBeenCalled();
    });

    it('refuses a start moved past the end already on the row', async () => {
      // The mirror of the one-sided move above: only the start is sent, and it
      // is wrong against the end it inherits.
      givenExisting();

      await expect(
        service.update(BREAK_ID, { startDate: '2027-03-01' }, testUser()),
      ).rejects.toThrow(new BadRequestException('endDate must not be before startDate.'));
      expect(tx.schoolBreak.update).not.toHaveBeenCalled();
    });

    it('refuses a move that walks the end out of its läsår', async () => {
      givenExisting();

      await expect(
        service.update(BREAK_ID, { endDate: '2027-07-01' }, testUser()),
      ).rejects.toThrow(
        new BadRequestException(
          'endDate must fall inside the academic year (2026-08-17 to 2027-06-11).',
        ),
      );
      expect(tx.schoolBreak.update).not.toHaveBeenCalled();
    });

    it('refuses a PATCH that pushes the lower year past the stored upper one', async () => {
      givenExisting({ minGradeLevel: 4, maxGradeLevel: 6 });

      await expect(
        service.update(BREAK_ID, { minGradeLevel: 9 }, testUser()),
      ).rejects.toThrow(
        new BadRequestException('minGradeLevel must not be greater than maxGradeLevel.'),
      );
      expect(tx.schoolBreak.update).not.toHaveBeenCalled();
    });

    it.each([
      ['the lower year', { minGradeLevel: 5 }],
      ['the upper year', { maxGradeLevel: 5 }],
    ])('moves %s inside the stored span, keeping the other', async (_bound, patch) => {
      // The bound not sent comes from the row. Read it as absent instead and
      // åk 5-6 turns into half a span, refused, for an edit that was fine.
      givenExisting({ minGradeLevel: 4, maxGradeLevel: 6 });
      tx.schoolBreak.update.mockResolvedValue(
        storedBreak({ minGradeLevel: 4, maxGradeLevel: 6, ...patch }),
      );

      await service.update(BREAK_ID, patch, testUser());

      expect(tx.schoolBreak.update).toHaveBeenCalledWith({
        where: { id: BREAK_ID },
        data: patch,
      });
    });

    it('can widen a span back to the whole school', async () => {
      givenExisting({ minGradeLevel: 4, maxGradeLevel: 6 });
      tx.schoolBreak.update.mockResolvedValue(storedBreak());

      await service.update(
        BREAK_ID,
        { minGradeLevel: null, maxGradeLevel: null },
        testUser(),
      );

      expect(tx.schoolBreak.update).toHaveBeenCalledWith({
        where: { id: BREAK_ID },
        data: { minGradeLevel: null, maxGradeLevel: null },
      });
    });

    it.each<[string, UpdateSchoolBreakDto, Record<string, unknown>]>([
      ['the kind', { kind: 'STAFF_DAY' }, { kind: 'STAFF_DAY' }],
      ['the start', { startDate: '2027-02-23' }, { startDate: date('2027-02-23') }],
      ['the end', { endDate: '2027-02-25' }, { endDate: date('2027-02-25') }],
      [
        'a year span',
        { minGradeLevel: 7, maxGradeLevel: 9 },
        { minGradeLevel: 7, maxGradeLevel: 9 },
      ],
    ])('writes %s when that is what the PATCH names', async (_field, patch, data) => {
      // A field dropped on the way to the write answers 200 and changes
      // nothing — except that the purge then runs against the old range.
      givenExisting();
      tx.schoolBreak.update.mockResolvedValue(storedBreak());

      await service.update(BREAK_ID, patch, testUser());

      expect(tx.schoolBreak.update).toHaveBeenCalledWith({
        where: { id: BREAK_ID },
        data,
      });
    });

    it('deletes the lessons of the range the row now holds, not the one it held', async () => {
      givenExisting();
      tx.schoolBreak.update.mockResolvedValue(
        storedBreak({
          startDate: date('2027-03-01'),
          endDate: date('2027-03-05'),
        }),
      );
      const oldWeek = lesson({ id: 'old-week', date: '2027-02-23' });
      const newWeek = lesson({ id: 'new-week', date: '2027-03-03' });
      givenCalendar([oldWeek, newWeek]);

      const result = await service.update(
        BREAK_ID,
        { startDate: '2027-03-01', endDate: '2027-03-05' },
        testUser(),
      );

      // The old week's lessons were deleted when the lov was created and are
      // not coming back; a move only reaches the week it moved to.
      expect(result.removedCalendarLessons).toBe(1);
      expect(survivors.map((row) => row.id)).toEqual(['old-week']);
    });

    it('carries the count back on a move so the UI can say it', async () => {
      givenExisting();
      tx.schoolBreak.update.mockResolvedValue(storedBreak());
      givenCalendar([
        lesson({ id: 'a', date: '2027-02-23' }),
        lesson({ id: 'b', date: '2027-02-24' }),
      ]);

      await expect(
        service.update(BREAK_ID, { startDate: '2027-02-22' }, testUser()),
      ).resolves.toEqual(
        expect.objectContaining({
          id: BREAK_ID,
          startDate: '2027-02-22',
          endDate: '2027-02-26',
          removedCalendarLessons: 2,
        }),
      );
    });

    it('reconciles the range even when only the name changed', async () => {
      givenExisting();
      tx.schoolBreak.update.mockResolvedValue(storedBreak({ name: 'Vinterlov' }));
      givenCalendar([lesson({ id: 'crept-in', date: '2027-02-23' })]);

      const result = await service.update(
        BREAK_ID,
        { name: 'Vinterlov' },
        testUser(),
      );

      // A lesson materialized into the range after the lov was saved must not
      // survive every later edit of the row that says it cannot exist.
      expect(result.removedCalendarLessons).toBe(1);
    });

    it('reads the break’s own year FOR SHARE, in the transaction that moves it', async () => {
      givenExisting();
      tx.schoolBreak.update.mockResolvedValue(storedBreak({ endDate: date('2027-03-05') }));
      const ranIn = transactionsOf(prisma);
      const readIn = ranIn(queryRaw);
      const updatedIn = ranIn(tx.schoolBreak.update);

      await service.update(BREAK_ID, { endDate: '2027-03-05' }, testUser());

      // The same race as create()'s, from a PATCH: the year the break belongs
      // to is the one whose next move has to wait, so that is the id locked.
      expect(readIn).toEqual([expect.stringMatching(/^withRls#\d+$/)]);
      expect(updatedIn).toEqual(readIn);
      const [call] = queryRaw.mock.calls;
      expect(rawSql(call)).toMatch(YEAR_READ);
      expect(call.slice(1)).toEqual([YEAR_ID]);
      expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.schoolBreak.update.mock.invocationCallOrder[0],
      );
    });

    it('leaves an unreadable row to update()’s own 404', async () => {
      tx.schoolBreak.findUnique.mockResolvedValue(null);
      tx.schoolBreak.update.mockRejectedValue(prismaError('P2025'));

      await expect(
        service.update(BREAK_ID, { startDate: '2027-02-22' }, testUser()),
      ).rejects.toThrow(NotFoundException);
      expect(tx.calendarLesson.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('returns the year’s breaks in calendar order, with dates as strings', async () => {
      tx.schoolBreak.findMany.mockResolvedValue([storedBreak()]);
      const user = testUser();

      await expect(service.list(YEAR_ID, user)).resolves.toEqual([
        expect.objectContaining({
          id: BREAK_ID,
          startDate: '2027-02-22',
          endDate: '2027-02-26',
        }),
      ]);

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.schoolBreak.findMany).toHaveBeenCalledWith({
        where: { academicYearId: YEAR_ID },
        orderBy: [{ startDate: 'asc' }, { name: 'asc' }],
      });
    });
  });

  describe('remove', () => {
    it('deletes by id and leaves the calendar alone', async () => {
      tx.schoolBreak.delete.mockResolvedValue(storedBreak());

      await expect(service.remove(BREAK_ID, testUser())).resolves.toBeUndefined();

      expect(tx.schoolBreak.delete).toHaveBeenCalledWith({
        where: { id: BREAK_ID },
      });
      // Deleting the lov cannot bring back what it deleted, and inventing
      // lessons to fill the gap is not this endpoint's business.
      expect(tx.calendarLesson.deleteMany).not.toHaveBeenCalled();
    });

    it('maps P2025 (unknown or cross-tenant id) to 404', async () => {
      tx.schoolBreak.delete.mockRejectedValue(prismaError('P2025'));

      await expect(service.remove(BREAK_ID, testUser())).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
