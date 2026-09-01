import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  createPrismaMock,
  createTxMock,
  testUser,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { LunchServingsService } from './lunch-servings.service';

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const SERVING_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

/** A `@db.Time` value as Prisma hands it back: a Date anchored at 1970-01-01. */
const wallClock = (time: string): Date => new Date(`1970-01-01T${time}:00.000Z`);

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

describe('LunchServingsService', () => {
  let tx: TxMock;
  let prisma: PrismaMock;
  let service: LunchServingsService;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new LunchServingsService(prisma as unknown as PrismaService);
  });

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
      ).rejects.toBeInstanceOf(BadRequestException);
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
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.lunchServing.create).not.toHaveBeenCalled();
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
      tx.lunchServing.findUnique.mockResolvedValue(storedServing());

      await expect(service.update(SERVING_ID, { endTime: '07:00' }, user())).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(tx.lunchServing.update).not.toHaveBeenCalled();
    });

    it('refuses a start moved past the end it never mentions', async () => {
      tx.lunchServing.findUnique.mockResolvedValue(storedServing());

      await expect(service.update(SERVING_ID, { startTime: '12:30' }, user())).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('refuses a min year pushed past the stored max', async () => {
      tx.lunchServing.findUnique.mockResolvedValue(storedServing());

      await expect(service.update(SERVING_ID, { minGradeLevel: 9 }, user())).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(tx.lunchServing.update).not.toHaveBeenCalled();
    });

    it('refuses a max year pulled below the stored min', async () => {
      tx.lunchServing.findUnique.mockResolvedValue(storedServing());

      await expect(service.update(SERVING_ID, { maxGradeLevel: 1 }, user())).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('accepts a one-sided move that still leaves the row whole', async () => {
      tx.lunchServing.findUnique.mockResolvedValue(storedServing());
      tx.lunchServing.update.mockResolvedValue(storedServing({ endTime: wallClock('11:45') }));

      await expect(service.update(SERVING_ID, { endTime: '11:45' }, user())).resolves.toMatchObject({
        endTime: '11:45',
      });
      expect(tx.lunchServing.update.mock.calls[0][0].data).toEqual({ endTime: wallClock('11:45') });
    });

    it('accepts both ends moved together past where either alone would fail', async () => {
      // 12:30-13:00 is entirely after the stored 11:00-12:00, so each end taken
      // on its own is invalid against the stored row while the pair is fine.
      tx.lunchServing.findUnique.mockResolvedValue(storedServing());
      tx.lunchServing.update.mockResolvedValue(
        storedServing({ startTime: wallClock('12:30'), endTime: wallClock('13:00') }),
      );

      await expect(
        service.update(SERVING_ID, { startTime: '12:30', endTime: '13:00' }, user()),
      ).resolves.toMatchObject({ startTime: '12:30', endTime: '13:00' });
    });

    it('sends only the fields the payload named', async () => {
      tx.lunchServing.findUnique.mockResolvedValue(storedServing());
      tx.lunchServing.update.mockResolvedValue(storedServing({ dayOfWeek: null }));

      await service.update(SERVING_ID, { dayOfWeek: null }, user());

      expect(tx.lunchServing.update.mock.calls[0][0].data).toEqual({ dayOfWeek: null });
    });

    it('reports an unknown sitting as missing rather than as a write failure', async () => {
      tx.lunchServing.findUnique.mockResolvedValue(null);

      await expect(service.update(SERVING_ID, { endTime: '11:45' }, user())).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(tx.lunchServing.update).not.toHaveBeenCalled();
    });

    /*
     * A sitting in another school is invisible under RLS, so findUnique returns
     * null and the caller is told the row does not exist. That is the right
     * answer and the right wording: confirming it exists elsewhere would leak
     * that another school has one.
     */
    it('cannot reach a sitting in another school', async () => {
      tx.lunchServing.findUnique.mockResolvedValue(null);

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
      tx.lunchServing.findUnique.mockResolvedValue(storedServing({ seats: 90 }));
      tx.lunchServing.update.mockResolvedValue(storedServing({ seats: null }));

      await service.update(SERVING_ID, { seats: null }, user());

      expect(tx.lunchServing.update.mock.calls[0][0].data).toEqual({ seats: null });
    });

    it('leaves the stored seat count alone when the payload omits it', async () => {
      tx.lunchServing.findUnique.mockResolvedValue(storedServing({ seats: 90 }));
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
  });
});
