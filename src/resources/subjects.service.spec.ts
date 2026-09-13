import {
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
import { SubjectsService } from './subjects.service';

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const SUBJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ROOM_TYPE_ID = '88888888-8888-4888-8888-888888888888';

const prismaError = (code: string): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError(`Simulated ${code}`, {
    code,
    clientVersion: Prisma.prismaVersion.client,
  });

describe('SubjectsService', () => {
  let service: SubjectsService;
  let tx: TxMock;
  let prisma: PrismaMock;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new SubjectsService(prisma as unknown as PrismaService);
  });

  describe('create', () => {
    it('stamps the tenant from the principal and answers with the stored row', async () => {
      const row = { id: SUBJECT_ID, name: 'Matematik' };
      tx.subject.create.mockResolvedValue(row);
      const user = testUser();

      await expect(service.create({ name: 'Matematik' }, user)).resolves.toBe(row);

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.subject.create).toHaveBeenCalledWith({
        data: {
          schoolId: SCHOOL_ID,
          name: 'Matematik',
          code: null,
          color: null,
          requiredRoomTypeId: null,
        },
      });
    });

    it('keeps the code, the colour and the room type it was given', async () => {
      /*
       * `requiredRoomTypeId` is the one room rule the optimiser applies to a
       * subject school-wide. Dropped on the way in, kemi is stored without it
       * and lands in any classroom on the next run, with nothing on the
       * subject page to say why.
       */
      tx.subject.create.mockResolvedValue({ id: SUBJECT_ID });

      await service.create(
        {
          name: 'Kemi',
          code: 'KE',
          color: '#aa3300',
          requiredRoomTypeId: ROOM_TYPE_ID,
        },
        testUser(),
      );

      expect(tx.subject.create).toHaveBeenCalledWith({
        data: {
          schoolId: SCHOOL_ID,
          name: 'Kemi',
          code: 'KE',
          color: '#aa3300',
          requiredRoomTypeId: ROOM_TYPE_ID,
        },
      });
    });

    it('rejects a principal with no school before opening a transaction', async () => {
      await expect(
        service.create({ name: 'Matematik' }, testUser({ schoolId: undefined })),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('maps a duplicate subject (P2002) to 409', async () => {
      tx.subject.create.mockRejectedValue(prismaError('P2002'));

      await expect(
        service.create({ name: 'Matematik' }, testUser()),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('update', () => {
    it('writes by id under the caller’s RLS context and answers with the row', async () => {
      const row = { id: SUBJECT_ID, name: 'Fysik' };
      tx.subject.update.mockResolvedValue(row);
      const user = testUser();

      await expect(
        service.update(SUBJECT_ID, { name: 'Fysik' }, user),
      ).resolves.toBe(row);

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.subject.update).toHaveBeenCalledWith({
        where: { id: SUBJECT_ID },
        data: { name: 'Fysik' },
      });
    });

    // Each field on its own, because each is its own way to lose an edit: a
    // PATCH whose one field is dropped saves nothing and still answers 200.
    it.each([
      ['name', { name: 'Fysik' }],
      ['code', { code: 'FY' }],
      ['color', { color: '#0055ff' }],
      ['requiredRoomTypeId', { requiredRoomTypeId: ROOM_TYPE_ID }],
    ])('a PATCH naming only %s writes it', async (_field, patch) => {
      tx.subject.update.mockResolvedValue({ id: SUBJECT_ID });

      await service.update(SUBJECT_ID, patch, testUser());

      expect(tx.subject.update).toHaveBeenCalledWith({
        where: { id: SUBJECT_ID },
        data: patch,
      });
    });

    it('clears the optionals with an explicit null, which is not the same as leaving them out', async () => {
      tx.subject.update.mockResolvedValue({ id: SUBJECT_ID });

      await service.update(
        SUBJECT_ID,
        { code: null, color: null, requiredRoomTypeId: null },
        testUser(),
      );

      expect(tx.subject.update).toHaveBeenCalledWith({
        where: { id: SUBJECT_ID },
        data: { code: null, color: null, requiredRoomTypeId: null },
      });
    });

    it('maps P2025 (unknown or cross-tenant id) to 404', async () => {
      tx.subject.update.mockRejectedValue(prismaError('P2025'));

      await expect(
        service.update(SUBJECT_ID, { name: 'Fysik' }, testUser()),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove', () => {
    it('deletes by id under the caller’s RLS context', async () => {
      tx.subject.delete.mockResolvedValue({ id: SUBJECT_ID });
      const user = testUser();

      await expect(service.remove(SUBJECT_ID, user)).resolves.toBeUndefined();

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.subject.delete).toHaveBeenCalledWith({
        where: { id: SUBJECT_ID },
      });
    });

    it('maps P2025 (unknown or cross-tenant id) to 404', async () => {
      tx.subject.delete.mockRejectedValue(prismaError('P2025'));

      await expect(service.remove(SUBJECT_ID, testUser())).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
