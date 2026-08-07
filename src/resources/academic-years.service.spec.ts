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
import { AcademicYearsService } from './academic-years.service';
import type {
  CreateAcademicYearDto,
  UpdateAcademicYearDto,
} from './dto/academic-year.dto';

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const YEAR_ID = '99999999-9999-4999-8999-999999999999';

const prismaError = (code: string): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError(`Simulated ${code}`, {
    code,
    clientVersion: Prisma.prismaVersion.client,
  });

describe('AcademicYearsService', () => {
  let service: AcademicYearsService;
  let tx: TxMock;
  let prisma: PrismaMock;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new AcademicYearsService(prisma as unknown as PrismaService);
  });

  const dto = (
    overrides: Partial<CreateAcademicYearDto> = {},
  ): CreateAcademicYearDto => ({
    name: '2026/2027',
    startDate: '2026-08-17',
    endDate: '2027-06-12',
    ...overrides,
  });

  describe('create', () => {
    it('creates an inactive year by default, tenant taken from the principal', async () => {
      const row = { id: YEAR_ID };
      tx.academicYear.create.mockResolvedValue(row);
      const user = testUser();

      await expect(service.create(dto(), user)).resolves.toBe(row);

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.academicYear.create).toHaveBeenCalledWith({
        data: {
          schoolId: SCHOOL_ID,
          name: '2026/2027',
          startDate: new Date('2026-08-17T00:00:00.000Z'),
          endDate: new Date('2027-06-12T00:00:00.000Z'),
          isActive: false,
        },
      });
      // No other year loses its active flag for an inactive create.
      expect(tx.academicYear.updateMany).not.toHaveBeenCalled();
    });

    it('deactivates the school’s current active year before creating an active one', async () => {
      tx.academicYear.updateMany.mockResolvedValue({ count: 1 });
      tx.academicYear.create.mockResolvedValue({ id: YEAR_ID });

      await service.create(dto({ isActive: true }), testUser());

      expect(tx.academicYear.updateMany).toHaveBeenCalledWith({
        where: { schoolId: SCHOOL_ID, isActive: true },
        data: { isActive: false },
      });
      expect(tx.academicYear.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ isActive: true }),
        }),
      );
      // The hand-over happens inside one transaction, deactivate first.
      const deactivatedAt =
        tx.academicYear.updateMany.mock.invocationCallOrder[0];
      const createdAt = tx.academicYear.create.mock.invocationCallOrder[0];
      expect(deactivatedAt).toBeLessThan(createdAt);
    });

    it('rejects startDate after endDate', async () => {
      await expect(
        service.create(
          dto({ startDate: '2027-06-12', endDate: '2026-08-17' }),
          testUser(),
        ),
      ).rejects.toThrow('startDate must be before endDate.');
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('rejects a zero-length year', async () => {
      await expect(
        service.create(
          dto({ startDate: '2026-08-17', endDate: '2026-08-17' }),
          testUser(),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a principal with no school', async () => {
      await expect(
        service.create(dto(), testUser({ schoolId: undefined })),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('maps a duplicate year (P2002) to 409', async () => {
      tx.academicYear.create.mockRejectedValue(prismaError('P2002'));

      await expect(service.create(dto(), testUser())).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('update', () => {
    it('excludes the year itself when stealing the active flag', async () => {
      tx.academicYear.updateMany.mockResolvedValue({ count: 1 });
      tx.academicYear.update.mockResolvedValue({ id: YEAR_ID });
      const payload: UpdateAcademicYearDto = { isActive: true };

      await service.update(YEAR_ID, payload, testUser());

      expect(tx.academicYear.updateMany).toHaveBeenCalledWith({
        where: { schoolId: SCHOOL_ID, isActive: true, id: { not: YEAR_ID } },
        data: { isActive: false },
      });
      expect(tx.academicYear.update).toHaveBeenCalledWith({
        where: { id: YEAR_ID },
        data: { isActive: true },
      });
    });

    it('deactivating a year does not touch its siblings', async () => {
      tx.academicYear.update.mockResolvedValue({ id: YEAR_ID });

      await service.update(YEAR_ID, { isActive: false }, testUser());

      expect(tx.academicYear.updateMany).not.toHaveBeenCalled();
      expect(tx.academicYear.update).toHaveBeenCalledWith({
        where: { id: YEAR_ID },
        data: { isActive: false },
      });
    });

    it('sends only the provided fields, dates parsed', async () => {
      tx.academicYear.update.mockResolvedValue({ id: YEAR_ID });

      await service.update(
        YEAR_ID,
        { name: 'Läsår 26/27', startDate: '2026-08-18' },
        testUser(),
      );

      expect(tx.academicYear.update).toHaveBeenCalledWith({
        where: { id: YEAR_ID },
        data: {
          name: 'Läsår 26/27',
          startDate: new Date('2026-08-18T00:00:00.000Z'),
        },
      });
    });

    it('requires a school even for a name-only change', async () => {
      await expect(
        service.update(YEAR_ID, { name: 'X' }, testUser({ schoolId: undefined })),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('maps P2025 (unknown or cross-tenant id) to 404', async () => {
      tx.academicYear.update.mockRejectedValue(prismaError('P2025'));

      await expect(
        service.update(YEAR_ID, { name: 'X' }, testUser()),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove', () => {
    it('deletes by id under the caller’s RLS context', async () => {
      tx.academicYear.delete.mockResolvedValue({ id: YEAR_ID });
      const user = testUser();

      await expect(service.remove(YEAR_ID, user)).resolves.toBeUndefined();

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.academicYear.delete).toHaveBeenCalledWith({
        where: { id: YEAR_ID },
      });
    });

    it('maps P2025 (unknown or cross-tenant id) to 404', async () => {
      tx.academicYear.delete.mockRejectedValue(prismaError('P2025'));

      await expect(service.remove(YEAR_ID, testUser())).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
