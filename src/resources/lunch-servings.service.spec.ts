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
import type { PrismaService } from '../database/prisma.service';
import { LunchServingsService } from './lunch-servings.service';
import type { UpdateLunchServingDto } from './dto/lunch-serving.dto';

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const SERVING_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

/** A `@db.Time` value as Prisma hands it back: a Date anchored at 1970-01-01. */
const wallClock = (time: string): Date => new Date(`1970-01-01T${time}:00.000Z`);

/** Reconstructs the SQL text of a tagged-template $queryRaw call. */
const rawSql = (call: unknown[]): string => (call[0] as readonly string[]).join('?');

const storedServing = (overrides: Record<string, unknown> = {}) => ({
  id: SERVING_ID,
  schoolId: SCHOOL_ID,
  minGradeLevel: 4,
  maxGradeLevel: 6,
  dayOfWeek: 1,
  startTime: wallClock('11:00'),
  endTime: wallClock('12:00'),
  seats: null,
  createdAt: new Date('2026-08-31T09:00:00.000Z'),
  updatedAt: new Date('2026-08-31T09:00:00.000Z'),
  ...overrides,
});

const prismaError = (code: string): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError(`Simulated ${code}`, {
    code,
    clientVersion: Prisma.prismaVersion.client,
  });

/**
 * What the table answers update()'s locking read with: the rows whose id is the
 * one value bound into the statement, each carrying the columns the SELECT names
 * and no others. A statement that is not `SELECT ... FROM "<table>" WHERE "id" =
 * $1::uuid FOR UPDATE`, or that names a column the table lacks, throws instead
 * of being answered, so a read that drops its lock, its key or a column fails
 * the test rather than passing on a row it never asked for.
 */
function lockingRead(
  table: string,
  rows: Record<string, unknown>[],
  call: unknown[],
): Record<string, unknown>[] {
  const sql = rawSql(call).replace(/\s+/g, ' ').trim();
  const read = /^SELECT (.+) FROM "(\w+)" WHERE "id" = \?::uuid FOR UPDATE$/.exec(sql);
  const values = call.slice(1);
  if (read === null || read[2] !== table || values.length !== 1) {
    throw new Error(`Not a locking read of one "${table}" row: ${sql}`);
  }
  const columns = read[1].split(',').map((column) => {
    const name = /^"(\w+)"$/.exec(column.trim())?.[1];
    if (name === undefined || !(name in storedServing())) {
      throw new Error(`"${table}" has no column ${column.trim()}`);
    }
    return name;
  });
  return rows
    .filter((row) => row.id === values[0])
    .map((row) => Object.fromEntries(columns.map((column) => [column, row[column]])));
}

/**
 * Names the transaction each call of a mock ran in. createPrismaMock hands every
 * helper's callback the one shared `tx`, so a read in withRls and a read in
 * withVerifiedSubject's batch reach the same `$queryRaw` and look alike to a
 * spec. Here each call to a helper is a transaction of its own, `<helper>#<n>`,
 * open from the moment the helper is called until its promise settles. The
 * function returned wraps a mock so that each of its calls notes the innermost
 * transaction open at that moment, undefined outside them all, and answers as
 * the mock already did.
 */
function transactionsOf(prisma: PrismaMock): (mock: jest.Mock) => (string | undefined)[] {
  const open: string[] = [];
  let opened = 0;
  for (const [helper, method] of Object.entries(prisma) as [string, jest.Mock][]) {
    const run = method.getMockImplementation();
    if (run === undefined) continue;
    method.mockImplementation(async (...args: unknown[]) => {
      opened += 1;
      const transaction = `${helper}#${opened}`;
      open.push(transaction);
      try {
        return await run(...args);
      } finally {
        open.splice(open.lastIndexOf(transaction), 1);
      }
    });
  }
  return (mock) => {
    const ranIn: (string | undefined)[] = [];
    const answer = mock.getMockImplementation();
    mock.mockImplementation((...args: unknown[]) => {
      ranIn.push(open[open.length - 1]);
      return answer?.(...args);
    });
    return ranIn;
  };
}

/**
 * Rows in the order a `findMany` `orderBy` asks for, sorted the way PostgreSQL
 * sorts them: entries applied left to right, each naming one field with
 * `'asc' | 'desc'` or `{ sort, nulls }`, NULLs last when ascending unless told
 * otherwise. Anything it cannot read throws rather than being ignored, so a
 * sort that loses a key reorders the rows and a sort nobody could run fails.
 */
function ordered<T extends Record<string, unknown>>(rows: T[], orderBy: unknown): T[] {
  const entries = (
    orderBy === undefined ? [] : Array.isArray(orderBy) ? orderBy : [orderBy]
  ) as Record<string, unknown>[];
  const keys = entries.map((entry) => {
    const pairs = Object.entries(entry);
    if (pairs.length !== 1) {
      throw new Error(`An orderBy entry names exactly one field: ${JSON.stringify(entry)}`);
    }
    const [field, how] = pairs[0];
    const { sort, nulls } =
      typeof how === 'string'
        ? { sort: how, nulls: undefined }
        : (how as { sort?: unknown; nulls?: unknown });
    if (sort !== 'asc' && sort !== 'desc') {
      throw new Error(`orderBy.${field}: sort is asc or desc, not ${JSON.stringify(sort)}`);
    }
    if (nulls !== undefined && nulls !== 'first' && nulls !== 'last') {
      throw new Error(`orderBy.${field}: nulls is first or last, not ${JSON.stringify(nulls)}`);
    }
    return {
      field,
      direction: sort === 'asc' ? 1 : -1,
      nullsFirst: nulls === undefined ? sort === 'desc' : nulls === 'first',
    };
  });
  const comparable = (value: unknown) =>
    (value instanceof Date ? value.getTime() : value) as number | null;
  return [...rows].sort((a, b) => {
    for (const { field, direction, nullsFirst } of keys) {
      const x = comparable(a[field]);
      const y = comparable(b[field]);
      if (x === y) continue;
      if (x === null) return nullsFirst ? -1 : 1;
      if (y === null) return nullsFirst ? 1 : -1;
      return x < y ? -direction : direction;
    }
    return 0;
  });
}

describe('LunchServingsService', () => {
  let tx: TxMock;
  let prisma: PrismaMock;
  let service: LunchServingsService;
  /** The rows the locking read in update() can find: none until a test stores one. */
  let servings: Record<string, unknown>[];
  /** The locking read of the stored bounds in update(). */
  let queryRaw: jest.Mock;

  beforeEach(() => {
    tx = createTxMock();
    servings = [];
    // The auto-vivifying mock would hand back a model proxy for `$queryRaw`,
    // and a proxy is not callable. It answers as the table would, from the rows
    // a test stored: a row nobody stored is a row the lock does not find.
    queryRaw = jest.fn((...call: unknown[]) =>
      Promise.resolve(lockingRead('LunchServings', servings, call)),
    );
    Object.assign(tx, { $queryRaw: queryRaw });
    prisma = createPrismaMock(tx);
    service = new LunchServingsService(prisma as unknown as PrismaService);
  });

  /** The stored sitting, found by its own id and by nothing else — as the table would. */
  const givenServing = (overrides: Record<string, unknown> = {}) => {
    servings.push(storedServing(overrides));
  };

  // -------------------------------------------------------------------------
  // The clock, which is the whole reason this service has a response type
  // -------------------------------------------------------------------------

  describe('the times it returns', () => {
    /*
     * Prisma reads a TIME column into a Date at 1970-01-01, and JSON.stringify
     * turns that into "1970-01-01T12:00:00.000Z". Returning the row unmapped
     * therefore sends a timestamp where the form expects a clock — the bug that
     * put "1970-" into the lunch card's <input type="time"> and rendered it
     * empty on every load. The assertion below is on the exact string, because
     * anything that merely "contains 12:00" would also pass for the timestamp.
     */
    it('hands back HH:MM, not a 1970 timestamp', async () => {
      tx.lunchServing.findMany.mockResolvedValue([storedServing()]);

      const [serving] = await service.list(testUser({ schoolId: SCHOOL_ID }));

      expect(serving.startTime).toBe('11:00');
      expect(serving.endTime).toBe('12:00');
      expect(JSON.stringify(serving)).not.toContain('1970');
    });

    it('reads the stored clock in UTC, so no zone can shift it', async () => {
      // 23:00 is the hour a Stockholm-local read would roll into the next day.
      tx.lunchServing.findMany.mockResolvedValue([
        storedServing({ startTime: wallClock('00:30'), endTime: wallClock('23:00') }),
      ]);

      const [serving] = await service.list(testUser({ schoolId: SCHOOL_ID }));

      expect([serving.startTime, serving.endTime]).toEqual(['00:30', '23:00']);
    });

    it('sends the every-day sitting back as null, not as a missing field', async () => {
      tx.lunchServing.findMany.mockResolvedValue([storedServing({ dayOfWeek: null })]);

      const [serving] = await service.list(testUser({ schoolId: SCHOOL_ID }));

      expect(serving.dayOfWeek).toBeNull();
      expect('dayOfWeek' in serving).toBe(true);
    });

    it('lists the flow the way it runs on a Monday: youngest first, every-day rows before weekdays, up the clock', async () => {
      // The rows arrive scrambled and are sorted by the service's own orderBy;
      // each of its keys has a pair of rows only it can put in order.
      const rows = [
        storedServing({ id: 'åk4-6', minGradeLevel: 4, maxGradeLevel: 6, dayOfWeek: null, startTime: wallClock('10:00'), endTime: wallClock('10:30') }),
        storedServing({ id: 'åk0-3-11.30', minGradeLevel: 0, maxGradeLevel: 3, dayOfWeek: null, startTime: wallClock('11:30'), endTime: wallClock('12:00') }),
        storedServing({ id: 'åk0-3-måndag', minGradeLevel: 0, maxGradeLevel: 3, dayOfWeek: 1, startTime: wallClock('10:30'), endTime: wallClock('11:00') }),
        storedServing({ id: 'åk0-3-11.00', minGradeLevel: 0, maxGradeLevel: 3, dayOfWeek: null, startTime: wallClock('11:00'), endTime: wallClock('11:30') }),
      ];
      tx.lunchServing.findMany.mockImplementation((args: { orderBy?: unknown } = {}) =>
        Promise.resolve(ordered(rows, args.orderBy)),
      );

      const servings = await service.list(testUser({ schoolId: SCHOOL_ID }));

      expect(servings.map((serving) => serving.id)).toEqual([
        'åk0-3-11.00',
        'åk0-3-11.30',
        'åk0-3-måndag',
        'åk4-6',
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // Creating
  // -------------------------------------------------------------------------

  describe('create', () => {
    const user = () => testUser({ schoolId: SCHOOL_ID });

    it('stores the window as times and stamps the caller school', async () => {
      tx.lunchServing.create.mockResolvedValue(storedServing());

      await service.create(
        { minGradeLevel: 4, maxGradeLevel: 6, dayOfWeek: 1, startTime: '11:00', endTime: '12:00' },
        user(),
      );

      expect(tx.lunchServing.create).toHaveBeenCalledWith({
        data: {
          schoolId: SCHOOL_ID,
          minGradeLevel: 4,
          maxGradeLevel: 6,
          dayOfWeek: 1,
          startTime: wallClock('11:00'),
          endTime: wallClock('12:00'),
          seats: null,
        },
      });
    });

    it('treats an omitted weekday as the every-day sitting', async () => {
      tx.lunchServing.create.mockResolvedValue(storedServing({ dayOfWeek: null }));

      await service.create(
        { minGradeLevel: 0, maxGradeLevel: 3, startTime: '11:00', endTime: '11:40' },
        user(),
      );

      expect(tx.lunchServing.create.mock.calls[0][0].data.dayOfWeek).toBeNull();
    });

    it('refuses a window that ends before it starts', async () => {
      await expect(
        service.create(
          { minGradeLevel: 4, maxGradeLevel: 6, startTime: '12:00', endTime: '11:00' },
          user(),
        ),
      ).rejects.toThrow(new BadRequestException('startTime must be before endTime.'));
      expect(tx.lunchServing.create).not.toHaveBeenCalled();
    });

    it('refuses a window of no length', async () => {
      // A sitting nobody can attend is a typo, not a policy.
      await expect(
        service.create(
          { minGradeLevel: 4, maxGradeLevel: 6, startTime: '11:00', endTime: '11:00' },
          user(),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a second the ordering check would have let through', async () => {
      /*
       * The window below spans real minutes, so the ordering guard is happy
       * with it and `LunchServings_window_is_ordered` only says the window runs
       * forwards — it is true of 09:00:30 to 15:00. Nothing refused this
       * before: the row was stored thirty seconds off the solver's five-minute
       * grid, to be read back on every run.
       *
       * Unlike the lunch window one table over, no CHECK here counts seconds,
       * so this was never a 500. It is the smaller claim, and it is refused for
       * the grid's sake rather than the constraint's.
       */
      await expect(
        service.create(
          { minGradeLevel: 4, maxGradeLevel: 6, startTime: '10:00:30', endTime: '10:30' },
          user(),
        ),
      ).rejects.toThrow(/must be whole minutes/);

      expect(tx.lunchServing.create).not.toHaveBeenCalled();
    });

    it('refuses a window that is only seconds long', async () => {
      /*
       * The case a lexical compare gets wrong. "09:00" sorts before "09:00:30"
       * because it is a prefix, so a string check reads this as a valid window
       * and stores a thirty-second sitting — a window no meal fits in.
       * The DTO's regex admits both lengths, so it is reachable from the wire.
       */
      await expect(
        service.create(
          { minGradeLevel: 4, maxGradeLevel: 6, startTime: '09:00', endTime: '09:00:30' },
          user(),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.lunchServing.create).not.toHaveBeenCalled();
    });

    it('still accepts a seconds-bearing clock that spans real minutes', async () => {
      tx.lunchServing.create.mockResolvedValue(storedServing());

      await expect(
        service.create(
          { minGradeLevel: 4, maxGradeLevel: 6, startTime: '11:00:00', endTime: '12:00' },
          user(),
        ),
      ).resolves.toMatchObject({ startTime: '11:00' });
    });

    it('refuses an inverted year span', async () => {
      await expect(
        service.create(
          { minGradeLevel: 9, maxGradeLevel: 4, startTime: '11:00', endTime: '12:00' },
          user(),
        ),
      ).rejects.toThrow(
        new BadRequestException('minGradeLevel must not be above maxGradeLevel.'),
      );
      expect(tx.lunchServing.create).not.toHaveBeenCalled();
    });

    it('answers a write the database refuses as a duplicate (P2002) with 409', async () => {
      tx.lunchServing.create.mockRejectedValue(prismaError('P2002'));

      await expect(
        service.create(
          { minGradeLevel: 4, maxGradeLevel: 6, startTime: '11:00', endTime: '12:00' },
          user(),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('accepts a single year, which is the common case', async () => {
      tx.lunchServing.create.mockResolvedValue(storedServing({ minGradeLevel: 4, maxGradeLevel: 4 }));

      await expect(
        service.create(
          { minGradeLevel: 4, maxGradeLevel: 4, startTime: '11:00', endTime: '12:00' },
          user(),
        ),
      ).resolves.toMatchObject({ minGradeLevel: 4, maxGradeLevel: 4 });
    });

    it('refuses a caller with no school', async () => {
      await expect(
        service.create(
          { minGradeLevel: 4, maxGradeLevel: 6, startTime: '11:00', endTime: '12:00' },
          testUser({ schoolId: null }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(tx.lunchServing.create).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Updating — where the invariants are actually at risk
  // -------------------------------------------------------------------------

  describe('update', () => {
    const user = () => testUser({ schoolId: SCHOOL_ID });

    /*
     * The trap this whole method is shaped around. A PATCH naming one end of
     * the window says nothing about the other, so checking the payload alone
     * passes and the database CHECK answers with a constraint violation the
     * admin cannot act on. The timplan had the same bug for the same reason —
     * its guard sat inside the branch that only ran when dates were sent.
     */
    it('refuses an end moved before the start it never mentions', async () => {
      givenServing();

      await expect(service.update(SERVING_ID, { endTime: '07:00' }, user())).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(tx.lunchServing.update).not.toHaveBeenCalled();
    });

    it('refuses a start moved past the end it never mentions', async () => {
      givenServing();

      await expect(service.update(SERVING_ID, { startTime: '12:30' }, user())).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('refuses a min year pushed past the stored max', async () => {
      givenServing();

      await expect(service.update(SERVING_ID, { minGradeLevel: 9 }, user())).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(tx.lunchServing.update).not.toHaveBeenCalled();
    });

    it('refuses a max year pulled below the stored min', async () => {
      givenServing();

      await expect(service.update(SERVING_ID, { maxGradeLevel: 1 }, user())).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('accepts a one-sided move that still leaves the row whole', async () => {
      givenServing();
      tx.lunchServing.update.mockResolvedValue(storedServing({ endTime: wallClock('11:45') }));

      await expect(service.update(SERVING_ID, { endTime: '11:45' }, user())).resolves.toMatchObject({
        endTime: '11:45',
      });
      expect(tx.lunchServing.update.mock.calls[0][0].data).toEqual({ endTime: wallClock('11:45') });
    });

    it('accepts both ends moved together past where either alone would fail', async () => {
      // 12:30-13:00 is entirely after the stored 11:00-12:00, so each end taken
      // on its own is invalid against the stored row while the pair is fine.
      givenServing();
      tx.lunchServing.update.mockResolvedValue(
        storedServing({ startTime: wallClock('12:30'), endTime: wallClock('13:00') }),
      );

      await expect(
        service.update(SERVING_ID, { startTime: '12:30', endTime: '13:00' }, user()),
      ).resolves.toMatchObject({ startTime: '12:30', endTime: '13:00' });
    });

    it('sends only the fields the payload named', async () => {
      givenServing();
      tx.lunchServing.update.mockResolvedValue(storedServing({ dayOfWeek: null }));

      await service.update(SERVING_ID, { dayOfWeek: null }, user());

      expect(tx.lunchServing.update.mock.calls[0][0].data).toEqual({ dayOfWeek: null });
    });

    /*
     * A read in one transaction and a write in another let a concurrent PATCH
     * commit in between, and so would a plain read in the same one: withRls
     * runs READ COMMITTED, where a read takes no lock. Against the stored
     * 11:00-12:00, a start moved to 11:30 and an end moved to 11:30:30 would
     * both pass on the untouched row, and the table's CHECK admits the
     * thirty-second sitting they build together.
     */
    it('reads the row it merges against under a lock, in the transaction that writes it', async () => {
      givenServing();
      tx.lunchServing.update.mockResolvedValue(storedServing({ endTime: wallClock('11:45') }));
      const ranIn = transactionsOf(prisma);
      const readIn = ranIn(queryRaw);
      const writtenIn = ranIn(tx.lunchServing.update);

      await service.update(SERVING_ID, { endTime: '11:45' }, user());

      // A lock lasts as long as the transaction that took it, so the read and
      // the write have to share one, and it has to be withRls's, the one
      // interactive transaction under the caller's claims. queryWithRls and
      // withVerifiedSubject commit their batch before the row comes back, and
      // any other helper, or a second withRls, is a transaction the write is
      // not in. Asking where each call ran catches all of those; asking whether
      // queryWithRls stayed idle caught one.
      expect(readIn).toEqual([expect.stringMatching(/^withRls#\d+$/)]);
      expect(writtenIn).toEqual(readIn);
      const [call] = queryRaw.mock.calls;
      expect(rawSql(call)).toMatch(
        /SELECT "startTime", "endTime", "minGradeLevel", "maxGradeLevel"\s+FROM "LunchServings"\s+WHERE "id" = \?::uuid\s+FOR UPDATE/,
      );
      expect(call.slice(1)).toEqual([SERVING_ID]);
      expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.lunchServing.update.mock.invocationCallOrder[0],
      );
    });

    it.each<[string, UpdateLunchServingDto, Record<string, unknown>]>([
      ['the lower year', { minGradeLevel: 5 }, { minGradeLevel: 5 }],
      ['the upper year', { maxGradeLevel: 5 }, { maxGradeLevel: 5 }],
      ['the start', { startTime: '11:15' }, { startTime: wallClock('11:15') }],
    ])('writes %s to the row it read, when that is all the PATCH names', async (_field, patch, data) => {
      // A field dropped on the way to the write is an edit that answers 200 and
      // leaves the kitchen's flow as it was.
      givenServing();
      tx.lunchServing.update.mockResolvedValue(storedServing());

      await service.update(SERVING_ID, patch, user());

      expect(tx.lunchServing.update).toHaveBeenCalledWith({ where: { id: SERVING_ID }, data });
    });

    it('maps a P2025 from the write to 404, though the lock leaves it no row to lose', async () => {
      givenServing();
      tx.lunchServing.update.mockRejectedValue(prismaError('P2025'));

      await expect(service.update(SERVING_ID, { endTime: '11:45' }, user())).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('reports an unknown sitting as missing rather than as a write failure', async () => {
      await expect(service.update(SERVING_ID, { endTime: '11:45' }, user())).rejects.toThrow(
        new NotFoundException(`Lunch serving ${SERVING_ID} not found.`),
      );
      expect(tx.lunchServing.update).not.toHaveBeenCalled();
    });

    /*
     * A sitting in another school is invisible under RLS, so the locking read
     * comes back empty and the caller is told the row does not exist. That is
     * the right answer and the right wording: confirming it exists elsewhere
     * would leak that another school has one.
     */
    it('cannot reach a sitting in another school', async () => {
      await expect(service.update(SERVING_ID, { endTime: '11:45' }, user())).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('seats per sitting', () => {
    const user = () => testUser({ schoolId: SCHOOL_ID });

    it('stores an omitted seat count as null, meaning the hall\'s own limit', async () => {
      tx.lunchServing.create.mockResolvedValue(storedServing());

      await service.create(
        { minGradeLevel: 4, maxGradeLevel: 6, startTime: '11:00', endTime: '12:00' },
        user(),
      );

      expect(tx.lunchServing.create.mock.calls[0][0].data.seats).toBeNull();
    });

    it('stores a seat count the sitting was given', async () => {
      tx.lunchServing.create.mockResolvedValue(storedServing({ seats: 90 }));

      const result = await service.create(
        {
          minGradeLevel: 4,
          maxGradeLevel: 6,
          startTime: '11:00',
          endTime: '12:00',
          seats: 90,
        },
        user(),
      );

      expect(tx.lunchServing.create.mock.calls[0][0].data.seats).toBe(90);
      expect(result.seats).toBe(90);
    });

    it('can clear a seat count back to the hall\'s limit', async () => {
      // `null` and "not sent" are different: one hands the sitting back to the
      // hall's own diningSeats, the other leaves the stored number alone.
      givenServing({ seats: 90 });
      tx.lunchServing.update.mockResolvedValue(storedServing({ seats: null }));

      await service.update(SERVING_ID, { seats: null }, user());

      expect(tx.lunchServing.update.mock.calls[0][0].data).toEqual({ seats: null });
    });

    it('leaves the stored seat count alone when the payload omits it', async () => {
      givenServing({ seats: 90 });
      tx.lunchServing.update.mockResolvedValue(storedServing({ seats: 90 }));

      await service.update(SERVING_ID, { endTime: '11:45' }, user());

      expect('seats' in tx.lunchServing.update.mock.calls[0][0].data).toBe(false);
    });
  });

  describe('remove', () => {
    it('deletes through RLS, so another school cannot reach the row', async () => {
      tx.lunchServing.delete.mockResolvedValue(storedServing());

      await service.remove(SERVING_ID, testUser({ schoolId: SCHOOL_ID }));

      expect(prisma.withRls).toHaveBeenCalled();
      expect(tx.lunchServing.delete).toHaveBeenCalledWith({ where: { id: SERVING_ID } });
    });

    it('refuses a caller with no school', async () => {
      await expect(
        service.remove(SERVING_ID, testUser({ schoolId: null })),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(tx.lunchServing.delete).not.toHaveBeenCalled();
    });

    it('maps an unknown or cross-tenant id (P2025) to 404', async () => {
      tx.lunchServing.delete.mockRejectedValue(prismaError('P2025'));

      await expect(
        service.remove(SERVING_ID, testUser({ schoolId: SCHOOL_ID })),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
