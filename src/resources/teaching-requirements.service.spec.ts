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
import { TeachingRequirementsService } from './teaching-requirements.service';
import type { CreateTeachingRequirementDto } from './dto/teaching-requirement.dto';

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const YEAR_ID = '99999999-9999-4999-8999-999999999999';
const SUBJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GROUP_ID = '66666666-6666-4666-8666-666666666666';
const TEACHER_ID = '44444444-4444-4444-8444-444444444444';
const CO_TEACHER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REQUIREMENT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const prismaError = (code: string): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError(`Simulated ${code}`, {
    code,
    clientVersion: Prisma.prismaVersion.client,
  });

describe('TeachingRequirementsService', () => {
  let service: TeachingRequirementsService;
  let tx: TxMock;
  let prisma: PrismaMock;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new TeachingRequirementsService(prisma as unknown as PrismaService);
  });

  const dto = (
    overrides: Partial<CreateTeachingRequirementDto> = {},
  ): CreateTeachingRequirementDto => ({
    academicYearId: YEAR_ID,
    subjectId: SUBJECT_ID,
    studentGroupId: GROUP_ID,
    ...overrides,
  });

  describe('create', () => {
    it('creates an unassigned requirement with the documented defaults', async () => {
      const row = { id: REQUIREMENT_ID };
      tx.teachingRequirement.create.mockResolvedValue(row);
      const user = testUser();

      await expect(service.create(dto(), user)).resolves.toBe(row);

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.teachingRequirement.create).toHaveBeenCalledWith({
        data: {
          schoolId: SCHOOL_ID,
          academicYearId: YEAR_ID,
          subjectId: SUBJECT_ID,
          studentGroupId: GROUP_ID,
          teacherId: null,
          coTeacherId: null,
          lessonsPerWeek: 1,
          minutesPerLesson: 60,
        },
      });
    });

    it('persists explicit teachers and load figures', async () => {
      tx.teachingRequirement.create.mockResolvedValue({ id: REQUIREMENT_ID });

      await service.create(
        dto({
          teacherId: TEACHER_ID,
          coTeacherId: CO_TEACHER_ID,
          lessonsPerWeek: 3,
          minutesPerLesson: 45,
        }),
        testUser(),
      );

      expect(tx.teachingRequirement.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            teacherId: TEACHER_ID,
            coTeacherId: CO_TEACHER_ID,
            lessonsPerWeek: 3,
            minutesPerLesson: 45,
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

    it('maps a bad reference (P2003, invisible under RLS) to 409', async () => {
      tx.teachingRequirement.create.mockRejectedValue(prismaError('P2003'));

      await expect(service.create(dto(), testUser())).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('update', () => {
    it('unassigns the teacher with an explicit null and nothing else', async () => {
      const row = { id: REQUIREMENT_ID, teacherId: null };
      tx.teachingRequirement.update.mockResolvedValue(row);
      const user = testUser();

      await expect(
        service.update(REQUIREMENT_ID, { teacherId: null }, user),
      ).resolves.toBe(row);

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.teachingRequirement.update).toHaveBeenCalledWith({
        where: { id: REQUIREMENT_ID },
        data: { teacherId: null },
      });
    });

    it('sends only the provided load figures', async () => {
      tx.teachingRequirement.update.mockResolvedValue({ id: REQUIREMENT_ID });

      await service.update(
        REQUIREMENT_ID,
        { lessonsPerWeek: 2, minutesPerLesson: 90 },
        testUser(),
      );

      expect(tx.teachingRequirement.update).toHaveBeenCalledWith({
        where: { id: REQUIREMENT_ID },
        data: { lessonsPerWeek: 2, minutesPerLesson: 90 },
      });
    });

    it('maps P2025 (unknown or cross-tenant id) to 404', async () => {
      tx.teachingRequirement.update.mockRejectedValue(prismaError('P2025'));

      await expect(
        service.update(REQUIREMENT_ID, { lessonsPerWeek: 2 }, testUser()),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove', () => {
    it('deletes by id under the caller’s RLS context', async () => {
      tx.teachingRequirement.delete.mockResolvedValue({ id: REQUIREMENT_ID });
      const user = testUser();

      await expect(
        service.remove(REQUIREMENT_ID, user),
      ).resolves.toBeUndefined();

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.teachingRequirement.delete).toHaveBeenCalledWith({
        where: { id: REQUIREMENT_ID },
      });
    });

    it('maps P2025 (unknown or cross-tenant id) to 404', async () => {
      tx.teachingRequirement.delete.mockRejectedValue(prismaError('P2025'));

      await expect(
        service.remove(REQUIREMENT_ID, testUser()),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
