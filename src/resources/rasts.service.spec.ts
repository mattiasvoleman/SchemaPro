import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
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

describe('RastsService', () => {
  let tx: TxMock;
  let prisma: PrismaMock;
  let service: RastsService;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new RastsService(prisma as unknown as PrismaService);
  });

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
      ).rejects.toThrow(BadRequestException);
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
      ).rejects.toThrow(BadRequestException);
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
      tx.rast.findUnique.mockResolvedValue(storedRast());

      await expect(
        service.update(RAST_ID, { endTime: '09:20' }, testUser({ schoolId: SCHOOL_ID })),
      ).rejects.toThrow(BadRequestException);
      expect(tx.rast.update).not.toHaveBeenCalled();
    });

    it('writes only the fields the payload names', async () => {
      tx.rast.findUnique.mockResolvedValue(storedRast());
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
      tx.rast.findUnique.mockResolvedValue(null);

      await expect(
        service.update(RAST_ID, { name: 'X' }, testUser({ schoolId: SCHOOL_ID })),
      ).rejects.toThrow(NotFoundException);
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
      tx.rast.findUnique.mockResolvedValue(storedRast({ requiresLessonBefore: true }));
      tx.rast.update.mockResolvedValue(storedRast({ requiresLessonBefore: true }));

      await service.update(RAST_ID, { name: 'X' }, testUser({ schoolId: SCHOOL_ID }));

      expect(tx.rast.update).toHaveBeenCalledWith({
        where: { id: RAST_ID },
        data: { name: 'X' },
      });
    });

    it('can be switched off by a PATCH that names it false', async () => {
      tx.rast.findUnique.mockResolvedValue(storedRast({ requiresLessonBefore: true }));
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
  });

  describe('remove', () => {
    it('deletes through RLS, so another school cannot reach the row', async () => {
      tx.rast.delete.mockResolvedValue(storedRast());

      await service.remove(RAST_ID, testUser({ schoolId: SCHOOL_ID }));

      expect(prisma.withRls).toHaveBeenCalled();
      expect(tx.rast.delete).toHaveBeenCalledWith({ where: { id: RAST_ID } });
    });

    it('404s on a rast RLS hides, rather than a 500', async () => {
      // Another school's row is invisible under RLS, so the delete matches
      // nothing and Prisma answers P2025. To this caller that is exactly "not
      // there" — and anything more specific would confirm the row exists.
      tx.rast.delete.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Simulated P2025', {
          code: 'P2025',
          clientVersion: Prisma.prismaVersion.client,
        }),
      );

      await expect(
        service.remove(RAST_ID, testUser({ schoolId: SCHOOL_ID })),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses a caller with no school', async () => {
      await expect(
        service.remove(RAST_ID, testUser({ schoolId: null })),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(tx.rast.delete).not.toHaveBeenCalled();
    });
  });
});
