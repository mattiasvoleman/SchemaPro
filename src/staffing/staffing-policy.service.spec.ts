import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  createPrismaMock,
  createTxMock,
  testUser,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { StaffingPolicyService } from './staffing-policy.service';

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';

describe('StaffingPolicyService', () => {
  let service: StaffingPolicyService;
  let tx: TxMock;
  let prisma: PrismaMock;

  const storedRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'pol-1',
    schoolId: SCHOOL_ID,
    fullTimeTeachingMinutesPerWeek: 1080,
    fullTimeRegulatedHoursPerYear: 1360,
    fullTimeAnnualHours: 1767,
    workDaysPerYear: 194,
    semesterHoursPerWeek: new Prisma.Decimal('40.0'),
    qualificationMode: 'WARN',
    overAllocationMode: 'WARN',
    overAllocationTolerancePercent: 10,
    loadModel: 'MINUTES',
    unstaffedGeneration: 'ALLOW',
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  });

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new StaffingPolicyService(prisma as unknown as PrismaService);
  });

  describe('get', () => {
    it('reads the school’s row under RLS and hands the Decimal back as a number', async () => {
      tx.staffingPolicy.findUnique.mockResolvedValue(storedRow());
      const user = testUser();

      const answer = await service.get(user);

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.staffingPolicy.findUnique).toHaveBeenCalledWith({
        where: { schoolId: SCHOOL_ID },
      });
      expect(answer).toMatchObject({ semesterHoursPerWeek: 40, fullTimeTeachingMinutesPerWeek: 1080 });
      // A Decimal stringifies as "40": the form would read a string.
      expect(typeof answer!.semesterHoursPerWeek).toBe('number');
    });

    it('answers null when nobody has decided anything yet', async () => {
      tx.staffingPolicy.findUnique.mockResolvedValue(null);
      await expect(service.get(testUser())).resolves.toBeNull();
    });

    it('refuses a principal carrying no school', async () => {
      await expect(service.get(testUser({ schoolId: undefined }))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('upsert', () => {
    it('fills every omitted field with the table’s default, so create and update write the same row', async () => {
      tx.staffingPolicy.upsert.mockResolvedValue(storedRow({ fullTimeTeachingMinutesPerWeek: null }));

      await service.upsert({}, testUser());

      const data = {
        fullTimeTeachingMinutesPerWeek: null,
        fullTimeRegulatedHoursPerYear: 1360,
        fullTimeAnnualHours: 1767,
        workDaysPerYear: 194,
        semesterHoursPerWeek: 40,
        qualificationMode: 'WARN',
        overAllocationMode: 'WARN',
        overAllocationTolerancePercent: 10,
        loadModel: 'MINUTES',
        unstaffedGeneration: 'ALLOW',
      };
      expect(tx.staffingPolicy.upsert).toHaveBeenCalledWith({
        where: { schoolId: SCHOOL_ID },
        create: { schoolId: SCHOOL_ID, ...data },
        update: data,
      });
    });

    it('writes what the form said, and reads the answer back as numbers', async () => {
      tx.staffingPolicy.upsert.mockResolvedValue(
        storedRow({ semesterHoursPerWeek: new Prisma.Decimal('37.5'), overAllocationMode: 'REFUSE' }),
      );

      const answer = await service.upsert(
        {
          fullTimeTeachingMinutesPerWeek: 1080,
          semesterHoursPerWeek: 37.5,
          overAllocationMode: 'REFUSE',
          overAllocationTolerancePercent: 5,
        },
        testUser(),
      );

      expect(tx.staffingPolicy.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            fullTimeTeachingMinutesPerWeek: 1080,
            semesterHoursPerWeek: 37.5,
            overAllocationMode: 'REFUSE',
            overAllocationTolerancePercent: 5,
          }),
        }),
      );
      expect(answer.semesterHoursPerWeek).toBe(37.5);
    });

    it('writes REFUSE for generation without teachers, and an omitted field back to ALLOW', async () => {
      tx.staffingPolicy.upsert.mockResolvedValue(storedRow({ unstaffedGeneration: 'REFUSE' }));

      const answer = await service.upsert({ unstaffedGeneration: 'REFUSE' }, testUser());
      expect(tx.staffingPolicy.upsert).toHaveBeenLastCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ unstaffedGeneration: 'REFUSE' }),
          update: expect.objectContaining({ unstaffedGeneration: 'REFUSE' }),
        }),
      );
      expect(answer.unstaffedGeneration).toBe('REFUSE');

      // PUT replaces the row: a body without the field is the default, so a
      // form that forgot it would switch the refusal off — which is why the
      // settings card always sends it.
      await service.upsert({ fullTimeTeachingMinutesPerWeek: 1080 }, testUser());
      expect(tx.staffingPolicy.upsert).toHaveBeenLastCalledWith(
        expect.objectContaining({ update: expect.objectContaining({ unstaffedGeneration: 'ALLOW' }) }),
      );
    });

    it('refuses a reglerad arbetstid larger than the year, naming both numbers', async () => {
      await expect(
        service.upsert({ fullTimeRegulatedHoursPerYear: 1800, fullTimeAnnualHours: 1767 }, testUser()),
      ).rejects.toThrow(/1800 h.*1767 h/);
      await expect(
        service.upsert({ fullTimeRegulatedHoursPerYear: 1800 }, testUser()),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.staffingPolicy.upsert).not.toHaveBeenCalled();
    });

    it('accepts a reglerad arbetstid equal to the year', async () => {
      tx.staffingPolicy.upsert.mockResolvedValue(storedRow());
      await expect(
        service.upsert({ fullTimeRegulatedHoursPerYear: 1767 }, testUser()),
      ).resolves.toBeDefined();
    });

    it('refuses a principal carrying no school before touching the table', async () => {
      await expect(service.upsert({}, testUser({ schoolId: undefined }))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(tx.staffingPolicy.upsert).not.toHaveBeenCalled();
    });
  });
});
