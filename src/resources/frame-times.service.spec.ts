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
import { FrameTimesService } from './frame-times.service';
import type { UpdateFrameTimeDto } from './dto/frame-time.dto';

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const FRAME_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

/** A `@db.Time` value as Prisma hands it back: a Date anchored at 1970-01-01. */
const wallClock = (time: string): Date => new Date(`1970-01-01T${time}:00.000Z`);

/** Reconstructs the SQL text of a tagged-template $queryRaw call. */
const rawSql = (call: unknown[]): string => (call[0] as readonly string[]).join('?');

const storedFrame = (overrides: Record<string, unknown> = {}) => ({
  id: FRAME_ID,
  schoolId: SCHOOL_ID,
  minGradeLevel: 4,
  maxGradeLevel: 6,
  dayOfWeek: 1,
  startTime: wallClock('08:00'),
  endTime: wallClock('15:00'),
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
    if (name === undefined || !(name in storedFrame())) {
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

describe('FrameTimesService', () => {
  let tx: TxMock;
  let prisma: PrismaMock;
  let service: FrameTimesService;
  /** The rows the locking read in update() can find: none until a test stores one. */
  let frames: Record<string, unknown>[];
  /** The locking read of the stored bounds in update(). */
  let queryRaw: jest.Mock;

  beforeEach(() => {
    tx = createTxMock();
    frames = [];
    // The auto-vivifying mock would hand back a model proxy for `$queryRaw`,
    // and a proxy is not callable. It answers as the table would, from the rows
    // a test stored: a row nobody stored is a row the lock does not find.
    queryRaw = jest.fn((...call: unknown[]) =>
      Promise.resolve(lockingRead('FrameTimes', frames, call)),
    );
    Object.assign(tx, { $queryRaw: queryRaw });
    prisma = createPrismaMock(tx);
    service = new FrameTimesService(prisma as unknown as PrismaService);
  });

  /** The stored frame, found by its own id and by nothing else — as the table would. */
  const givenFrame = (overrides: Record<string, unknown> = {}) => {
    frames.push(storedFrame(overrides));
  };

  // -------------------------------------------------------------------------
  // The clock, which is the whole reason this service has a response type
  // -------------------------------------------------------------------------

  describe('the times it returns', () => {
    /*
     * Prisma reads a TIME column into a Date at 1970-01-01, and JSON.stringify
     * turns that into "1970-01-01T15:00:00.000Z". Returning the row unmapped
     * therefore sends a timestamp where the form expects a clock — the bug that
     * put "1970-" into the lunch card's <input type="time"> and rendered it
     * empty on every load. The assertion below is on the exact string, because
     * anything that merely "contains 15:00" would also pass for the timestamp.
     */
    it('hands back HH:MM, not a 1970 timestamp', async () => {
      tx.frameTime.findMany.mockResolvedValue([storedFrame()]);

      const [frame] = await service.list(testUser({ schoolId: SCHOOL_ID }));

      expect(frame.startTime).toBe('08:00');
      expect(frame.endTime).toBe('15:00');
      expect(JSON.stringify(frame)).not.toContain('1970');
    });

    it('reads the stored clock in UTC, so no zone can shift it', async () => {
      // 23:00 is the hour a Stockholm-local read would roll into the next day.
      tx.frameTime.findMany.mockResolvedValue([
        storedFrame({ startTime: wallClock('00:30'), endTime: wallClock('23:00') }),
      ]);

      const [frame] = await service.list(testUser({ schoolId: SCHOOL_ID }));

      expect([frame.startTime, frame.endTime]).toEqual(['00:30', '23:00']);
    });

    it('sends the every-day frame back as null, not as a missing field', async () => {
      tx.frameTime.findMany.mockResolvedValue([storedFrame({ dayOfWeek: null })]);

      const [frame] = await service.list(testUser({ schoolId: SCHOOL_ID }));

      expect(frame.dayOfWeek).toBeNull();
      expect('dayOfWeek' in frame).toBe(true);
    });

    it('lists stage by stage, each every-day frame before the weekdays that narrow it', async () => {
      // The order the form reads in, and the form does not re-sort: a Monday
      // row printed above the every-day frame it narrows reads as the rule, not
      // the exception. The rows arrive scrambled and are sorted by the
      // service's own orderBy, and each of its keys has a pair only it can order.
      const rows = [
        storedFrame({ id: 'åk4-6', minGradeLevel: 4, maxGradeLevel: 6, dayOfWeek: null }),
        storedFrame({ id: 'åk0-3-måndag', minGradeLevel: 0, maxGradeLevel: 3, dayOfWeek: 1 }),
        storedFrame({ id: 'åk0-9', minGradeLevel: 0, maxGradeLevel: 9, dayOfWeek: null }),
        storedFrame({ id: 'åk0-3', minGradeLevel: 0, maxGradeLevel: 3, dayOfWeek: null }),
      ];
      tx.frameTime.findMany.mockImplementation((args: { orderBy?: unknown } = {}) =>
        Promise.resolve(ordered(rows, args.orderBy)),
      );

      const frames = await service.list(testUser({ schoolId: SCHOOL_ID }));

      expect(frames.map((frame) => frame.id)).toEqual([
        'åk0-3',
        'åk0-3-måndag',
        'åk0-9',
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
      tx.frameTime.create.mockResolvedValue(storedFrame());

      await service.create(
        { minGradeLevel: 4, maxGradeLevel: 6, dayOfWeek: 1, startTime: '08:00', endTime: '15:00' },
        user(),
      );

      expect(tx.frameTime.create).toHaveBeenCalledWith({
        data: {
          // Zero unless the school asks for a corridor, which is every school
          // until somebody writes a number.
          changeoverMinutes: 0,
          schoolId: SCHOOL_ID,
          minGradeLevel: 4,
          maxGradeLevel: 6,
          dayOfWeek: 1,
          startTime: wallClock('08:00'),
          endTime: wallClock('15:00'),
        },
      });
    });

    it('treats an omitted weekday as the every-day frame', async () => {
      tx.frameTime.create.mockResolvedValue(storedFrame({ dayOfWeek: null }));

      await service.create(
        { minGradeLevel: 0, maxGradeLevel: 3, startTime: '08:00', endTime: '14:00' },
        user(),
      );

      expect(tx.frameTime.create.mock.calls[0][0].data.dayOfWeek).toBeNull();
    });

    it('refuses a window that ends before it starts', async () => {
      await expect(
        service.create(
          { minGradeLevel: 4, maxGradeLevel: 6, startTime: '15:00', endTime: '08:00' },
          user(),
        ),
      ).rejects.toThrow(new BadRequestException('startTime must be before endTime.'));
      expect(tx.frameTime.create).not.toHaveBeenCalled();
    });

    it('reads a start that is not on the hour', async () => {
      // 08:30 is 510 minutes. Weigh the hour wrong and it compares as later
      // than 15:00, and the most ordinary morning start is refused.
      tx.frameTime.create.mockResolvedValue(storedFrame({ startTime: wallClock('08:30') }));

      await expect(
        service.create(
          { minGradeLevel: 4, maxGradeLevel: 6, startTime: '08:30', endTime: '15:00' },
          user(),
        ),
      ).resolves.toMatchObject({ startTime: '08:30' });
    });

    it('refuses a window of no length', async () => {
      // Not a frame but a closed day, which is a thing to say with a lov.
      await expect(
        service.create(
          { minGradeLevel: 4, maxGradeLevel: 6, startTime: '08:00', endTime: '08:00' },
          user(),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a window that is only seconds long', async () => {
      /*
       * The case a lexical compare gets wrong. "09:00" sorts before "09:00:30"
       * because it is a prefix, so a string check reads this as a valid window
       * and stores a thirty-second frame — a row no grid can place a lesson in.
       * The DTO's regex admits both lengths, so it is reachable from the wire.
       */
      await expect(
        service.create(
          { minGradeLevel: 4, maxGradeLevel: 6, startTime: '09:00', endTime: '09:00:30' },
          user(),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.frameTime.create).not.toHaveBeenCalled();
    });

    it('still accepts a seconds-bearing clock that spans real minutes', async () => {
      tx.frameTime.create.mockResolvedValue(storedFrame());

      await expect(
        service.create(
          { minGradeLevel: 4, maxGradeLevel: 6, startTime: '08:00:00', endTime: '15:00' },
          user(),
        ),
      ).resolves.toMatchObject({ startTime: '08:00' });
    });

    it('refuses an inverted year span', async () => {
      await expect(
        service.create(
          { minGradeLevel: 9, maxGradeLevel: 4, startTime: '08:00', endTime: '15:00' },
          user(),
        ),
      ).rejects.toThrow(
        new BadRequestException('minGradeLevel must not be above maxGradeLevel.'),
      );
      expect(tx.frameTime.create).not.toHaveBeenCalled();
    });

    it('answers a write the database refuses as a duplicate (P2002) with 409', async () => {
      tx.frameTime.create.mockRejectedValue(prismaError('P2002'));

      await expect(
        service.create(
          { minGradeLevel: 4, maxGradeLevel: 6, startTime: '08:00', endTime: '15:00' },
          user(),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('accepts a single year, which is the common case', async () => {
      tx.frameTime.create.mockResolvedValue(storedFrame({ minGradeLevel: 4, maxGradeLevel: 4 }));

      await expect(
        service.create(
          { minGradeLevel: 4, maxGradeLevel: 4, startTime: '08:00', endTime: '15:00' },
          user(),
        ),
      ).resolves.toMatchObject({ minGradeLevel: 4, maxGradeLevel: 4 });
    });

    it('refuses a caller with no school', async () => {
      await expect(
        service.create(
          { minGradeLevel: 4, maxGradeLevel: 6, startTime: '08:00', endTime: '15:00' },
          testUser({ schoolId: null }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(tx.frameTime.create).not.toHaveBeenCalled();
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
      givenFrame();

      await expect(service.update(FRAME_ID, { endTime: '07:00' }, user())).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(tx.frameTime.update).not.toHaveBeenCalled();
    });

    it('refuses a start moved past the end it never mentions', async () => {
      givenFrame();

      await expect(service.update(FRAME_ID, { startTime: '16:00' }, user())).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('refuses a min year pushed past the stored max', async () => {
      givenFrame();

      await expect(service.update(FRAME_ID, { minGradeLevel: 9 }, user())).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(tx.frameTime.update).not.toHaveBeenCalled();
    });

    it('refuses a max year pulled below the stored min', async () => {
      givenFrame();

      await expect(service.update(FRAME_ID, { maxGradeLevel: 1 }, user())).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('accepts a one-sided move that still leaves the row whole', async () => {
      givenFrame();
      tx.frameTime.update.mockResolvedValue(storedFrame({ endTime: wallClock('13:00') }));

      await expect(service.update(FRAME_ID, { endTime: '13:00' }, user())).resolves.toMatchObject({
        endTime: '13:00',
      });
      expect(tx.frameTime.update.mock.calls[0][0].data).toEqual({ endTime: wallClock('13:00') });
    });

    it('accepts both ends moved together past where either alone would fail', async () => {
      // 16:00-17:00 is entirely after the stored 08:00-15:00, so each end taken
      // on its own is invalid against the stored row and the pair is fine.
      givenFrame();
      tx.frameTime.update.mockResolvedValue(
        storedFrame({ startTime: wallClock('16:00'), endTime: wallClock('17:00') }),
      );

      await expect(
        service.update(FRAME_ID, { startTime: '16:00', endTime: '17:00' }, user()),
      ).resolves.toMatchObject({ startTime: '16:00', endTime: '17:00' });
    });

    it('sends only the fields the payload named', async () => {
      givenFrame();
      tx.frameTime.update.mockResolvedValue(storedFrame({ dayOfWeek: null }));

      await service.update(FRAME_ID, { dayOfWeek: null }, user());

      expect(tx.frameTime.update.mock.calls[0][0].data).toEqual({ dayOfWeek: null });
    });

    /*
     * A read in one transaction and a write in another let a concurrent PATCH
     * commit in between, and so would a plain read in the same one: withRls
     * runs READ COMMITTED, where a read takes no lock. Against the stored
     * 08:00-15:00, a start moved to 14:00 and an end moved to 14:00:30 would
     * both pass on the untouched row, and the table's CHECK admits the
     * thirty-second frame they build together. The merge is only as good as
     * the row it saw, so that row is held until the write commits.
     */
    it('reads the row it merges against under a lock, in the transaction that writes it', async () => {
      givenFrame();
      tx.frameTime.update.mockResolvedValue(storedFrame({ endTime: wallClock('13:00') }));
      const ranIn = transactionsOf(prisma);
      const readIn = ranIn(queryRaw);
      const writtenIn = ranIn(tx.frameTime.update);

      await service.update(FRAME_ID, { endTime: '13:00' }, user());

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
        /SELECT "startTime", "endTime", "minGradeLevel", "maxGradeLevel"\s+FROM "FrameTimes"\s+WHERE "id" = \?::uuid\s+FOR UPDATE/,
      );
      expect(call.slice(1)).toEqual([FRAME_ID]);
      expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.frameTime.update.mock.invocationCallOrder[0],
      );
    });

    it.each<[string, UpdateFrameTimeDto, Record<string, unknown>]>([
      ['the lower year', { minGradeLevel: 5 }, { minGradeLevel: 5 }],
      ['the upper year', { maxGradeLevel: 5 }, { maxGradeLevel: 5 }],
      ['the start', { startTime: '09:00' }, { startTime: wallClock('09:00') }],
      ['the changeover', { changeoverMinutes: 10 }, { changeoverMinutes: 10 }],
    ])('writes %s to the row it read, when that is all the PATCH names', async (_field, patch, data) => {
      // A field dropped on the way to the write is an edit that answers 200 and
      // changes nothing, which the school finds out on the next generation.
      givenFrame();
      tx.frameTime.update.mockResolvedValue(storedFrame());

      await service.update(FRAME_ID, patch, user());

      expect(tx.frameTime.update).toHaveBeenCalledWith({ where: { id: FRAME_ID }, data });
    });

    it('compares the minutes of the hour, not only the hour', async () => {
      // 08:00-08:45 is short and real. Read only the leading digits, or take
      // the minutes away instead of adding them, and it compares as empty or
      // inverted.
      givenFrame();
      tx.frameTime.update.mockResolvedValue(storedFrame({ endTime: wallClock('08:45') }));

      await expect(service.update(FRAME_ID, { endTime: '08:45' }, user())).resolves.toMatchObject({
        endTime: '08:45',
      });
    });

    it('maps a P2025 from the write to 404, though the lock leaves it no row to lose', async () => {
      givenFrame();
      tx.frameTime.update.mockRejectedValue(prismaError('P2025'));

      await expect(service.update(FRAME_ID, { endTime: '13:00' }, user())).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('reports an unknown frame as missing rather than as a write failure', async () => {
      await expect(service.update(FRAME_ID, { endTime: '13:00' }, user())).rejects.toThrow(
        new NotFoundException(`Frame time ${FRAME_ID} not found.`),
      );
      expect(tx.frameTime.update).not.toHaveBeenCalled();
    });

    /*
     * A frame in another school is invisible under RLS, so the locking read
     * comes back empty and the caller is told the row does not exist. That is
     * the right answer and the right wording: confirming it exists elsewhere
     * would leak that another school has one.
     */
    it('cannot reach a frame in another school', async () => {
      await expect(service.update(FRAME_ID, { endTime: '13:00' }, user())).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('remove', () => {
    it('deletes through RLS, so another school cannot reach the row', async () => {
      tx.frameTime.delete.mockResolvedValue(storedFrame());

      await service.remove(FRAME_ID, testUser({ schoolId: SCHOOL_ID }));

      expect(prisma.withRls).toHaveBeenCalled();
      expect(tx.frameTime.delete).toHaveBeenCalledWith({ where: { id: FRAME_ID } });
    });

    it('refuses a caller with no school', async () => {
      await expect(
        service.remove(FRAME_ID, testUser({ schoolId: null })),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(tx.frameTime.delete).not.toHaveBeenCalled();
    });

    it('maps an unknown or cross-tenant id (P2025) to 404', async () => {
      tx.frameTime.delete.mockRejectedValue(prismaError('P2025'));

      await expect(
        service.remove(FRAME_ID, testUser({ schoolId: SCHOOL_ID })),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
