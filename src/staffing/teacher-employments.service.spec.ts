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
    // Every read and write includes the post's periods (WITH_PERIODS).
    periods: [],
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
        include: { periods: { orderBy: { validFrom: 'asc' } } },
      });
      expect(answer[0]).toMatchObject({ employmentPercent: 80, reductionPercent: 0, periods: [] });
      expect(typeof answer[0]!.employmentPercent).toBe('number');
    });

    it('narrows a teacher to their own row in the query, not only through RLS', async () => {
      tx.teacherEmployment.findMany.mockResolvedValue([]);

      await service.list(YEAR_ID, testUser({ role: Role.TEACHER }));

      expect(tx.teacherEmployment.findMany).toHaveBeenCalledWith({
        where: { academicYearId: YEAR_ID, userId: ME },
        orderBy: { userId: 'asc' },
        include: { periods: { orderBy: { validFrom: 'asc' } } },
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
        include: { periods: { orderBy: { validFrom: 'asc' } } },
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

  describe('periods (20261022120000)', () => {
    const POSTS: LockedTable = {
      name: 'TeacherEmployments',
      columns: ['id', 'schoolId', 'userId', 'academicYearId', 'employmentPercent', 'reductionPercent'],
      lock: 'FOR NO KEY UPDATE',
    };
    const YEARS: LockedTable = {
      name: 'AcademicYears',
      columns: ['id', 'startDate', 'endDate'],
      lock: 'FOR SHARE',
    };
    const day = (value: string) => new Date(`${value}T00:00:00.000Z`);
    let posts: Record<string, unknown>[];
    let years: Record<string, unknown>[];

    beforeEach(() => {
      posts = [{ id: 'emp-1' }];
      years = [{ id: YEAR_ID, startDate: day('2026-08-17'), endDate: day('2027-06-11') }];
      // The year's bounds are read by "id" too; its row answers to the year's id.
      queryRaw.mockImplementation((...call: unknown[]) => {
        const sql = rawSql(call);
        if (sql.includes('"TeacherEmployments"')) return Promise.resolve(lockingRead(POSTS, posts, call));
        if (sql.includes('"AcademicYears"')) return Promise.resolve(lockingRead(YEARS, years, call));
        return Promise.resolve(lockingRead(USERS, users, call));
      });
      tx.teacherEmployment.findUnique.mockResolvedValue({ id: 'emp-1' });
      tx.teacherEmploymentPeriod.findMany.mockResolvedValue([]);
      tx.teacherEmploymentPeriod.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'period-new', ...data }),
      );
    });

    const create = (dto: Record<string, unknown>) =>
      service.createPeriod(COLLEAGUE, YEAR_ID, { validFrom: '2026-11-01', employmentPercent: 80, ...dto } as never, testUser());

    it('locks the post, reads the year FOR SHARE, and writes the period on the post with its owner and year', async () => {
      const answer = await create({});

      expect(tx.teacherEmployment.findUnique).toHaveBeenCalledWith({ where: KEY, select: { id: true } });
      const sql = queryRaw.mock.calls.map((call) => rawSql(call).replace(/\s+/g, ' '));
      expect(sql[0]).toContain('FROM "TeacherEmployments" WHERE "id" = ?::uuid FOR NO KEY UPDATE');
      expect(sql[1]).toContain('FROM "AcademicYears" WHERE "id" = ?::uuid FOR SHARE');
      expect(tx.teacherEmploymentPeriod.create).toHaveBeenCalledWith({
        data: {
          schoolId: SCHOOL_ID,
          employmentId: 'emp-1',
          userId: COLLEAGUE,
          academicYearId: YEAR_ID,
          validFrom: day('2026-11-01'),
          validTo: null,
          employmentPercent: 80,
          reductionPercent: 0,
          teachingTargetMinutesPerWeek: null,
        },
      });
      expect(answer).toEqual({
        id: 'period-new',
        employmentId: 'emp-1',
        validFrom: '2026-11-01',
        validTo: null,
        employmentPercent: 80,
        reductionPercent: 0,
        teachingTargetMinutesPerWeek: null,
      });
    });

    it('refuses a period on a teacher with no post that year', async () => {
      tx.teacherEmployment.findUnique.mockResolvedValue(null);
      await expect(create({})).rejects.toBeInstanceOf(NotFoundException);
      expect(tx.teacherEmploymentPeriod.create).not.toHaveBeenCalled();
    });

    it('refuses dates outside the läsår, Till before Från, and a nedsättning above the post', async () => {
      await expect(create({ validFrom: '2026-08-10' })).rejects.toThrow('validFrom: 2026-08-10 ligger utanför läsåret');
      await expect(create({ validTo: '2027-06-30' })).rejects.toThrow('validTo: 2027-06-30 ligger utanför läsåret');
      await expect(create({ validTo: '2026-10-31' })).rejects.toThrow('validTo: perioden kan inte sluta');
      await expect(create({ reductionPercent: 90 })).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.teacherEmploymentPeriod.create).not.toHaveBeenCalled();
    });

    it('refuses a period that holds no Monday of the year, since a week is the post in force on its Monday', async () => {
      await expect(create({ validFrom: '2026-11-10', validTo: '2026-11-13' })).rejects.toThrow('innehåller ingen måndag');
      // Tuesday to the next Monday holds one.
      await expect(create({ validFrom: '2026-11-10', validTo: '2026-11-16' })).resolves.toMatchObject({ validFrom: '2026-11-10' });
    });

    it('answers an overlap with another period of the post with 409, naming its dates', async () => {
      tx.teacherEmploymentPeriod.findMany.mockResolvedValue([{ validFrom: day('2027-01-07'), validTo: null }]);
      await expect(create({ validTo: '2027-01-07' })).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'EMPLOYMENT_PERIOD_OVERLAP',
          message: expect.stringContaining('(2027-01-07 till 2027-06-11)'),
        }),
      });
      // Ending the day before is no overlap.
      await expect(create({ validTo: '2027-01-06' })).resolves.toBeDefined();
      expect(tx.teacherEmploymentPeriod.findMany).toHaveBeenLastCalledWith({
        where: { employmentId: 'emp-1' },
        select: { validFrom: true, validTo: true },
        orderBy: { validFrom: 'asc' },
      });
    });

    it('rewrites a period on its own post, measured against the others but not itself', async () => {
      tx.teacherEmploymentPeriod.findUnique.mockResolvedValue({ employmentId: 'emp-1', academicYearId: YEAR_ID });
      tx.teacherEmploymentPeriod.update.mockResolvedValue({
        id: 'period-1', employmentId: 'emp-1', validFrom: day('2026-11-02'), validTo: null,
        employmentPercent: new Prisma.Decimal('75.000'), reductionPercent: new Prisma.Decimal('0.000'), teachingTargetMinutesPerWeek: null,
      });
      const answer = await service.updatePeriod('period-1', { validFrom: '2026-11-02', employmentPercent: 75 } as never, testUser());
      expect(tx.teacherEmploymentPeriod.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { employmentId: 'emp-1', id: { not: 'period-1' } } }),
      );
      expect(answer.employmentPercent).toBe(75);
    });

    it('answers 404 for a period the caller cannot see, and removes one under its post\'s lock', async () => {
      tx.teacherEmploymentPeriod.findUnique.mockResolvedValue(null);
      await expect(service.removePeriod('period-x', testUser())).rejects.toBeInstanceOf(NotFoundException);
      tx.teacherEmploymentPeriod.findUnique.mockResolvedValue({ employmentId: 'emp-1', academicYearId: YEAR_ID });
      await service.removePeriod('period-1', testUser());
      expect(tx.teacherEmploymentPeriod.delete).toHaveBeenCalledWith({ where: { id: 'period-1' } });
    });

    it('answers the EXCLUDE constraint as the same 409, for a writer that did not take the lock', async () => {
      tx.teacherEmploymentPeriod.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('conflicting key value violates exclusion constraint "TeacherEmploymentPeriods_do_not_overlap"', {
          code: 'P2039',
          clientVersion: Prisma.prismaVersion.client,
        }),
      );
      await expect(create({})).rejects.toBeInstanceOf(ConflictException);
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

  describe('history', () => {
    const logRow = (version: number, overrides: Record<string, unknown> = {}) => ({
      id: `log-${version}`,
      version,
      entity: 'EMPLOYMENT',
      entityId: 'emp-1',
      action: 'UPDATE',
      before: { id: 'emp-1', userId: COLLEAGUE, academicYearId: YEAR_ID, employmentPercent: 100, reductionPercent: 0 },
      after: { id: 'emp-1', userId: COLLEAGUE, academicYearId: YEAR_ID, employmentPercent: 80, reductionPercent: 0 },
      actorId: ME,
      createdAt: new Date('2026-10-09T12:02:00.000Z'),
      ...overrides,
    });

    it('reads a teacher’s versions newest first under the admin’s RLS, each with what it changed', async () => {
      tx.teacherEmploymentLog.findMany.mockResolvedValue([logRow(2), logRow(1, { action: 'CREATE', before: null })]);

      const answer = await service.history(COLLEAGUE, YEAR_ID, testUser());

      expect(prisma.withRls).toHaveBeenCalledTimes(1);
      expect(tx.teacherEmploymentLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: COLLEAGUE, academicYearId: YEAR_ID }, orderBy: { version: 'desc' }, take: 201 }),
      );
      expect(answer.truncated).toBe(false);
      expect(answer.entries.map((entry) => [entry.version, entry.action, entry.actorId])).toEqual([
        [2, 'UPDATE', ME],
        [1, 'CREATE', ME],
      ]);
      expect(answer.entries[0]!.changes).toEqual([{ field: 'employmentPercent', before: 100, after: 80 }]);
      // The raw JSON is not handed out: the changes are.
      expect(answer.entries[0]).not.toHaveProperty('before');
    });

    it('lets a teacher read their own, and 403s a colleague’s before a statement is sent', async () => {
      tx.teacherEmploymentLog.findMany.mockResolvedValue([]);
      const teacher = testUser({ role: Role.TEACHER });

      await expect(service.history(ME, YEAR_ID, teacher)).resolves.toEqual({ entries: [], truncated: false });
      prisma.withRls.mockClear();
      await expect(service.history(COLLEAGUE, YEAR_ID, teacher)).rejects.toThrow(ForbiddenException);
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('names the period a PERIOD version is about, by its Från, also when only its figures changed', async () => {
      const period = { id: 'per-1', employmentId: 'emp-1', validFrom: '2026-11-01', validTo: null, employmentPercent: 80, reductionPercent: 0 };
      tx.teacherEmploymentLog.findMany.mockResolvedValue([
        logRow(3, { entity: 'PERIOD', entityId: 'per-1', action: 'DELETE', before: { ...period, employmentPercent: 75 }, after: null }),
        logRow(2, { entity: 'PERIOD', entityId: 'per-1', before: period, after: { ...period, employmentPercent: 75 } }),
        logRow(1),
      ]);
      const answer = await service.history(COLLEAGUE, YEAR_ID, testUser());
      expect(answer.entries.map((entry) => entry.periodFrom)).toEqual(['2026-11-01', '2026-11-01', undefined]);
      // The update moved the grad alone: its changes do not carry the Från, the entry does.
      expect(answer.entries[1]!.changes).toEqual([{ field: 'employmentPercent', before: 80, after: 75 }]);
      expect(answer.entries[2]).not.toHaveProperty('periodFrom');
    });

    it('says when it left the oldest versions out', async () => {
      tx.teacherEmploymentLog.findMany.mockResolvedValue(Array.from({ length: 201 }, (_, i) => logRow(201 - i)));
      const answer = await service.history(COLLEAGUE, YEAR_ID, testUser());
      expect(answer.entries).toHaveLength(200);
      expect(answer.truncated).toBe(true);
      expect(answer.entries.at(-1)!.version).toBe(2);
    });
  });
});
