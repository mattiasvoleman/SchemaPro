import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  createPrismaMock,
  createTxMock,
  testUser,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { FrameTimesService } from './frame-times.service';

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

describe('FrameTimesService', () => {
  let tx: TxMock;
  let prisma: PrismaMock;
  let service: FrameTimesService;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new FrameTimesService(prisma as unknown as PrismaService);
  });

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
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.frameTime.create).not.toHaveBeenCalled();
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
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.frameTime.create).not.toHaveBeenCalled();
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
      tx.frameTime.findUnique.mockResolvedValue(storedFrame());

      await expect(service.update(FRAME_ID, { endTime: '07:00' }, user())).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(tx.frameTime.update).not.toHaveBeenCalled();
    });

    it('refuses a start moved past the end it never mentions', async () => {
      tx.frameTime.findUnique.mockResolvedValue(storedFrame());

      await expect(service.update(FRAME_ID, { startTime: '16:00' }, user())).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('refuses a min year pushed past the stored max', async () => {
      tx.frameTime.findUnique.mockResolvedValue(storedFrame());

      await expect(service.update(FRAME_ID, { minGradeLevel: 9 }, user())).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(tx.frameTime.update).not.toHaveBeenCalled();
    });

    it('refuses a max year pulled below the stored min', async () => {
      tx.frameTime.findUnique.mockResolvedValue(storedFrame());

      await expect(service.update(FRAME_ID, { maxGradeLevel: 1 }, user())).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('accepts a one-sided move that still leaves the row whole', async () => {
      tx.frameTime.findUnique.mockResolvedValue(storedFrame());
      tx.frameTime.update.mockResolvedValue(storedFrame({ endTime: wallClock('13:00') }));

      await expect(service.update(FRAME_ID, { endTime: '13:00' }, user())).resolves.toMatchObject({
        endTime: '13:00',
      });
      expect(tx.frameTime.update.mock.calls[0][0].data).toEqual({ endTime: wallClock('13:00') });
    });

    it('accepts both ends moved together past where either alone would fail', async () => {
      // 16:00-17:00 is entirely after the stored 08:00-15:00, so each end taken
      // on its own is invalid against the stored row and the pair is fine.
      tx.frameTime.findUnique.mockResolvedValue(storedFrame());
      tx.frameTime.update.mockResolvedValue(
        storedFrame({ startTime: wallClock('16:00'), endTime: wallClock('17:00') }),
      );

      await expect(
        service.update(FRAME_ID, { startTime: '16:00', endTime: '17:00' }, user()),
      ).resolves.toMatchObject({ startTime: '16:00', endTime: '17:00' });
    });

    it('sends only the fields the payload named', async () => {
      tx.frameTime.findUnique.mockResolvedValue(storedFrame());
      tx.frameTime.update.mockResolvedValue(storedFrame({ dayOfWeek: null }));

      await service.update(FRAME_ID, { dayOfWeek: null }, user());

      expect(tx.frameTime.update.mock.calls[0][0].data).toEqual({ dayOfWeek: null });
    });

    it('reports an unknown frame as missing rather than as a write failure', async () => {
      tx.frameTime.findUnique.mockResolvedValue(null);

      await expect(service.update(FRAME_ID, { endTime: '13:00' }, user())).rejects.toBeInstanceOf(
        NotFoundException,
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
  });
});
