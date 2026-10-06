import {
  BadRequestException,
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
import {
  lockingRead,
  rawSql,
  transactionsOf,
  type LockedTable,
} from '../../test/utils/locking-read';
import type { PrismaService } from '../database/prisma.service';
import { Role } from '../auth/enums/role.enum';
import { TeacherEmploymentsService } from './teacher-employments.service';

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
/** The acting teacher's own `Users.id`, as `testUser()` hands it out. */
const ME = '22222222-2222-4222-8222-222222222222';
const COLLEAGUE = '44444444-4444-4444-8444-444444444444';
const YEAR_ID = '99999999-9999-4999-8999-999999999999';

const USERS: LockedTable = {
  name: 'Users',
  columns: [
    'id', 'schoolId', 'authId', 'role', 'firstName', 'lastName', 'email',
    'phone', 'isActive', 'invitedAt', 'createdAt', 'updatedAt', 'studentGroupId',
  ],
  lock: 'FOR NO KEY UPDATE',
};

const KEY = { schoolId_userId_academicYearId: { schoolId: SCHOOL_ID, userId: COLLEAGUE, academicYearId: YEAR_ID } };

const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: Prisma.prismaVersion.client,
  });

describe('TeacherEmploymentsService', () => {
  let service: TeacherEmploymentsService;
  let tx: TxMock;
  let prisma: PrismaMock;
  /** The Users rows the locking read can find. */
  let users: Record<string, unknown>[];
  let queryRaw: jest.Mock;

  const storedRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'emp-1',
    schoolId: SCHOOL_ID,
    userId: COLLEAGUE,
    academicYearId: YEAR_ID,
    employmentPercent: new Prisma.Decimal('80.000'),
    reductionPercent: new Prisma.Decimal('0.000'),
    contractKind: 'FERIE',
    teachingTargetMinutesPerWeek: null,
    signature: 'KOL',
    note: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  });

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new TeacherEmploymentsService(prisma as unknown as PrismaService);
    users = [{ id: COLLEAGUE, role: 'TEACHER' }];
    queryRaw = jest.fn((...call: unknown[]) =>
      Promise.resolve(lockingRead(USERS, users, call)),
    );
    Object.assign(tx, { $queryRaw: queryRaw });
  });

  describe('list', () => {
    it('hands an admin the whole year, ordered by teacher, as numbers', async () => {
      tx.teacherEmployment.findMany.mockResolvedValue([storedRow()]);
      const user = testUser();

      const answer = await service.list(YEAR_ID, user);

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.teacherEmployment.findMany).toHaveBeenCalledWith({
        where: { academicYearId: YEAR_ID },
        orderBy: { userId: 'asc' },
      });
      expect(answer[0]).toMatchObject({ employmentPercent: 80, reductionPercent: 0 });
      expect(typeof answer[0]!.employmentPercent).toBe('number');
    });

    it('narrows a teacher to their own row in the query, not only through RLS', async () => {
      tx.teacherEmployment.findMany.mockResolvedValue([]);

      await service.list(YEAR_ID, testUser({ role: Role.TEACHER }));

      expect(tx.teacherEmployment.findMany).toHaveBeenCalledWith({
        where: { academicYearId: YEAR_ID, userId: ME },
        orderBy: { userId: 'asc' },
      });
    });

    it('refuses a principal carrying no school', async () => {
      await expect(
        service.list(YEAR_ID, testUser({ schoolId: undefined })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('upsert', () => {
    it('writes the whole row keyed on teacher and year, defaults filled in', async () => {
      tx.teacherEmployment.upsert.mockResolvedValue(storedRow());

      const answer = await service.upsert(
        COLLEAGUE,
        YEAR_ID,
        { employmentPercent: 80, signature: ' KOL ' },
        testUser(),
      );

      const data = {
        employmentPercent: 80,
        reductionPercent: 0,
        contractKind: 'FERIE',
        teachingTargetMinutesPerWeek: null,
        signature: 'KOL',
        note: null,
      };
      expect(tx.teacherEmployment.upsert).toHaveBeenCalledWith({
        where: KEY,
        create: { schoolId: SCHOOL_ID, userId: COLLEAGUE, academicYearId: YEAR_ID, ...data },
        update: data,
      });
      expect(answer).toMatchObject({ userId: COLLEAGUE, employmentPercent: 80, signature: 'KOL' });
    });

    it('turns an empty signature and note into null, not into an empty string', async () => {
      tx.teacherEmployment.upsert.mockResolvedValue(storedRow({ signature: null }));

      await service.upsert(
        COLLEAGUE,
        YEAR_ID,
        { employmentPercent: 100, signature: '', note: '   ' },
        testUser(),
      );

      expect(tx.teacherEmployment.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: expect.objectContaining({ signature: null, note: null }) }),
      );
    });

    it('reads the teacher’s role under FOR NO KEY UPDATE in the transaction that writes', async () => {
      tx.teacherEmployment.upsert.mockResolvedValue(storedRow());
      const ranIn = transactionsOf(prisma);
      const readIn = ranIn(queryRaw);
      const writtenIn = ranIn(tx.teacherEmployment.upsert);

      await service.upsert(COLLEAGUE, YEAR_ID, { employmentPercent: 80 }, testUser());

      expect(readIn).toEqual([expect.stringMatching(/^withRls#\d+$/)]);
      expect(writtenIn).toEqual(readIn);
      const [call] = queryRaw.mock.calls;
      expect(rawSql(call)).toMatch(
        /SELECT "role"\s+FROM "Users"\s+WHERE "id" = \?::uuid\s+FOR NO KEY UPDATE/,
      );
      expect(call.slice(1)).toEqual([COLLEAGUE]);
      expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.teacherEmployment.upsert.mock.invocationCallOrder[0]!,
      );
    });

    it('404s a teacher RLS hides, without writing', async () => {
      users = [];

      await expect(
        service.upsert(COLLEAGUE, YEAR_ID, { employmentPercent: 80 }, testUser()),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(tx.teacherEmployment.upsert).not.toHaveBeenCalled();
    });

    it('refuses a post for a pupil or a guardian, and accepts a teaching rektor', async () => {
      users = [{ id: COLLEAGUE, role: 'STUDENT' }];
      await expect(
        service.upsert(COLLEAGUE, YEAR_ID, { employmentPercent: 80 }, testUser()),
      ).rejects.toThrow('undervisar inte');

      users = [{ id: COLLEAGUE, role: 'SCHOOL_ADMIN' }];
      tx.teacherEmployment.upsert.mockResolvedValue(storedRow());
      await expect(
        service.upsert(COLLEAGUE, YEAR_ID, { employmentPercent: 80 }, testUser()),
      ).resolves.toBeDefined();
    });

    it('refuses a nedsättning larger than the post, naming both, before opening a transaction', async () => {
      await expect(
        service.upsert(
          COLLEAGUE,
          YEAR_ID,
          { employmentPercent: 80, reductionPercent: 90 },
          testUser(),
        ),
      ).rejects.toThrow(/90 %.*80 %/);
      await expect(
        service.upsert(COLLEAGUE, YEAR_ID, { employmentPercent: 80, reductionPercent: 90 }, testUser()),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('accepts a nedsättning equal to the post', async () => {
      tx.teacherEmployment.upsert.mockResolvedValue(storedRow());
      await expect(
        service.upsert(COLLEAGUE, YEAR_ID, { employmentPercent: 80, reductionPercent: 80 }, testUser()),
      ).resolves.toBeDefined();
    });

    it('names the signature and the year on a unique violation, which can only be the signature index', async () => {
      tx.teacherEmployment.upsert.mockRejectedValue(p2002());

      const refusal = service.upsert(
        COLLEAGUE,
        YEAR_ID,
        { employmentPercent: 80, signature: 'ABC' },
        testUser(),
      );
      await expect(refusal).rejects.toBeInstanceOf(ConflictException);
      await expect(refusal).rejects.toThrow(`Signaturen "ABC" används redan`);
      await expect(refusal).rejects.toThrow(YEAR_ID);
    });

    it('maps a year the caller cannot name to 409 through the composite key', async () => {
      tx.teacherEmployment.upsert.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('FK', {
          code: 'P2003',
          clientVersion: Prisma.prismaVersion.client,
        }),
      );
      await expect(
        service.upsert(COLLEAGUE, YEAR_ID, { employmentPercent: 80 }, testUser()),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('remove', () => {
    it('deletes by teacher and year', async () => {
      tx.teacherEmployment.delete.mockResolvedValue(storedRow());
      await service.remove(COLLEAGUE, YEAR_ID, testUser());
      expect(tx.teacherEmployment.delete).toHaveBeenCalledWith({ where: KEY });
    });

    it('404s a row RLS hides', async () => {
      tx.teacherEmployment.delete.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('gone', {
          code: 'P2025',
          clientVersion: Prisma.prismaVersion.client,
        }),
      );
      await expect(service.remove(COLLEAGUE, YEAR_ID, testUser())).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
