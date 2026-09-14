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
import { RastsService } from './rasts.service';

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const RAST_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

/** A `@db.Time` value as Prisma hands it back: a Date anchored at 1970-01-01. */
const wallClock = (time: string): Date => new Date(`1970-01-01T${time}:00.000Z`);

/** Reconstructs the SQL text of a tagged-template $queryRaw call. */
const rawSql = (call: unknown[]): string => (call[0] as readonly string[]).join('?');

const storedRast = (overrides: Record<string, unknown> = {}) => ({
  id: RAST_ID,
  schoolId: SCHOOL_ID,
  name: 'Förmiddagsrast',
  minGradeLevel: 4,
  maxGradeLevel: 6,
  dayOfWeek: null,
  startTime: wallClock('09:40'),
  endTime: wallClock('10:00'),
  requiresLessonBefore: false,
  createdAt: new Date('2026-09-05T09:00:00.000Z'),
  updatedAt: new Date('2026-09-05T09:00:00.000Z'),
  ...overrides,
});

const createDto = (overrides: Record<string, unknown> = {}) => ({
  name: 'Förmiddagsrast',
  minGradeLevel: 4,
  maxGradeLevel: 6,
  dayOfWeek: null,
  startTime: '09:40',
  endTime: '10:00',
  ...overrides,
}) as Parameters<RastsService['create']>[0];

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
    if (name === undefined || !(name in storedRast())) {
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

describe('RastsService', () => {
  let tx: TxMock;
  let prisma: PrismaMock;
  let service: RastsService;
  /** The rows the locking read in update() can find: none until a test stores one. */
  let rasts: Record<string, unknown>[];
  /** The locking read of the stored bounds in update(). */
  let queryRaw: jest.Mock;

  beforeEach(() => {
    tx = createTxMock();
    rasts = [];
    // The auto-vivifying mock would hand back a model proxy for `$queryRaw`,
    // and a proxy is not callable. It answers as the table would, from the rows
    // a test stored: a row nobody stored is a row the lock does not find.
    queryRaw = jest.fn((...call: unknown[]) =>
      Promise.resolve(lockingRead('Rasts', rasts, call)),
    );
    Object.assign(tx, { $queryRaw: queryRaw });
    prisma = createPrismaMock(tx);
    service = new RastsService(prisma as unknown as PrismaService);
  });

  /** The stored rast, found by its own id and by nothing else — as the table would. */
  const givenRast = (overrides: Record<string, unknown> = {}) => {
    rasts.push(storedRast(overrides));
  };

  describe('the times it returns', () => {
    it('hands back HH:MM, not a 1970 timestamp', async () => {
      // Prisma reads a TIME column into a Date at 1970-01-01, and stringifying
      // that sends a timestamp where the form expects a clock — the bug that
      // put "1970-" into the lunch card's <input type="time"> and rendered it
      // empty on every load. Asserted on the exact string, because anything
      // that merely contains "09:40" would pass for the timestamp too.
      tx.rast.findMany.mockResolvedValue([storedRast()]);

      const [rast] = await service.list(testUser({ schoolId: SCHOOL_ID }));

      expect(rast.startTime).toBe('09:40');
      expect(rast.endTime).toBe('10:00');
    });

    it('orders the day the way it is lived', async () => {
      // Youngest stage first, the every-day row before the weekday that may
      // shadow it, then up the clock. The admin page prints this order and does
      // not re-sort, so the sort belongs here.
      await service.list(testUser({ schoolId: SCHOOL_ID }));

      expect(tx.rast.findMany).toHaveBeenCalledWith({
        orderBy: [
          { minGradeLevel: 'asc' },
          { dayOfWeek: { sort: 'asc', nulls: 'first' } },
          { startTime: 'asc' },
        ],
      });
    });
  });

  describe('the window', () => {
    it('refuses a rast that ends before it starts', async () => {
      await expect(
        service.create(createDto({ startTime: '10:00', endTime: '09:40' }), testUser()),
      ).rejects.toThrow(new BadRequestException('startTime must be before endTime.'));
      expect(tx.rast.create).not.toHaveBeenCalled();
    });

    it('compares minutes, not strings', async () => {
      // The DTO's regex admits HH:MM:SS, and a lexical compare reads "09:40" as
      // before "09:40:30" — a thirty-second rast, accepted as a window.
      await expect(
        service.create(createDto({ startTime: '09:40', endTime: '09:40:30' }), testUser()),
      ).rejects.toThrow(BadRequestException);
    });

    it('accepts a three-minute rast', async () => {
      // No minimum length, deliberately: three minutes is what a changeover
      // between two rooms is, and the engine rounds it OUTWARD to a whole slot
      // rather than to nothing. A minimum here would refuse the case the
      // feature is most often wanted for.
      tx.rast.create.mockResolvedValue(
        storedRast({ startTime: wallClock('09:40'), endTime: wallClock('09:43') }),
      );

      await service.create(
        createDto({ startTime: '09:40', endTime: '09:43' }),
        testUser({ schoolId: SCHOOL_ID }),
      );

      expect(tx.rast.create).toHaveBeenCalled();
    });
  });

  describe('the span', () => {
    it('refuses a span written backwards', async () => {
      await expect(
        service.create(createDto({ minGradeLevel: 6, maxGradeLevel: 4 }), testUser()),
      ).rejects.toThrow(
        new BadRequestException('minGradeLevel must not be above maxGradeLevel.'),
      );
    });

    it('accepts a single year written as a span of one', async () => {
      tx.rast.create.mockResolvedValue(storedRast({ minGradeLevel: 4, maxGradeLevel: 4 }));

      await service.create(
        createDto({ minGradeLevel: 4, maxGradeLevel: 4 }),
        testUser({ schoolId: SCHOOL_ID }),
      );

      expect(tx.rast.create).toHaveBeenCalled();
    });
  });

  describe('a partial update', () => {
    it('checks the merge of stored and sent, not the payload alone', async () => {
      // A PATCH naming one end of the window says nothing about the other.
      // Validating the payload alone lets the database answer with a constraint
      // violation the admin cannot act on.
      givenRast();

      await expect(
        service.update(RAST_ID, { endTime: '09:20' }, testUser({ schoolId: SCHOOL_ID })),
      ).rejects.toThrow(BadRequestException);
      expect(tx.rast.update).not.toHaveBeenCalled();
    });

    // A read in one transaction and a write in another let a concurrent PATCH
    // commit in between, and so would a plain read in the same one: withRls
    // runs READ COMMITTED, where a read takes no lock. Against 09:30-10:00, a
    // start moved to 09:40 and an end moved to 09:40:30 would both pass on the
    // untouched row, and the table's CHECK admits the thirty-second rast they
    // build together.
    it('reads the row it merges against under a lock, in the transaction that writes it', async () => {
      givenRast();
      tx.rast.update.mockResolvedValue(storedRast({ endTime: wallClock('10:10') }));
      const ranIn = transactionsOf(prisma);
      const readIn = ranIn(queryRaw);
      const writtenIn = ranIn(tx.rast.update);

      await service.update(RAST_ID, { endTime: '10:10' }, testUser({ schoolId: SCHOOL_ID }));

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
        /SELECT "startTime", "endTime", "minGradeLevel", "maxGradeLevel"\s+FROM "Rasts"\s+WHERE "id" = \?::uuid\s+FOR UPDATE/,
      );
      expect(call.slice(1)).toEqual([RAST_ID]);
      expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.rast.update.mock.invocationCallOrder[0],
      );
    });

    it('writes only the fields the payload names', async () => {
      givenRast();
      tx.rast.update.mockResolvedValue(storedRast({ name: 'Eftermiddagsrast' }));

      await service.update(
        RAST_ID,
        { name: 'Eftermiddagsrast' },
        testUser({ schoolId: SCHOOL_ID }),
      );

      expect(tx.rast.update).toHaveBeenCalledWith({
        where: { id: RAST_ID },
        data: { name: 'Eftermiddagsrast' },
      });
    });

    it('404s on a rast that is not there', async () => {
      await expect(
        service.update(RAST_ID, { name: 'X' }, testUser({ schoolId: SCHOOL_ID })),
      ).rejects.toThrow(new NotFoundException(`Rast ${RAST_ID} not found.`));
    });

    it('refuses a lower year pushed past the stored upper one', async () => {
      // The upper year is never sent; the merge takes it from the row.
      givenRast();

      await expect(
        service.update(RAST_ID, { minGradeLevel: 9 }, testUser({ schoolId: SCHOOL_ID })),
      ).rejects.toThrow(
        new BadRequestException('minGradeLevel must not be above maxGradeLevel.'),
      );
      expect(tx.rast.update).not.toHaveBeenCalled();
    });

    it('refuses an upper year pulled below the stored lower one', async () => {
      givenRast();

      await expect(
        service.update(RAST_ID, { maxGradeLevel: 1 }, testUser({ schoolId: SCHOOL_ID })),
      ).rejects.toThrow(BadRequestException);
      expect(tx.rast.update).not.toHaveBeenCalled();
    });

    it('trims a new name as create does', async () => {
      givenRast();
      tx.rast.update.mockResolvedValue(storedRast({ name: 'Lunchrast' }));

      await service.update(RAST_ID, { name: '  Lunchrast ' }, testUser({ schoolId: SCHOOL_ID }));

      expect(tx.rast.update).toHaveBeenCalledWith({
        where: { id: RAST_ID },
        data: { name: 'Lunchrast' },
      });
    });

    it.each<[string, Parameters<RastsService['update']>[1], Record<string, unknown>]>([
      ['the lower year', { minGradeLevel: 5 }, { minGradeLevel: 5 }],
      ['the upper year', { maxGradeLevel: 5 }, { maxGradeLevel: 5 }],
      ['the weekday', { dayOfWeek: 3 }, { dayOfWeek: 3 }],
      ['the start', { startTime: '09:30' }, { startTime: wallClock('09:30') }],
      ['the end', { endTime: '10:10' }, { endTime: wallClock('10:10') }],
    ])('writes %s when that is all the PATCH names', async (_field, patch, data) => {
      // A field dropped on the way to the write is an edit that answers 200 and
      // leaves the rast where the engine already had it.
      givenRast();
      tx.rast.update.mockResolvedValue(storedRast());

      await service.update(RAST_ID, patch, testUser({ schoolId: SCHOOL_ID }));

      expect(tx.rast.update).toHaveBeenCalledWith({ where: { id: RAST_ID }, data });
    });

    it('maps a P2025 from the write to 404, though the lock leaves it no row to lose', async () => {
      givenRast();
      tx.rast.update.mockRejectedValue(prismaError('P2025'));

      await expect(
        service.update(RAST_ID, { name: 'X' }, testUser({ schoolId: SCHOOL_ID })),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('the name', () => {
    it('trims it, so a name of spaces cannot reach the CHECK', async () => {
      tx.rast.create.mockResolvedValue(storedRast());

      await service.create(
        createDto({ name: '  Förmiddagsrast  ' }),
        testUser({ schoolId: SCHOOL_ID }),
      );

      const [[call]] = tx.rast.create.mock.calls as [[{ data: { name: string } }]];
      expect(call.data.name).toBe('Förmiddagsrast');
    });
  });

  describe('the lesson before the rast', () => {
    it('is off when the payload does not name it', async () => {
      // A column with a default is not a service with one: `create` writes an
      // explicit value, and `undefined` reaching Prisma here would be the
      // database's default rather than this service's — the same value today
      // and a silent difference the day the default changes.
      tx.rast.create.mockResolvedValue(storedRast());

      await service.create(createDto(), testUser({ schoolId: SCHOOL_ID }));

      const [[call]] = tx.rast.create.mock.calls as [
        [{ data: { requiresLessonBefore: boolean } }]
      ];
      expect(call.data.requiresLessonBefore).toBe(false);
    });

    it('is written when the payload asks for it', async () => {
      tx.rast.create.mockResolvedValue(storedRast({ requiresLessonBefore: true }));

      const response = await service.create(
        createDto({ requiresLessonBefore: true }),
        testUser({ schoolId: SCHOOL_ID }),
      );

      const [[call]] = tx.rast.create.mock.calls as [
        [{ data: { requiresLessonBefore: boolean } }]
      ];
      expect(call.data.requiresLessonBefore).toBe(true);
      expect(response.requiresLessonBefore).toBe(true);
    });

    it('survives a PATCH that names something else', async () => {
      // The flag is a boolean, so `dto.requiresLessonBefore ?? current` would
      // read an omitted field as false and turn the rule OFF every time the
      // school renamed a rast. The service tests `!== undefined` for exactly
      // this, and a boolean is the one type where the mistake is invisible.
      givenRast({ requiresLessonBefore: true });
      tx.rast.update.mockResolvedValue(storedRast({ requiresLessonBefore: true }));

      await service.update(RAST_ID, { name: 'X' }, testUser({ schoolId: SCHOOL_ID }));

      expect(tx.rast.update).toHaveBeenCalledWith({
        where: { id: RAST_ID },
        data: { name: 'X' },
      });
    });

    it('can be switched off by a PATCH that names it false', async () => {
      givenRast({ requiresLessonBefore: true });
      tx.rast.update.mockResolvedValue(storedRast({ requiresLessonBefore: false }));

      await service.update(
        RAST_ID,
        { requiresLessonBefore: false },
        testUser({ schoolId: SCHOOL_ID }),
      );

      expect(tx.rast.update).toHaveBeenCalledWith({
        where: { id: RAST_ID },
        data: { requiresLessonBefore: false },
      });
    });
  });

  describe('the every-day row', () => {
    it('stores an explicit null rather than dropping the field', async () => {
      // `dayOfWeek: null` is the every-day rast and is the common case. A DTO
      // that rejected it as not-an-integer, or a service that coerced it to
      // undefined, would make the ordinary Swedish week unwritable.
      tx.rast.create.mockResolvedValue(storedRast());

      await service.create(createDto({ dayOfWeek: null }), testUser({ schoolId: SCHOOL_ID }));

      const [[call]] = tx.rast.create.mock.calls as [
        [{ data: { dayOfWeek: number | null } }],
      ];
      expect(call.data.dayOfWeek).toBeNull();
    });

    it('stores the weekday a rast was given', async () => {
      // The other half: a Tuesday-only rast written as every day would take a
      // break out of four days that never had one.
      tx.rast.create.mockResolvedValue(storedRast({ dayOfWeek: 2 }));

      await service.create(createDto({ dayOfWeek: 2 }), testUser({ schoolId: SCHOOL_ID }));

      const [[call]] = tx.rast.create.mock.calls as [
        [{ data: { dayOfWeek: number | null } }],
      ];
      expect(call.data.dayOfWeek).toBe(2);
    });
  });

  describe('what the database refuses', () => {
    it('answers a write refused as a duplicate (P2002) with 409', async () => {
      tx.rast.create.mockRejectedValue(prismaError('P2002'));

      await expect(
        service.create(createDto(), testUser({ schoolId: SCHOOL_ID })),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('remove', () => {
    it('deletes by id through RLS, so another school cannot reach the row', async () => {
      tx.rast.delete.mockResolvedValue(storedRast());
      const user = testUser({ schoolId: SCHOOL_ID });

      await expect(service.remove(RAST_ID, user)).resolves.toBeUndefined();

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.rast.delete).toHaveBeenCalledWith({ where: { id: RAST_ID } });
    });

    it('refuses a caller with no school', async () => {
      await expect(
        service.remove(RAST_ID, testUser({ schoolId: null })),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(tx.rast.delete).not.toHaveBeenCalled();
    });

    it('maps an unknown or cross-tenant id (P2025) to 404', async () => {
      // Another school's row is invisible under RLS, so the delete matches
      // nothing and Prisma answers P2025. To this caller that is exactly "not
      // there" — and anything more specific would confirm the row exists.
      tx.rast.delete.mockRejectedValue(prismaError('P2025'));

      await expect(
        service.remove(RAST_ID, testUser({ schoolId: SCHOOL_ID })),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
