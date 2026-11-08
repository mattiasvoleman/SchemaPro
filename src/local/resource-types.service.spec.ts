import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  createPrismaMock,
  createTxMock,
  testUser,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { ResourceTypesService } from './resource-types.service';

const TYPE_ID = '77777777-7777-4777-8777-777777777777';
const SCHOOL_ID = testUser().schoolId;

const prismaError = (code: string): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError(`Simulated ${code}`, {
    code,
    clientVersion: Prisma.prismaVersion.client,
  });

describe('ResourceTypesService', () => {
  let service: ResourceTypesService;
  let tx: TxMock;
  let prisma: PrismaMock;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new ResourceTypesService(prisma as unknown as PrismaService);
  });

  describe('list', () => {
    it('answers the kinds by name with how many resources each has', async () => {
      tx.resourceType.findMany.mockResolvedValue([
        { id: TYPE_ID, name: 'Minibuss', _count: { resources: 2 } },
        { id: 'b', name: 'Surfplattor', _count: { resources: 0 } },
      ]);

      await expect(service.list(testUser())).resolves.toEqual([
        { id: TYPE_ID, name: 'Minibuss', resources: 2 },
        { id: 'b', name: 'Surfplattor', resources: 0 },
      ]);
      expect(prisma.withRls).toHaveBeenCalledWith(expect.objectContaining({ userId: testUser().userId }), expect.any(Function));
      expect(tx.resourceType.findMany).toHaveBeenCalledWith({
        orderBy: { name: 'asc' },
        select: { id: true, name: true, _count: { select: { resources: true } } },
      });
    });
  });

  describe('create', () => {
    it('stamps the tenant from the principal, trims the name and answers a kind with no resources', async () => {
      tx.resourceType.create.mockResolvedValue({ id: TYPE_ID, name: 'Aulan' });

      await expect(service.create({ name: '  Aulan ' }, testUser())).resolves.toEqual({ id: TYPE_ID, name: 'Aulan', resources: 0 });

      expect(tx.resourceType.create).toHaveBeenCalledWith({
        data: { schoolId: SCHOOL_ID, name: 'Aulan' },
        select: { id: true, name: true },
      });
    });

    it('rejects a principal with no school before touching the database', async () => {
      await expect(service.create({ name: 'Aulan' }, { ...testUser(), schoolId: undefined })).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('maps a name the school already has (P2002) to 409', async () => {
      tx.resourceType.create.mockRejectedValue(prismaError('P2002'));

      await expect(service.create({ name: 'Aulan' }, testUser())).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('update', () => {
    it('renames a kind, trimmed, and answers it with its count', async () => {
      tx.resourceType.update.mockResolvedValue({ id: TYPE_ID, name: 'Minibussar', _count: { resources: 3 } });

      await expect(service.update(TYPE_ID, { name: ' Minibussar ' }, testUser())).resolves.toEqual({
        id: TYPE_ID,
        name: 'Minibussar',
        resources: 3,
      });

      expect(tx.resourceType.update).toHaveBeenCalledWith({
        where: { id: TYPE_ID },
        data: { name: 'Minibussar' },
        select: { id: true, name: true, _count: { select: { resources: true } } },
      });
    });

    it('changes nothing when the name is omitted', async () => {
      tx.resourceType.update.mockResolvedValue({ id: TYPE_ID, name: 'Minibuss', _count: { resources: 0 } });

      await service.update(TYPE_ID, {}, testUser());

      expect(tx.resourceType.update.mock.calls[0]![0].data).toEqual({});
    });

    it('maps an unknown or cross-tenant id (P2025) to 404 and a taken name (P2002) to 409', async () => {
      tx.resourceType.update.mockRejectedValueOnce(prismaError('P2025'));
      await expect(service.update(TYPE_ID, { name: 'X' }, testUser())).rejects.toBeInstanceOf(NotFoundException);

      tx.resourceType.update.mockRejectedValueOnce(prismaError('P2002'));
      await expect(service.update(TYPE_ID, { name: 'X' }, testUser())).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('remove', () => {
    it('deletes a kind no resource uses', async () => {
      tx.resourceType.findUnique.mockResolvedValue({ _count: { resources: 0 } });

      await expect(service.remove(TYPE_ID, testUser())).resolves.toBeUndefined();

      expect(tx.resourceType.findUnique).toHaveBeenCalledWith({
        where: { id: TYPE_ID },
        select: { _count: { select: { resources: true } } },
      });
      expect(tx.resourceType.delete).toHaveBeenCalledWith({ where: { id: TYPE_ID } });
    });

    it('refuses a kind that resources use, saying how many, and deletes nothing', async () => {
      tx.resourceType.findUnique.mockResolvedValue({ _count: { resources: 4 } });

      await expect(service.remove(TYPE_ID, testUser())).rejects.toThrow(
        new BadRequestException('Slaget används av 4 resurs(er) och kan inte tas bort. Byt slag på dem först.'),
      );
      expect(tx.resourceType.delete).not.toHaveBeenCalled();
    });

    it('is idempotent for an unknown id', async () => {
      tx.resourceType.findUnique.mockResolvedValue(null);

      await expect(service.remove(TYPE_ID, testUser())).resolves.toBeUndefined();
      expect(tx.resourceType.delete).not.toHaveBeenCalled();
    });

    it('maps a race on the delete itself (P2025) to 404', async () => {
      tx.resourceType.findUnique.mockResolvedValue({ _count: { resources: 0 } });
      tx.resourceType.delete.mockRejectedValue(prismaError('P2025'));

      await expect(service.remove(TYPE_ID, testUser())).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
