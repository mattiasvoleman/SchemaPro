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
import { TeachingRequirementsService } from './teaching-requirements.service';
import type {
  CreateTeachingRequirementDto,
  UpdateTeachingRequirementDto,
} from './dto/teaching-requirement.dto';

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const YEAR_ID = '99999999-9999-4999-8999-999999999999';
const SUBJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GROUP_ID = '66666666-6666-4666-8666-666666666666';
const TEACHER_ID = '44444444-4444-4444-8444-444444444444';
const CO_TEACHER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REQUIREMENT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/** The läsår every period in these tests is measured against. */
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
 * `undefined` to the check behind it, and the check then passes.
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

describe('TeachingRequirementsService', () => {
  let service: TeachingRequirementsService;
  let tx: TxMock;
  let prisma: PrismaMock;
  /** The years the read of the bounds can find: none until a test stores one. */
  let years: Record<string, unknown>[];
  /** The read of the year's bounds. */
  let queryRaw: jest.Mock;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new TeachingRequirementsService(prisma as unknown as PrismaService);
    years = [];
    // The auto-vivifying mock would hand back a model proxy for `$queryRaw`,
    // and a proxy is not callable. It answers as the table would, from the
    // year a test stored, and throws on a read that takes another lock or
    // none. A year nobody stored is one RLS hides.
    queryRaw = jest.fn((...call: unknown[]) =>
      Promise.resolve(lockingRead(YEARS, years, call)),
    );
    Object.assign(tx, { $queryRaw: queryRaw });
  });

  /** The läsår, stored where the read of the bounds finds it by its own id. */
  const givenYear = (): void => {
    years = [
      { id: YEAR_ID, schoolId: SCHOOL_ID, name: '2026/2027', isActive: true, ...YEAR },
    ];
  };

  const dto = (
    overrides: Partial<CreateTeachingRequirementDto> = {},
  ): CreateTeachingRequirementDto => ({
    academicYearId: YEAR_ID,
    subjectId: SUBJECT_ID,
    studentGroupId: GROUP_ID,
    ...overrides,
  });

  describe('create', () => {
    it('creates an unassigned requirement with the documented defaults', async () => {
      const row = { id: REQUIREMENT_ID, startDate: null, endDate: null };
      tx.teachingRequirement.create.mockResolvedValue(row);
      const user = testUser();

      // The row itself rather than a copy of it would be the simpler
      // assertion, but the dates leave as strings now — see toResponse.
      await expect(service.create(dto(), user)).resolves.toEqual(row);

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.teachingRequirement.create).toHaveBeenCalledWith({
        data: {
          schoolId: SCHOOL_ID,
          academicYearId: YEAR_ID,
          subjectId: SUBJECT_ID,
          studentGroupId: GROUP_ID,
          teacherId: null,
          coTeacherId: null,
          lessonsPerWeek: 1,
          minutesPerLesson: 60,
          // No ombyte and no dusch: the only answer that is true for a school
          // that has not been asked, and the one every row carried before the
          // columns existed.
          minutesBefore: 0,
          minutesAfter: 0,
          recurrence: 'ALL_WEEKS',
          startDate: null,
          endDate: null,
        },
      });
      // A requirement without a period runs the whole year by definition, so
      // there is nothing to measure and the year is neither fetched nor locked.
      expect(queryRaw).not.toHaveBeenCalled();
    });

    it('persists explicit teachers and load figures', async () => {
      tx.teachingRequirement.create.mockResolvedValue({ id: REQUIREMENT_ID });

      await service.create(
        dto({
          teacherId: TEACHER_ID,
          coTeacherId: CO_TEACHER_ID,
          lessonsPerWeek: 3,
          minutesPerLesson: 45,
        }),
        testUser(),
      );

      expect(tx.teachingRequirement.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            teacherId: TEACHER_ID,
            coTeacherId: CO_TEACHER_ID,
            lessonsPerWeek: 3,
            minutesPerLesson: 45,
          }),
        }),
      );
    });

    it('persists the ombyte before the lesson and the dusch after it', async () => {
      tx.teachingRequirement.create.mockResolvedValue({ id: REQUIREMENT_ID });

      await service.create(
        dto({ minutesPerLesson: 60, minutesBefore: 10, minutesAfter: 20 }),
        testUser(),
      );

      expect(tx.teachingRequirement.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            // The buffers lie OUTSIDE the lesson: the teaching is still 60
            // minutes and the timplan still counts 60, while the class is
            // occupied for 90. A create that folded them in would credit idrotten
            // with half an hour it never taught.
            minutesPerLesson: 60,
            minutesBefore: 10,
            minutesAfter: 20,
          }),
        }),
      );
    });

    it('takes one side of the buffer without inventing the other', async () => {
      tx.teachingRequirement.create.mockResolvedValue({ id: REQUIREMENT_ID });

      await service.create(dto({ minutesAfter: 20 }), testUser());

      expect(tx.teachingRequirement.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ minutesBefore: 0, minutesAfter: 20 }),
        }),
      );
    });

    it('persists a spring-only period and its recurrence', async () => {
      givenYear();
      tx.teachingRequirement.create.mockResolvedValue({ id: REQUIREMENT_ID });

      await service.create(
        dto({
          recurrence: 'ODD_WEEKS',
          startDate: '2027-01-11',
          endDate: '2027-06-11',
        }),
        testUser(),
      );

      expect(tx.teachingRequirement.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            recurrence: 'ODD_WEEKS',
            startDate: new Date('2027-01-11T00:00:00.000Z'),
            // The last day of the year is inside it — the bounds are inclusive.
            endDate: new Date('2027-06-11T00:00:00.000Z'),
          }),
        }),
      );
    });

    // AcademicYearsService.update counts the periods outside the bounds it is
    // about to store, and this create measures the period against the bounds
    // it reads. withRls runs READ COMMITTED, so read without a lock the two
    // pass each other: the PATCH counts before the requirement commits, the
    // requirement reads the bounds before the PATCH commits, and both land a
    // period outside its year. FOR SHARE is what the PATCH's FOR NO KEY UPDATE
    // waits on, and it holds only while the transaction that took it is open.
    it('reads the year FOR SHARE, in the transaction that stores the period', async () => {
      givenYear();
      tx.teachingRequirement.create.mockResolvedValue({ id: REQUIREMENT_ID });
      const ranIn = transactionsOf(prisma);
      const readIn = ranIn(queryRaw);
      const createdIn = ranIn(tx.teachingRequirement.create);

      await service.create(dto({ startDate: '2027-01-11' }), testUser());

      expect(readIn).toEqual([expect.stringMatching(/^withRls#\d+$/)]);
      expect(createdIn).toEqual(readIn);
      const [call] = queryRaw.mock.calls;
      expect(rawSql(call)).toMatch(YEAR_READ);
      expect(call.slice(1)).toEqual([YEAR_ID]);
      expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.teachingRequirement.create.mock.invocationCallOrder[0],
      );
    });

    it('answers with the period as dates, not as invented midnight instants', async () => {
      givenYear();
      tx.teachingRequirement.create.mockResolvedValue({
        id: REQUIREMENT_ID,
        startDate: new Date('2027-01-11T00:00:00.000Z'),
        endDate: new Date('2027-06-11T00:00:00.000Z'),
      });

      // The shape the web app's own type has always claimed for this field, and
      // the shape Supabase gives when the same row is read back. Before this,
      // saving and reloading produced two different strings for one field.
      await expect(
        service.create(
          dto({ startDate: '2027-01-11', endDate: '2027-06-11' }),
          testUser(),
        ),
      ).resolves.toEqual({
        id: REQUIREMENT_ID,
        startDate: '2027-01-11',
        endDate: '2027-06-11',
      });
    });

    it('keeps a period-less requirement’s nulls as nulls', async () => {
      tx.teachingRequirement.create.mockResolvedValue({
        id: REQUIREMENT_ID,
        startDate: null,
        endDate: null,
      });

      // Null is "the year's own boundary" and has to survive the trip out; an
      // empty string here would read as a stated bound the admin never gave.
      await expect(service.create(dto(), testUser())).resolves.toEqual({
        id: REQUIREMENT_ID,
        startDate: null,
        endDate: null,
      });
    });

    it('refuses a period that reaches past the end of the läsår', async () => {
      givenYear();

      // The answer names the field and the year's own bounds: the admin has to
      // know which of two date pickers to move, and how far.
      await expect(
        service.create(dto({ endDate: '2027-08-01' }), testUser()),
      ).rejects.toThrow(
        new BadRequestException(
          'endDate must fall inside the academic year (2026-08-17 to 2027-06-11).',
        ),
      );
      expect(tx.teachingRequirement.create).not.toHaveBeenCalled();
    });

    it('accepts a period that starts on the first day of the läsår', async () => {
      // Both bounds are inclusive: the day the year starts is inside it.
      givenYear();
      tx.teachingRequirement.create.mockResolvedValue({ id: REQUIREMENT_ID });

      await expect(
        service.create(dto({ startDate: '2026-08-17' }), testUser()),
      ).resolves.toBeDefined();
    });

    it('refuses an end before its start instead of letting the CHECK 500', async () => {
      givenYear();

      await expect(
        service.create(
          dto({ startDate: '2027-01-11', endDate: '2026-12-01' }),
          testUser(),
        ),
      ).rejects.toThrow(
        new BadRequestException('endDate must not be before startDate.'),
      );
      expect(tx.teachingRequirement.create).not.toHaveBeenCalled();
    });

    it('accepts a period of a single day', async () => {
      // A study visit or a test day: a start and an end on the same date is a
      // period, not an inverted one.
      givenYear();
      tx.teachingRequirement.create.mockResolvedValue({ id: REQUIREMENT_ID });

      await expect(
        service.create(
          dto({ startDate: '2027-01-11', endDate: '2027-01-11' }),
          testUser(),
        ),
      ).resolves.toBeDefined();
    });

    it('says nothing about a year RLS hides, and lets the FK refuse it', async () => {
      // No year stored: the read of the bounds finds no row, which is what a
      // year belonging to another school reads as.
      tx.teachingRequirement.create.mockRejectedValue(prismaError('P2003'));

      // Not 400 "outside its year": that answer would confirm the year exists.
      await expect(
        service.create(dto({ startDate: '2027-01-11' }), testUser()),
      ).rejects.toThrow(ConflictException);
      expect(tx.teachingRequirement.create).toHaveBeenCalled();
    });

    it('rejects a principal with no school', async () => {
      await expect(
        service.create(dto(), testUser({ schoolId: undefined })),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('maps a bad reference (P2003, invisible under RLS) to 409', async () => {
      tx.teachingRequirement.create.mockRejectedValue(prismaError('P2003'));

      await expect(service.create(dto(), testUser())).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('lektionslängden mot solverns rutnät', () => {
    /*
     * The gap that produced a 500 in production. `@Min(15) @Max(240)` says the
     * number is plausible; it does not say the engine can lay it on its grid.
     * A 40-minute lesson — an ordinary Swedish length — was accepted, stored,
     * and blew up as an unhandled ValueError the first time somebody pressed
     * "generera", one service away from the field that caused it.
     *
     * The grid is five minutes now, so 40 is fine. What is left is what lands
     * between slots.
     */
    it.each([37, 41, 52, 1])('refuses %s minutes', async (minutesPerLesson) => {
      await expect(
        service.create(dto({ minutesPerLesson }), testUser()),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.teachingRequirement.create).not.toHaveBeenCalled();
    });

    it.each([40, 45, 50, 60, 90])('accepts %s minutes', async (minutesPerLesson) => {
      // 40 and 50 are the reason the grid moved; they were impossible before.
      givenYear();
      tx.teachingRequirement.create.mockResolvedValue({ id: 'req-1' });

      await expect(
        service.create(dto({ minutesPerLesson }), testUser()),
      ).resolves.toBeDefined();
    });

    it('names the two lengths nearest the one that was refused', async () => {
      // "invalid" would send an administrator back to a grid they cannot see.
      await expect(
        service.create(dto({ minutesPerLesson: 37 }), testUser()),
      ).rejects.toThrow(/35.*40|40.*35/);
    });

    it('says which length it refused, in the words the timplan form shows', async () => {
      await expect(
        service.create(dto({ minutesPerLesson: 37 }), testUser()),
      ).rejects.toThrow(
        new BadRequestException(
          '37 minuter går inte att lägga på schemat, som räknar i hela ' +
            '5-minutersintervall. Närmast är 35 eller 40 minuter.',
        ),
      );
    });

    it('checks an update that changes only the length', async () => {
      // The guard first sat inside the period's condition, so the ordinary
      // edit — change the length, touch nothing else — skipped it entirely.
      await expect(
        service.update('req-1', { minutesPerLesson: 41 }, testUser()),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.teachingRequirement.update).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    /**
     * The stored period and its year, read back the way the database answers
     * the queries that were sent: the row found only by its own id and cut to
     * the fields the select names, the year only by the id the row names. A
     * stub that returns the row whatever was asked would let a read that
     * dropped `endDate` measure the merge against `undefined` — and pass it.
     */
    const givenRequirement = (period: {
      startDate: Date | null;
      endDate: Date | null;
    }) => {
      givenYear();
      const row = {
        id: REQUIREMENT_ID,
        schoolId: SCHOOL_ID,
        academicYearId: YEAR_ID,
        ...period,
      };
      tx.teachingRequirement.findUnique.mockImplementation(
        ({ where, select }: { where?: { id?: string }; select?: Selection }) => {
          if (where?.id === undefined) {
            throw new Error('Prisma: findUnique needs a unique field in `where`.');
          }
          return Promise.resolve(
            where.id === REQUIREMENT_ID ? selected(row, select) : null,
          );
        },
      );
    };

    it('unassigns the teacher with an explicit null and nothing else', async () => {
      const row = {
        id: REQUIREMENT_ID,
        teacherId: null,
        startDate: null,
        endDate: null,
      };
      tx.teachingRequirement.update.mockResolvedValue(row);
      const user = testUser();

      await expect(
        service.update(REQUIREMENT_ID, { teacherId: null }, user),
      ).resolves.toEqual(row);

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.teachingRequirement.update).toHaveBeenCalledWith({
        where: { id: REQUIREMENT_ID },
        data: { teacherId: null },
      });
    });

    it('sends only the provided load figures', async () => {
      tx.teachingRequirement.update.mockResolvedValue({ id: REQUIREMENT_ID });

      await service.update(
        REQUIREMENT_ID,
        { lessonsPerWeek: 2, minutesPerLesson: 90 },
        testUser(),
      );

      expect(tx.teachingRequirement.update).toHaveBeenCalledWith({
        where: { id: REQUIREMENT_ID },
        data: { lessonsPerWeek: 2, minutesPerLesson: 90 },
      });
      // Neither date was sent, so the row is not read to merge a period, and
      // the year is not locked: an edit that moves no date strands nothing, so
      // it has no reason to wait for a year PATCH or to hold one up.
      expect(tx.teachingRequirement.findUnique).not.toHaveBeenCalled();
      expect(queryRaw).not.toHaveBeenCalled();
    });

    it('sends the two buffers and nothing they were not asked about', async () => {
      tx.teachingRequirement.update.mockResolvedValue({ id: REQUIREMENT_ID });

      await service.update(
        REQUIREMENT_ID,
        { minutesBefore: 10, minutesAfter: 20 },
        testUser(),
      );

      expect(tx.teachingRequirement.update).toHaveBeenCalledWith({
        where: { id: REQUIREMENT_ID },
        data: { minutesBefore: 10, minutesAfter: 20 },
      });
      // Neither date moved, so the row is not read and the year is not locked —
      // the same thrift the load figures get.
      expect(tx.teachingRequirement.findUnique).not.toHaveBeenCalled();
      expect(queryRaw).not.toHaveBeenCalled();
    });

    it('leaves the dusch alone when only the ombyte is moved', async () => {
      // The distinction the whole per-field spread exists for. A PATCH lowering
      // the ombyte to 5 must not read the omitted `minutesAfter` as 0 and throw
      // away the twenty minutes of shower the school already wrote: the class
      // would be booked into the next lesson while it is still wet, on an edit
      // that answered 200.
      tx.teachingRequirement.update.mockResolvedValue({ id: REQUIREMENT_ID });

      await service.update(REQUIREMENT_ID, { minutesBefore: 5 }, testUser());

      expect(tx.teachingRequirement.update).toHaveBeenCalledWith({
        where: { id: REQUIREMENT_ID },
        data: { minutesBefore: 5 },
      });
    });

    it('writes an explicit zero rather than reading it as "leave it"', async () => {
      // 0 is a value, not an absence: it is how a school takes an ombyte back
      // off a requirement. A spread on truthiness would make that edit silently
      // impossible — the same trap `lessonsPerWeek` avoids the same way.
      tx.teachingRequirement.update.mockResolvedValue({ id: REQUIREMENT_ID });

      await service.update(
        REQUIREMENT_ID,
        { minutesBefore: 0, minutesAfter: 0 },
        testUser(),
      );

      expect(tx.teachingRequirement.update).toHaveBeenCalledWith({
        where: { id: REQUIREMENT_ID },
        data: { minutesBefore: 0, minutesAfter: 0 },
      });
    });

    it.each<[string, UpdateTeachingRequirementDto]>([
      ['the co-teacher', { coTeacherId: CO_TEACHER_ID }],
      ['the recurrence', { recurrence: 'EVEN_WEEKS' }],
      ['the ombyte before the lesson', { minutesBefore: 10 }],
      ['the dusch after it', { minutesAfter: 20 }],
    ])('a PATCH naming only %s writes it', async (_field, patch) => {
      // A dropped field is an edit that answers 200 and changes nothing: the
      // odd/even split the admin just chose, still "every week" underneath.
      tx.teachingRequirement.update.mockResolvedValue({ id: REQUIREMENT_ID });

      await service.update(REQUIREMENT_ID, patch, testUser());

      expect(tx.teachingRequirement.update).toHaveBeenCalledWith({
        where: { id: REQUIREMENT_ID },
        data: patch,
      });
    });

    it('clears a period with explicit nulls and nothing else', async () => {
      givenRequirement({
        startDate: new Date('2027-01-11T00:00:00.000Z'),
        endDate: new Date('2027-06-11T00:00:00.000Z'),
      });
      tx.teachingRequirement.update.mockResolvedValue({ id: REQUIREMENT_ID });

      await service.update(
        REQUIREMENT_ID,
        { startDate: null, endDate: null },
        testUser(),
      );

      expect(tx.teachingRequirement.update).toHaveBeenCalledWith({
        where: { id: REQUIREMENT_ID },
        data: { startDate: null, endDate: null },
      });
    });

    it('measures a one-sided move against the date already on the row', async () => {
      givenRequirement({
        startDate: new Date('2027-01-11T00:00:00.000Z'),
        endDate: null,
      });

      // Nothing in this PATCH is wrong on its own; it is wrong against the
      // start it inherits, which is the whole reason the row is read first.
      await expect(
        service.update(REQUIREMENT_ID, { endDate: '2026-12-01' }, testUser()),
      ).rejects.toThrow(BadRequestException);
      expect(tx.teachingRequirement.update).not.toHaveBeenCalled();
    });

    it('refuses a period moved outside the row’s own läsår', async () => {
      givenRequirement({ startDate: null, endDate: null });

      await expect(
        service.update(REQUIREMENT_ID, { startDate: '2026-06-01' }, testUser()),
      ).rejects.toThrow(BadRequestException);
      expect(tx.teachingRequirement.update).not.toHaveBeenCalled();
    });

    it('refuses an end moved past the row’s own läsår', async () => {
      givenRequirement({ startDate: null, endDate: null });

      await expect(
        service.update(REQUIREMENT_ID, { endDate: '2027-08-01' }, testUser()),
      ).rejects.toThrow(
        new BadRequestException(
          'endDate must fall inside the academic year (2026-08-17 to 2027-06-11).',
        ),
      );
      expect(tx.teachingRequirement.update).not.toHaveBeenCalled();
    });

    it('measures a start moved past the end already on the row', async () => {
      // The mirror of the one-sided move above: this PATCH names only the
      // start, and it is wrong against the end the row already holds.
      givenRequirement({
        startDate: new Date('2027-01-11T00:00:00.000Z'),
        endDate: new Date('2027-03-01T00:00:00.000Z'),
      });

      await expect(
        service.update(REQUIREMENT_ID, { startDate: '2027-04-01' }, testUser()),
      ).rejects.toThrow(
        new BadRequestException('endDate must not be before startDate.'),
      );
      expect(tx.teachingRequirement.update).not.toHaveBeenCalled();
    });

    it('reads the row’s own year FOR SHARE, in the transaction that moves the period', async () => {
      givenRequirement({ startDate: null, endDate: null });
      tx.teachingRequirement.update.mockResolvedValue({ id: REQUIREMENT_ID });
      const ranIn = transactionsOf(prisma);
      const readIn = ranIn(queryRaw);
      const updatedIn = ranIn(tx.teachingRequirement.update);

      await service.update(REQUIREMENT_ID, { endDate: '2027-01-15' }, testUser());

      // The same race as create()'s, from a PATCH: the year the requirement
      // belongs to is the one whose next move has to wait, so that is the id
      // locked.
      expect(readIn).toEqual([expect.stringMatching(/^withRls#\d+$/)]);
      expect(updatedIn).toEqual(readIn);
      const [call] = queryRaw.mock.calls;
      expect(rawSql(call)).toMatch(YEAR_READ);
      expect(call.slice(1)).toEqual([YEAR_ID]);
      expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.teachingRequirement.update.mock.invocationCallOrder[0],
      );
    });

    it('leaves an unreadable row to update()’s own 404', async () => {
      tx.teachingRequirement.findUnique.mockResolvedValue(null);
      tx.teachingRequirement.update.mockRejectedValue(prismaError('P2025'));

      await expect(
        service.update(REQUIREMENT_ID, { startDate: '2026-06-01' }, testUser()),
      ).rejects.toThrow(NotFoundException);
    });

    it('maps P2025 (unknown or cross-tenant id) to 404', async () => {
      tx.teachingRequirement.update.mockRejectedValue(prismaError('P2025'));

      await expect(
        service.update(REQUIREMENT_ID, { lessonsPerWeek: 2 }, testUser()),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove', () => {
    it('deletes by id under the caller’s RLS context', async () => {
      tx.teachingRequirement.delete.mockResolvedValue({ id: REQUIREMENT_ID });
      const user = testUser();

      await expect(
        service.remove(REQUIREMENT_ID, user),
      ).resolves.toBeUndefined();

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.teachingRequirement.delete).toHaveBeenCalledWith({
        where: { id: REQUIREMENT_ID },
      });
    });

    it('maps P2025 (unknown or cross-tenant id) to 404', async () => {
      tx.teachingRequirement.delete.mockRejectedValue(prismaError('P2025'));

      await expect(
        service.remove(REQUIREMENT_ID, testUser()),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
