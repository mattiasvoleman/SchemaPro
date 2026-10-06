import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  createPrismaMock,
  createTxMock,
  testUser,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import { lockingRead, rawSql, type LockedTable } from '../../test/utils/locking-read';
import type { PrismaService } from '../database/prisma.service';
import { TeacherQualificationsService } from './teacher-qualifications.service';

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const TEACHER = '44444444-4444-4444-8444-444444444444';
const MA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const USERS: LockedTable = {
  name: 'Users',
  columns: ['id', 'schoolId', 'role', 'firstName', 'lastName', 'email', 'isActive', 'studentGroupId'],
  lock: 'FOR NO KEY UPDATE',
};

describe('TeacherQualificationsService', () => {
  let service: TeacherQualificationsService;
  let tx: TxMock;
  let prisma: PrismaMock;
  let users: Record<string, unknown>[];
  let queryRaw: jest.Mock;

  const storedRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'q-1',
    schoolId: SCHOOL_ID,
    userId: TEACHER,
    subjectId: MA,
    minGradeLevel: 7,
    maxGradeLevel: 9,
    kind: 'LEGITIMATION',
    validFrom: null,
    validTo: new Date('2030-06-30T00:00:00.000Z'),
    note: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  });

  const item = (overrides: Record<string, unknown> = {}) => ({
    subjectId: MA,
    minGradeLevel: 7,
    maxGradeLevel: 9,
    kind: 'LEGITIMATION' as const,
    ...overrides,
  });

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new TeacherQualificationsService(prisma as unknown as PrismaService);
    users = [{ id: TEACHER, role: 'TEACHER' }];
    queryRaw = jest.fn((...call: unknown[]) =>
      Promise.resolve(lockingRead(USERS, users, call)),
    );
    Object.assign(tx, { $queryRaw: queryRaw });
    tx.subject.findMany.mockResolvedValue([{ id: MA }, { id: NO }]);
  });

  describe('list', () => {
    it('reads the school, or one teacher, and hands dates back as yyyy-mm-dd', async () => {
      tx.teacherSubjectQualification.findMany.mockResolvedValue([storedRow()]);
      const user = testUser();

      const all = await service.list(undefined, user);
      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.teacherSubjectQualification.findMany).toHaveBeenCalledWith({
        where: {},
        orderBy: [{ userId: 'asc' }, { subjectId: 'asc' }],
      });
      expect(all[0]).toMatchObject({ validFrom: null, validTo: '2030-06-30' });
      // The two DATE columns are dates, not the midnight instant Prisma invents.
      expect(JSON.stringify([all[0]!.validFrom, all[0]!.validTo])).not.toContain('T00:00');

      await service.list(TEACHER, user);
      expect(tx.teacherSubjectQualification.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ where: { userId: TEACHER } }),
      );
    });
  });

  describe('replace', () => {
    it('deletes the teacher’s rows and writes the list, inside one locked transaction', async () => {
      tx.teacherSubjectQualification.findMany.mockResolvedValue([storedRow()]);

      const answer = await service.replace(
        TEACHER,
        {
          items: [
            item({ validFrom: '2026-08-01', validTo: '2030-06-30', note: ' legitimation 2019 ' }),
            item({ subjectId: NO, minGradeLevel: 4, maxGradeLevel: 6, kind: 'BEHORIG' }),
          ],
        },
        testUser(),
      );

      expect(rawSql(queryRaw.mock.calls[0])).toMatch(
        /SELECT "role"\s+FROM "Users"\s+WHERE "id" = \?::uuid\s+FOR NO KEY UPDATE/,
      );
      expect(tx.teacherSubjectQualification.deleteMany).toHaveBeenCalledWith({
        where: { userId: TEACHER },
      });
      expect(tx.teacherSubjectQualification.createMany).toHaveBeenCalledWith({
        data: [
          {
            schoolId: SCHOOL_ID,
            userId: TEACHER,
            subjectId: MA,
            minGradeLevel: 7,
            maxGradeLevel: 9,
            kind: 'LEGITIMATION',
            validFrom: new Date('2026-08-01T00:00:00.000Z'),
            validTo: new Date('2030-06-30T00:00:00.000Z'),
            note: 'legitimation 2019',
          },
          {
            schoolId: SCHOOL_ID,
            userId: TEACHER,
            subjectId: NO,
            minGradeLevel: 4,
            maxGradeLevel: 6,
            kind: 'BEHORIG',
            validFrom: null,
            validTo: null,
            note: null,
          },
        ],
      });
      expect(
        tx.teacherSubjectQualification.deleteMany.mock.invocationCallOrder[0],
      ).toBeLessThan(tx.teacherSubjectQualification.createMany.mock.invocationCallOrder[0]!);
      expect(answer[0]).toMatchObject({ validTo: '2030-06-30' });
    });

    it('takes every behörighet away with an empty list, writing nothing', async () => {
      tx.teacherSubjectQualification.findMany.mockResolvedValue([]);

      await expect(service.replace(TEACHER, { items: [] }, testUser())).resolves.toEqual([]);

      expect(tx.teacherSubjectQualification.deleteMany).toHaveBeenCalled();
      expect(tx.teacherSubjectQualification.createMany).not.toHaveBeenCalled();
      expect(tx.subject.findMany).not.toHaveBeenCalled();
    });

    it('refuses a subject the caller cannot see, naming it, before deleting anything', async () => {
      tx.subject.findMany.mockResolvedValue([{ id: MA }]);

      await expect(
        service.replace(TEACHER, { items: [item(), item({ subjectId: NO })] }, testUser()),
      ).rejects.toThrow(NO);
      expect(tx.teacherSubjectQualification.deleteMany).not.toHaveBeenCalled();
    });

    it('refuses two rows for one subject, naming the rows', async () => {
      await expect(
        service.replace(
          TEACHER,
          { items: [item({ minGradeLevel: 1, maxGradeLevel: 6 }), item({ minGradeLevel: 7, maxGradeLevel: 9 })] },
          testUser(),
        ),
      ).rejects.toThrow(/Rad 2.*rad 1/);
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('refuses a reversed span and a reversed validity, naming the row and both values', async () => {
      await expect(
        service.replace(TEACHER, { items: [item({ minGradeLevel: 9, maxGradeLevel: 7 })] }, testUser()),
      ).rejects.toThrow(/Rad 1.*\(7\).*\(9\)/);
      await expect(
        service.replace(
          TEACHER,
          { items: [item({ validFrom: '2027-01-01', validTo: '2026-12-31' })] },
          testUser(),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('accepts a one-day validity, and either bound alone', async () => {
      tx.teacherSubjectQualification.findMany.mockResolvedValue([]);
      await expect(
        service.replace(
          TEACHER,
          {
            items: [
              item({ validFrom: '2027-01-01', validTo: '2027-01-01' }),
              item({ subjectId: NO, validTo: '2027-01-01' }),
            ],
          },
          testUser(),
        ),
      ).resolves.toEqual([]);
    });

    it('404s a teacher RLS hides and refuses a pupil', async () => {
      users = [];
      await expect(service.replace(TEACHER, { items: [item()] }, testUser())).rejects.toBeInstanceOf(
        NotFoundException,
      );
      users = [{ id: TEACHER, role: 'GUARDIAN' }];
      await expect(service.replace(TEACHER, { items: [item()] }, testUser())).rejects.toThrow(
        'En behörighet hör till en lärare',
      );
      expect(tx.teacherSubjectQualification.deleteMany).not.toHaveBeenCalled();
    });
  });
});
