import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  createPrismaMock,
  createTxMock,
  testUser,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { StudentGroupsService } from './student-groups.service';
import type { CreateStudentGroupDto } from './dto/student-group.dto';

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const YEAR_ID = '99999999-9999-4999-8999-999999999999';
const GROUP_ID = '66666666-6666-4666-8666-666666666666';

const prismaError = (code: string): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError(`Simulated ${code}`, {
    code,
    clientVersion: Prisma.prismaVersion.client,
  });

describe('StudentGroupsService', () => {
  let service: StudentGroupsService;
  let tx: TxMock;
  let prisma: PrismaMock;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new StudentGroupsService(prisma as unknown as PrismaService);
  });

  const dto = (
    overrides: Partial<CreateStudentGroupDto> = {},
  ): CreateStudentGroupDto => ({
    academicYearId: YEAR_ID,
    name: '7A',
    ...overrides,
  });

  describe('create', () => {
    it('creates the group with the tenant from the principal, gradeLevel defaulting to null', async () => {
      const row = { id: GROUP_ID };
      tx.studentGroup.create.mockResolvedValue(row);
      const user = testUser();

      await expect(service.create(dto(), user)).resolves.toBe(row);

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.studentGroup.create).toHaveBeenCalledWith({
        data: {
          schoolId: SCHOOL_ID,
          academicYearId: YEAR_ID,
          name: '7A',
          gradeLevel: null,
        },
      });
    });

    it('persists an explicit grade level', async () => {
      tx.studentGroup.create.mockResolvedValue({ id: GROUP_ID });

      await service.create(dto({ gradeLevel: 7 }), testUser());

      expect(tx.studentGroup.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ gradeLevel: 7 }),
        }),
      );
    });

    it('rejects a principal with no school', async () => {
      await expect(
        service.create(dto(), testUser({ schoolId: undefined })),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('maps a bad academicYearId (P2003, invisible under RLS) to 409', async () => {
      tx.studentGroup.create.mockRejectedValue(prismaError('P2003'));

      await expect(service.create(dto(), testUser())).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('update', () => {
    it('sends only the provided fields', async () => {
      const row = { id: GROUP_ID, name: '7B' };
      tx.studentGroup.update.mockResolvedValue(row);
      const user = testUser();

      await expect(
        service.update(GROUP_ID, { name: '7B' }, user),
      ).resolves.toBe(row);

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.studentGroup.update).toHaveBeenCalledWith({
        where: { id: GROUP_ID },
        data: { name: '7B' },
      });
    });

    it('clears the grade level with an explicit null', async () => {
      tx.studentGroup.update.mockResolvedValue({ id: GROUP_ID });

      await service.update(GROUP_ID, { gradeLevel: null }, testUser());

      expect(tx.studentGroup.update).toHaveBeenCalledWith({
        where: { id: GROUP_ID },
        data: { gradeLevel: null },
      });
    });

    it('maps P2025 (unknown or cross-tenant id) to 404', async () => {
      tx.studentGroup.update.mockRejectedValue(prismaError('P2025'));

      await expect(
        service.update(GROUP_ID, { name: 'X' }, testUser()),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove', () => {
    it('deletes by id under the caller’s RLS context', async () => {
      tx.studentGroup.delete.mockResolvedValue({ id: GROUP_ID });
      const user = testUser();

      await expect(service.remove(GROUP_ID, user)).resolves.toBeUndefined();

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.studentGroup.delete).toHaveBeenCalledWith({
        where: { id: GROUP_ID },
      });
    });

    it('maps P2025 (unknown or cross-tenant id) to 404', async () => {
      tx.studentGroup.delete.mockRejectedValue(prismaError('P2025'));

      await expect(service.remove(GROUP_ID, testUser())).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
