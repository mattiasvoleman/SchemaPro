import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  createPrismaMock,
  createTxMock,
  testUser,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { RoomTypesService } from './room-types.service';

const TYPE_ID = '77777777-7777-4777-8777-777777777777';

const schoolless = () => ({ ...testUser(), schoolId: undefined });

describe('RoomTypesService', () => {
  let service: RoomTypesService;
  let tx: TxMock;
  let prisma: PrismaMock;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new RoomTypesService(prisma as unknown as PrismaService);
  });

  describe('list', () => {
    it('runs under the caller and returns usage counts the delete guard needs', async () => {
      tx.roomType.findMany.mockResolvedValue([]);

      await service.list(testUser());

      expect(prisma.withRls).toHaveBeenCalledWith(
        expect.objectContaining({ userId: testUser().userId }),
        expect.any(Function),
      );
      expect(tx.roomType.findMany).toHaveBeenCalledWith({
        orderBy: { name: 'asc' },
        include: { _count: { select: { rooms: true, subjects: true } } },
      });
    });
  });

  describe('create', () => {
    it('stamps the tenant from the principal and trims the name', async () => {
      tx.roomType.create.mockResolvedValue({ id: TYPE_ID });

      await service.create({ name: '  Hemkunskapssal ' }, testUser());

      expect(tx.roomType.create).toHaveBeenCalledWith({
        data: { schoolId: testUser().schoolId, name: 'Hemkunskapssal' },
      });
    });

    it('rejects a school-less principal before touching the database', async () => {
      await expect(
        service.create({ name: 'Textilslöjd' }, schoolless()),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.withRls).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('renames without clearing anything when the name is omitted', async () => {
      tx.roomType.update.mockResolvedValue({ id: TYPE_ID });

      await service.update(TYPE_ID, {}, testUser());

      expect(tx.roomType.update).toHaveBeenCalledWith({
        where: { id: TYPE_ID },
        data: {},
      });
    });

    it('trims a renamed type', async () => {
      tx.roomType.update.mockResolvedValue({ id: TYPE_ID });

      await service.update(TYPE_ID, { name: ' Trä- och metallslöjd ' }, testUser());

      expect(tx.roomType.update).toHaveBeenCalledWith({
        where: { id: TYPE_ID },
        data: { name: 'Trä- och metallslöjd' },
      });
    });
  });

  describe('remove', () => {
    it('deletes a type nothing references', async () => {
      tx.roomType.findUnique.mockResolvedValue({
        id: TYPE_ID,
        _count: { rooms: 0, subjects: 0 },
      });

      await expect(service.remove(TYPE_ID, testUser())).resolves.toEqual({
        id: TYPE_ID,
      });
      expect(tx.roomType.delete).toHaveBeenCalledWith({ where: { id: TYPE_ID } });
    });

    it('refuses when rooms still use it, naming the count', async () => {
      tx.roomType.findUnique.mockResolvedValue({
        id: TYPE_ID,
        _count: { rooms: 3, subjects: 0 },
      });

      await expect(service.remove(TYPE_ID, testUser())).rejects.toThrow(
        /3 sal\(ar\)/,
      );
      expect(tx.roomType.delete).not.toHaveBeenCalled();
    });

    it('refuses when a subject requires it — the case that breaks scheduling', async () => {
      // A subject pointing at a deleted type would leave the requirement
      // unsatisfiable and surface as "No room satisfies capacity/type".
      tx.roomType.findUnique.mockResolvedValue({
        id: TYPE_ID,
        _count: { rooms: 0, subjects: 2 },
      });

      await expect(service.remove(TYPE_ID, testUser())).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(service.remove(TYPE_ID, testUser())).rejects.toThrow(
        /2 ämne\(n\)/,
      );
    });

    it('names both when rooms and subjects reference it', async () => {
      tx.roomType.findUnique.mockResolvedValue({
        id: TYPE_ID,
        _count: { rooms: 1, subjects: 4 },
      });

      await expect(service.remove(TYPE_ID, testUser())).rejects.toThrow(
        /1 sal\(ar\) och 4 ämne\(n\)/,
      );
    });

    it('is idempotent for an unknown id', async () => {
      tx.roomType.findUnique.mockResolvedValue(null);

      await expect(service.remove(TYPE_ID, testUser())).resolves.toEqual({
        id: TYPE_ID,
      });
      expect(tx.roomType.delete).not.toHaveBeenCalled();
    });
  });
});
