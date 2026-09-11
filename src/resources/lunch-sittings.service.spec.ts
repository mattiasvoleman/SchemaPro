import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  createPrismaMock,
  createTxMock,
  testUser,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { LunchSittingsService } from './lunch-sittings.service';

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const YEAR_ID = '44444444-4444-4444-8444-444444444444';
const CLASS_ID = '55555555-5555-4555-8555-555555555555';
const SITTING_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

/** A `@db.Time` value as Prisma hands it back: a Date anchored at 1970-01-01. */
const wallClock = (time: string): Date => new Date(`1970-01-01T${time}:00.000Z`);

const storedSitting = (overrides: Record<string, unknown> = {}) => ({
  id: SITTING_ID,
  schoolId: SCHOOL_ID,
  academicYearId: YEAR_ID,
  studentGroupId: CLASS_ID,
  dayOfWeek: 2,
  startTime: wallClock('13:00'),
  endTime: wallClock('13:30'),
  headcount: 24,
  isGenerated: false,
  createdAt: new Date('2026-09-11T09:00:00.000Z'),
  updatedAt: new Date('2026-09-11T09:00:00.000Z'),
  ...overrides,
});

describe('LunchSittingsService', () => {
  let tx: TxMock;
  let prisma: PrismaMock;
  let service: LunchSittingsService;
  const user = testUser({ schoolId: SCHOOL_ID });

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new LunchSittingsService(prisma as unknown as PrismaService);
    tx.lunchSetting.findUnique.mockResolvedValue({ lunchEnabled: true, lunchMinutes: 30 });
    tx.studentGroup.findFirst.mockResolvedValue({ id: CLASS_ID });
    tx.user.count.mockResolvedValue(24);
  });

  describe('placing a meal', () => {
    const place = (startTime = '13:00') =>
      service.place(
        { academicYearId: YEAR_ID, studentGroupId: CLASS_ID, dayOfWeek: 2, startTime },
        user,
      );

    it('marks it as the school’s, so the next run keeps it', async () => {
      tx.lunchSitting.upsert.mockResolvedValue(storedSitting());

      await place();

      const { create, update } = tx.lunchSitting.upsert.mock.calls[0][0];
      expect(create.isGenerated).toBe(false);
      expect(update.isGenerated).toBe(false);
    });

    it('takes its length from the school’s lunchMinutes, not from the body', async () => {
      // The body carries no end at all. A meal whose end the page chose would
      // be a second answer to "how long is lunch", and would disagree with
      // the setting the moment it changed.
      tx.lunchSitting.upsert.mockResolvedValue(storedSitting());

      await place('13:00');

      const { create } = tx.lunchSitting.upsert.mock.calls[0][0];
      expect(create.endTime).toEqual(wallClock('13:30'));
    });

    it('replaces whatever the class already had that day', async () => {
      // One meal a day per class — the table's unique key — so a meal placed on
      // a day the solver already fed takes that row over rather than failing.
      tx.lunchSitting.upsert.mockResolvedValue(storedSitting());

      await place();

      expect(tx.lunchSitting.upsert.mock.calls[0][0].where).toEqual({
        academicYearId_studentGroupId_dayOfWeek: {
          academicYearId: YEAR_ID,
          studentGroupId: CLASS_ID,
          dayOfWeek: 2,
        },
      });
    });

    it('seats the class the way a run counts it', async () => {
      // Active pupils whose HOME class this is. A second rule here would put a
      // different number on the kitchen's list for a meal placed by hand.
      tx.lunchSitting.upsert.mockResolvedValue(storedSitting());

      await place();

      expect(tx.user.count).toHaveBeenCalledWith({
        where: { role: 'STUDENT', isActive: true, studentGroupId: CLASS_ID },
      });
      expect(tx.lunchSitting.upsert.mock.calls[0][0].create.headcount).toBe(24);
    });

    it.each([
      ['no lunch settings at all', null],
      ['lunch switched off', { lunchEnabled: false, lunchMinutes: 30 }],
    ])('refuses when there is %s', async (_why, settings) => {
      // The engine builds no lunch variable, so a meal placed here would be a
      // pin with nothing to pin — and the lessons would be laid straight
      // across it.
      tx.lunchSetting.findUnique.mockResolvedValue(settings);

      await expect(place()).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.lunchSitting.upsert).not.toHaveBeenCalled();
    });

    it('refuses a group that is not a class of the year', async () => {
      // A teaching group's pupils eat with their home class.
      tx.studentGroup.findFirst.mockResolvedValue(null);

      await expect(place()).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.studentGroup.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: CLASS_ID, academicYearId: YEAR_ID, kind: 'CLASS' } }),
      );
    });

    it('refuses a meal that would run past midnight', async () => {
      await expect(place('23:45')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('moving a meal', () => {
    it('makes the solver’s meal the school’s where it was dropped', async () => {
      tx.lunchSitting.findUnique.mockResolvedValue(storedSitting({ isGenerated: true }));
      tx.lunchSitting.update.mockResolvedValue(storedSitting());

      await service.move(SITTING_ID, { startTime: '12:30' }, user);

      const { data } = tx.lunchSitting.update.mock.calls[0][0];
      expect(data.isGenerated).toBe(false);
      expect(data.startTime).toEqual(wallClock('12:30'));
      expect(data.endTime).toEqual(wallClock('13:00'));
    });

    it('clears the meal already on a new day, and only on a new day', async () => {
      tx.lunchSitting.findUnique.mockResolvedValue(storedSitting());
      tx.lunchSitting.update.mockResolvedValue(storedSitting());

      await service.move(SITTING_ID, { startTime: '12:30' }, user);
      expect(tx.lunchSitting.deleteMany).not.toHaveBeenCalled();

      await service.move(SITTING_ID, { dayOfWeek: 3 }, user);
      expect(tx.lunchSitting.deleteMany).toHaveBeenCalledWith({
        where: { academicYearId: YEAR_ID, studentGroupId: CLASS_ID, dayOfWeek: 3 },
      });
    });

    it('is a 404 for a meal that does not exist', async () => {
      tx.lunchSitting.findUnique.mockResolvedValue(null);

      await expect(service.move(SITTING_ID, { startTime: '12:30' }, user)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('removing a meal', () => {
    it('removes one the school placed', async () => {
      tx.lunchSitting.findUnique.mockResolvedValue(storedSitting());

      await service.remove(SITTING_ID, user);

      expect(tx.lunchSitting.delete).toHaveBeenCalledWith({ where: { id: SITTING_ID } });
    });

    it('will not remove one the solver placed', async () => {
      // The next run replaces its own. Deleting it here would leave the day
      // with no meal until then — a band that vanishes for a reason the screen
      // cannot show.
      tx.lunchSitting.findUnique.mockResolvedValue(storedSitting({ isGenerated: true }));

      await expect(service.remove(SITTING_ID, user)).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.lunchSitting.delete).not.toHaveBeenCalled();
    });
  });
});
