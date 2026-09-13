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

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new FrameTimesService(prisma as unknown as PrismaService);
  });

  /** The stored frame, found by its own id and by nothing else — as the table would. */
  const givenFrame = (overrides: Record<string, unknown> = {}) => {
    const row = storedFrame(overrides);
    tx.frameTime.findUnique.mockImplementation(({ where }: { where?: { id?: string } }) => {
      if (where?.id === undefined) {
        throw new Error('Prisma: findUnique needs a unique field in `where`.');
      }
      return Promise.resolve(where.id === row.id ? row : null);
    });
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

    it('maps a write that finds the row gone (P2025) to 404', async () => {
      givenFrame();
      tx.frameTime.update.mockRejectedValue(prismaError('P2025'));

      await expect(service.update(FRAME_ID, { endTime: '13:00' }, user())).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('reports an unknown frame as missing rather than as a write failure', async () => {
      tx.frameTime.findUnique.mockResolvedValue(null);

      await expect(service.update(FRAME_ID, { endTime: '13:00' }, user())).rejects.toThrow(
        new NotFoundException(`Frame time ${FRAME_ID} not found.`),
      );
      expect(tx.frameTime.update).not.toHaveBeenCalled();
    });

    /*
     * A frame in another school is invisible under RLS, so findUnique returns
     * null and the caller is told the row does not exist. That is the right
     * answer and the right wording: confirming it exists elsewhere would leak
     * that another school has one.
     */
    it('cannot reach a frame in another school', async () => {
      tx.frameTime.findUnique.mockResolvedValue(null);

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
