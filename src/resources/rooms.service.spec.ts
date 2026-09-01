import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma, RoomType } from '@prisma/client';
import {
  createPrismaMock,
  createTxMock,
  testUser,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { RoomsService } from './rooms.service';
import type { CreateRoomDto } from './dto/room.dto';

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const ROOM_ID = '55555555-5555-4555-8555-555555555555';
const ROOM_TYPE_ID = '88888888-8888-4888-8888-888888888888';

const prismaError = (code: string): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError(`Simulated ${code}`, {
    code,
    clientVersion: Prisma.prismaVersion.client,
  });

describe('RoomsService', () => {
  let service: RoomsService;
  let tx: TxMock;
  let prisma: PrismaMock;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new RoomsService(prisma as unknown as PrismaService);
  });

  const dto = (overrides: Partial<CreateRoomDto> = {}): CreateRoomDto => ({
    name: 'Sal 101',
    ...overrides,
  });

  describe('create', () => {
    it('creates a minimal room: tenant from the principal, optionals null, enum defaults untouched', async () => {
      const row = { id: ROOM_ID };
      tx.room.create.mockResolvedValue(row);
      const user = testUser();

      await expect(service.create(dto(), user)).resolves.toBe(row);

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      // Exact shape: no `type` / `requiresApproval` keys when the DTO omits
      // them, so the Prisma column defaults apply.
      expect(tx.room.create).toHaveBeenCalledWith({
        data: {
          schoolId: SCHOOL_ID,
          name: 'Sal 101',
          code: null,
          capacity: null,
          // No stage limit by default — every year may use the room.
          minGradeLevel: null,
          maxGradeLevel: null,
        },
      });
    });

    it('persists the chosen room type and approval requirement', async () => {
      tx.room.create.mockResolvedValue({ id: ROOM_ID });

      await service.create(
        dto({
          code: 'LAB1',
          capacity: 24,
          roomTypeId: ROOM_TYPE_ID,
          requiresApproval: true,
        }),
        testUser(),
      );

      expect(tx.room.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            code: 'LAB1',
            capacity: 24,
            roomTypeId: ROOM_TYPE_ID,
            requiresApproval: true,
          }),
        }),
      );
    });

    it('rejects a principal with no school', async () => {
      await expect(
        service.create(dto(), testUser({ schoolId: undefined })),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('maps a duplicate room (P2002) to 409', async () => {
      tx.room.create.mockRejectedValue(prismaError('P2002'));

      await expect(service.create(dto(), testUser())).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('update', () => {
    it('passes an explicit `requiresApproval: false` through (falsy but defined)', async () => {
      const row = { id: ROOM_ID, requiresApproval: false };
      tx.room.update.mockResolvedValue(row);
      const user = testUser();

      await expect(
        service.update(ROOM_ID, { requiresApproval: false }, user),
      ).resolves.toBe(row);

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.room.update).toHaveBeenCalledWith({
        where: { id: ROOM_ID },
        data: { requiresApproval: false },
      });
    });

    it('sends only the provided fields, null clearing the code', async () => {
      tx.room.update.mockResolvedValue({ id: ROOM_ID });

      await service.update(
        ROOM_ID,
        { name: 'Fysiksal', code: null },
        testUser(),
      );

      expect(tx.room.update).toHaveBeenCalledWith({
        where: { id: ROOM_ID },
        data: { name: 'Fysiksal', code: null },
      });
    });

    it('maps P2025 (unknown or cross-tenant id) to 404', async () => {
      tx.room.update.mockRejectedValue(prismaError('P2025'));

      await expect(
        service.update(ROOM_ID, { name: 'X' }, testUser()),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove', () => {
    it('deletes by id under the caller’s RLS context', async () => {
      tx.room.delete.mockResolvedValue({ id: ROOM_ID });
      const user = testUser();

      await expect(service.remove(ROOM_ID, user)).resolves.toBeUndefined();

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.room.delete).toHaveBeenCalledWith({ where: { id: ROOM_ID } });
    });

    it('refuses to delete the last room a lock names', async () => {
      /*
       * RoomPreferenceRooms cascades, so the rule would survive with an empty
       * room list — a lock that forbids every room and permits none. The school
       * would meet that as a week that stopped generating for no visible
       * reason, and there is nowhere to put a warning: this returns 204 and the
       * room list simply re-renders.
       */
      tx.roomPreference.findMany.mockResolvedValue([
        { subject: { name: 'Matematik' }, rooms: [{ roomId: ROOM_ID }] },
      ]);

      await expect(service.remove(ROOM_ID, testUser())).rejects.toThrow('Matematik');
      expect(tx.room.delete).not.toHaveBeenCalled();
    });

    it('asks only about locks, never about wishes', async () => {
      /*
       * A wish left with no rooms simply stops being paid — harmless. A lock
       * left with none forbids every room and permits none. Guarding both would
       * refuse an ordinary delete for a rule that costs nothing.
       *
       * Asserted on the QUERY, which is weaker than a behavioural test and is
       * the strongest thing available: the prisma mock returns what it is told
       * regardless of `where`, so no fixture can make it filter. What this
       * catches is the filter being dropped.
       */
      tx.roomPreference.findMany.mockResolvedValue([]);
      tx.room.delete.mockResolvedValue({ id: ROOM_ID });

      await service.remove(ROOM_ID, testUser());

      expect(tx.roomPreference.findMany.mock.calls[0][0].where).toMatchObject({
        kind: 'LOCK',
      });
    });

    it('allows the delete when the lock still has another room', async () => {
      // Two rooms named, one going away: the rule keeps meaning something.
      tx.roomPreference.findMany.mockResolvedValue([
        {
          subject: { name: 'Matematik' },
          rooms: [{ roomId: ROOM_ID }, { roomId: 'other' }],
        },
      ]);
      tx.room.delete.mockResolvedValue({ id: ROOM_ID });

      await expect(service.remove(ROOM_ID, testUser())).resolves.toBeUndefined();
      expect(tx.room.delete).toHaveBeenCalled();
    });

    it('maps P2025 (unknown or cross-tenant id) to 404', async () => {
      tx.room.delete.mockRejectedValue(prismaError('P2025'));

      await expect(service.remove(ROOM_ID, testUser())).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('year range', () => {
    it('stores a stage limit', async () => {
      tx.room.create.mockResolvedValue({ id: ROOM_ID });

      await service.create(
        { name: 'B12', minGradeLevel: 4, maxGradeLevel: 6 },
        testUser(),
      );

      expect(tx.room.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ minGradeLevel: 4, maxGradeLevel: 6 }),
      });
    });

    it('allows a one-year room', async () => {
      tx.room.create.mockResolvedValue({ id: ROOM_ID });

      await service.create(
        { name: 'Förskoleklassrum', minGradeLevel: 0, maxGradeLevel: 0 },
        testUser(),
      );

      const { data } = tx.room.create.mock.calls[0][0] as {
        data: { minGradeLevel: number; maxGradeLevel: number };
      };
      // Year 0 is förskoleklass, a real year — it must survive a falsy check.
      expect(data).toMatchObject({ minGradeLevel: 0, maxGradeLevel: 0 });
    });

    it('refuses an inverted range instead of storing an unusable room', async () => {
      await expect(
        service.create({ name: 'B12', minGradeLevel: 7, maxGradeLevel: 4 }, testUser()),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('refuses an inverted range on update too', async () => {
      await expect(
        service.update(ROOM_ID, { minGradeLevel: 9, maxGradeLevel: 1 }, testUser()),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('clears a limit with an explicit null', async () => {
      tx.room.update.mockResolvedValue({ id: ROOM_ID });

      await service.update(ROOM_ID, { minGradeLevel: null, maxGradeLevel: null }, testUser());

      expect(tx.room.update).toHaveBeenCalledWith({
        where: { id: ROOM_ID },
        data: { minGradeLevel: null, maxGradeLevel: null },
      });
    });

    it('leaves an untouched limit alone on a partial update', async () => {
      tx.room.update.mockResolvedValue({ id: ROOM_ID });

      await service.update(ROOM_ID, { name: 'B13' }, testUser());

      expect(tx.room.update).toHaveBeenCalledWith({
        where: { id: ROOM_ID },
        data: { name: 'B13' },
      });
    });
  });

});
