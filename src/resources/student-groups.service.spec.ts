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
          // A group is a home class unless somebody says otherwise: mislabelling
          // one as a teaching group would stop it being its members' home class.
          kind: 'CLASS',
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

describe('StudentGroupsService — teaching-group members', () => {
  let service: StudentGroupsService;
  let tx: TxMock;
  let prisma: PrismaMock;

  const STUDENT_A = 'aaaaaaa1-0000-4000-8000-000000000001';
  const STUDENT_B = 'aaaaaaa2-0000-4000-8000-000000000002';

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new StudentGroupsService(prisma as unknown as PrismaService);
  });

  describe('setMembers', () => {
    const arrange = () => {
      tx.studentGroup.findUnique.mockResolvedValue({ id: GROUP_ID });
      tx.user.findMany.mockResolvedValue([{ id: STUDENT_A }, { id: STUDENT_B }]);
      tx.studentGroupMember.deleteMany.mockResolvedValue({ count: 0 });
      tx.studentGroupMember.createMany.mockResolvedValue({ count: 2 });
    };

    it('replaces the whole membership under the caller RLS session', async () => {
      arrange();

      const result = await service.setMembers(
        GROUP_ID,
        { studentIds: [STUDENT_A, STUDENT_B] },
        testUser(),
      );

      expect(result).toEqual({ count: 2 });
      expect(prisma.withRls).toHaveBeenCalledWith(
        expect.objectContaining({ userId: testUser().userId }),
        expect.any(Function),
      );
      // Replace semantics: wipe first, then insert exactly the new list with
      // the tenant taken from the principal — never from the payload.
      expect(tx.studentGroupMember.deleteMany).toHaveBeenCalledWith({
        where: { studentGroupId: GROUP_ID },
      });
      expect(tx.studentGroupMember.createMany).toHaveBeenCalledWith({
        data: [
          { schoolId: testUser().schoolId, studentGroupId: GROUP_ID, studentId: STUDENT_A },
          { schoolId: testUser().schoolId, studentGroupId: GROUP_ID, studentId: STUDENT_B },
        ],
      });
    });

    it('deduplicates repeated ids before writing', async () => {
      arrange();
      tx.user.findMany.mockResolvedValue([{ id: STUDENT_A }]);

      const result = await service.setMembers(
        GROUP_ID,
        { studentIds: [STUDENT_A, STUDENT_A] },
        testUser(),
      );

      expect(result).toEqual({ count: 1 });
      expect(tx.studentGroupMember.createMany).toHaveBeenCalledWith({
        data: [
          { schoolId: testUser().schoolId, studentGroupId: GROUP_ID, studentId: STUDENT_A },
        ],
      });
    });

    it('clears the membership when given an empty list, inserting nothing', async () => {
      arrange();

      const result = await service.setMembers(GROUP_ID, { studentIds: [] }, testUser());

      expect(result).toEqual({ count: 0 });
      expect(tx.studentGroupMember.deleteMany).toHaveBeenCalled();
      expect(tx.studentGroupMember.createMany).not.toHaveBeenCalled();
    });

    it('404s on an unknown group before touching memberships', async () => {
      arrange();
      tx.studentGroup.findUnique.mockResolvedValue(null);

      await expect(
        service.setMembers(GROUP_ID, { studentIds: [STUDENT_A] }, testUser()),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(tx.studentGroupMember.deleteMany).not.toHaveBeenCalled();
    });

    it('rejects ids that are not active students, naming the offenders, and writes nothing', async () => {
      arrange();
      // Only STUDENT_A passes the active-student filter.
      tx.user.findMany.mockResolvedValue([{ id: STUDENT_A }]);

      await expect(
        service.setMembers(
          GROUP_ID,
          { studentIds: [STUDENT_A, STUDENT_B] },
          testUser(),
        ),
      ).rejects.toMatchObject({
        constructor: BadRequestException,
        message: expect.stringContaining(STUDENT_B),
      });
      expect(tx.studentGroupMember.deleteMany).not.toHaveBeenCalled();
      expect(tx.studentGroupMember.createMany).not.toHaveBeenCalled();
    });
  });

  describe('listMembers', () => {
    it('returns members with their home group, via the caller RLS session', async () => {
      tx.studentGroupMember.findMany.mockResolvedValue([
        {
          student: {
            id: STUDENT_A,
            firstName: 'Alva',
            lastName: 'Berg',
            studentGroupId: '77777777-7777-4777-8777-777777777777',
          },
        },
      ]);

      const members = await service.listMembers(GROUP_ID, testUser());

      expect(members).toEqual([
        {
          id: STUDENT_A,
          firstName: 'Alva',
          lastName: 'Berg',
          homeGroupId: '77777777-7777-4777-8777-777777777777',
        },
      ]);
      expect(tx.studentGroupMember.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { studentGroupId: GROUP_ID } }),
      );
      expect(prisma.withRls).toHaveBeenCalled();
    });
  });
});
