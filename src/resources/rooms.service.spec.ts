import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
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

    it('maps P2025 (unknown or cross-tenant id) to 404', async () => {
      tx.room.delete.mockRejectedValue(prismaError('P2025'));

      await expect(service.remove(ROOM_ID, testUser())).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
