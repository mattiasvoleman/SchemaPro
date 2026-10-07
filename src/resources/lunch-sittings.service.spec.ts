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

/** What Prisma throws for a unique read that names no unique field. */
const noUniqueField = (): Error =>
  new Error('Prisma: findUnique needs a unique field in `where`.');

describe('LunchSittingsService', () => {
  let tx: TxMock;
  let prisma: PrismaMock;
  let service: LunchSittingsService;
  const user = testUser({ schoolId: SCHOOL_ID });

  /*
   * The reads are answered from the query the service actually sent, not
   * handed a row whatever it asked: the lunch settings only for the school
   * named, the class only for the id, year and kind named, the sitting only for
   * its own id. A read that loses its `where` finds nothing or fails, as it
   * would against the table, and a `select` with nothing truthy in it is
   * refused, as Prisma refuses one.
   */
  const givenSitting = (overrides: Record<string, unknown> = {}) => {
    const row = storedSitting(overrides);
    tx.lunchSitting.findUnique.mockImplementation(
      ({ where }: { where?: { id?: string } }) => {
        if (where?.id === undefined) throw noUniqueField();
        return Promise.resolve(where.id === row.id ? row : null);
      },
    );
  };

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new LunchSittingsService(prisma as unknown as PrismaService);
    tx.lunchSetting.findUnique.mockImplementation(
      ({ where }: { where?: { schoolId?: string } }) => {
        if (where?.schoolId === undefined) throw noUniqueField();
        return Promise.resolve(
          where.schoolId === SCHOOL_ID
            ? { schoolId: SCHOOL_ID, lunchEnabled: true, lunchMinutes: 30 }
            : null,
        );
      },
    );
    // The class check is asked of the year, with the class as a relation
    // filter, so the year's flags for the roster basis come in the same
    // statement (lunch-sittings.service.ts, assertIsAClassOf).
    tx.academicYear.findFirst.mockImplementation(
      ({
        where,
        select,
      }: {
        where: { id?: string; studentGroups?: { some?: { id?: string; kind?: string } } };
        select?: Record<string, boolean>;
      }) => {
        if (select && !Object.values(select).some(Boolean)) {
          throw new Error('Prisma: a `select` needs at least one truthy value.');
        }
        const some = where.studentGroups?.some;
        const isTheClass = where.id === YEAR_ID && some?.id === CLASS_ID && some?.kind === 'CLASS';
        return Promise.resolve(isTheClass ? { isActive: true, predecessorId: null } : null);
      },
    );
    tx.user.count.mockResolvedValue(24);
  });

  describe('placing a meal', () => {
    const place = (startTime = '13:00') =>
      service.place(
        { academicYearId: YEAR_ID, studentGroupId: CLASS_ID, dayOfWeek: 2, startTime },
        user,
      );

    it('refuses a second on the start, which would shorten the meal itself', async () => {
      /*
       * The worst of the off-grid cases, because here the seconds do not
       * survive the arithmetic. The body carries only a start — the length is
       * the school's one lunchMinutes — and `endOf` reads two fields, so
       * 13:00:30 produced an end of 13:30. The start keeps its seconds into the
       * column and the end does not: the row stored is 1770 seconds, a lunch
       * half a minute shorter than the thirty the school set, with no CHECK on
       * this table to notice. `LunchSittings_window_is_ordered` is satisfied —
       * 13:30 is after 13:00:30 — so nothing refused it.
       */
      await expect(place('13:00:30')).rejects.toThrow(/must be whole minutes/);

      expect(tx.lunchSitting.upsert).not.toHaveBeenCalled();
    });

    it('still takes the zero seconds PostgREST sends, so a row round-trips', async () => {
      // Why the DTO admits HH:MM:SS at all.
      tx.lunchSitting.upsert.mockResolvedValue(storedSitting());

      await place('13:00:00');

      expect(tx.lunchSitting.upsert).toHaveBeenCalled();
    });

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

    it('answers with the meal as the grid draws it', async () => {
      tx.lunchSitting.upsert.mockResolvedValue(storedSitting());

      await expect(place()).resolves.toEqual({
        id: SITTING_ID,
        studentGroupId: CLASS_ID,
        dayOfWeek: 2,
        startTime: '13:00',
        endTime: '13:30',
        headcount: 24,
        isGenerated: false,
      });
    });

    it('writes the end of an early sitting with its leading zero', async () => {
      // "9:30" is not a clock parseTimeString accepts, so an end written
      // without the zero would turn every sitting that ends before ten into a
      // 400 about a time the admin never typed.
      tx.lunchSitting.upsert.mockResolvedValue(
        storedSitting({ startTime: wallClock('09:00'), endTime: wallClock('09:30') }),
      );

      await expect(place('09:00')).resolves.toMatchObject({ endTime: '09:30' });
      expect(tx.lunchSitting.upsert.mock.calls[0][0].create.endTime).toEqual(
        wallClock('09:30'),
      );
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

      await expect(place()).rejects.toThrow(
        new BadRequestException(
          'Lunch is not switched on for this school, so there is no meal to place.',
        ),
      );
      expect(tx.lunchSitting.upsert).not.toHaveBeenCalled();
    });

    it('refuses a group that is not a class of the year', async () => {
      // A teaching group's pupils eat with their home class.
      tx.academicYear.findFirst.mockResolvedValue(null);

      await expect(place()).rejects.toThrow(
        new BadRequestException(
          'A meal can only be placed for a class of this academic year.',
        ),
      );
      expect(tx.academicYear.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: YEAR_ID, studentGroups: { some: { id: CLASS_ID, kind: 'CLASS' } } },
        }),
      );
    });

    it('refuses a meal that would run past midnight', async () => {
      await expect(place('23:45')).rejects.toThrow(
        new BadRequestException('The meal would run past midnight.'),
      );
    });

    it('refuses a meal that would end on the stroke of midnight', async () => {
      // "24:00" parses to the NEXT day's 00:00, so the end would be stored
      // half an hour before the start.
      await expect(place('23:30')).rejects.toThrow(
        new BadRequestException('The meal would run past midnight.'),
      );
      expect(tx.lunchSitting.upsert).not.toHaveBeenCalled();
    });
  });

  describe('moving a meal', () => {
    it('makes the solver’s meal the school’s where it was dropped', async () => {
      givenSitting({ isGenerated: true });
      tx.lunchSitting.update.mockResolvedValue(
        storedSitting({ startTime: wallClock('12:30'), endTime: wallClock('13:00') }),
      );

      await expect(
        service.move(SITTING_ID, { startTime: '12:30' }, user),
      ).resolves.toEqual({
        id: SITTING_ID,
        studentGroupId: CLASS_ID,
        dayOfWeek: 2,
        startTime: '12:30',
        endTime: '13:00',
        headcount: 24,
        isGenerated: false,
      });

      expect(tx.lunchSitting.update).toHaveBeenCalledWith({
        where: { id: SITTING_ID },
        data: {
          dayOfWeek: 2,
          startTime: wallClock('12:30'),
          endTime: wallClock('13:00'),
          isGenerated: false,
        },
      });
    });

    it('clears the meal already on a new day, and only on a new day', async () => {
      givenSitting();
      tx.lunchSitting.update.mockResolvedValue(storedSitting());

      await service.move(SITTING_ID, { startTime: '12:30' }, user);
      expect(tx.lunchSitting.deleteMany).not.toHaveBeenCalled();

      await service.move(SITTING_ID, { dayOfWeek: 3 }, user);
      expect(tx.lunchSitting.deleteMany).toHaveBeenCalledWith({
        where: { academicYearId: YEAR_ID, studentGroupId: CLASS_ID, dayOfWeek: 3 },
      });
    });

    it('is a 404 naming the meal that does not exist', async () => {
      tx.lunchSitting.findUnique.mockResolvedValue(null);

      await expect(service.move(SITTING_ID, { startTime: '12:30' }, user)).rejects.toThrow(
        new NotFoundException(`Lunch sitting ${SITTING_ID} not found.`),
      );
      expect(tx.lunchSitting.update).not.toHaveBeenCalled();
    });
  });

  describe('removing a meal', () => {
    it('removes one the school placed', async () => {
      givenSitting();

      await service.remove(SITTING_ID, user);

      expect(tx.lunchSitting.delete).toHaveBeenCalledWith({ where: { id: SITTING_ID } });
    });

    it('will not remove one the solver placed', async () => {
      // The next run replaces its own. Deleting it here would leave the day
      // with no meal until then — a band that vanishes for a reason the screen
      // cannot show.
      givenSitting({ isGenerated: true });

      await expect(service.remove(SITTING_ID, user)).rejects.toThrow(
        new BadRequestException(
          'Only a meal placed by hand can be removed; the solver replaces its own on the next run.',
        ),
      );
      expect(tx.lunchSitting.delete).not.toHaveBeenCalled();
    });

    it('is a 404 for a meal that is already gone, not a crash', async () => {
      tx.lunchSitting.findUnique.mockResolvedValue(null);

      await expect(service.remove(SITTING_ID, user)).rejects.toThrow(
        new NotFoundException(`Lunch sitting ${SITTING_ID} not found.`),
      );
      expect(tx.lunchSitting.delete).not.toHaveBeenCalled();
    });
  });
});
