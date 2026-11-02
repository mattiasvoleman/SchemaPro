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
import { recordedReads } from '../../test/utils/recorded-reads';
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

    it('leaves tjänst %, nedsättning and the note out for a planner without HR-läs, and keeps the signature', async () => {
      tx.teacherEmployment.findMany.mockResolvedValue([
        storedRow({ reductionPercent: new Prisma.Decimal('20.000'), note: 'Föräldraledig 20 %' }),
      ]);

      const [hidden] = await service.list(YEAR_ID, testUser({ adminProfile: 'SCHEMALAGGARE', hrRead: false }));
      expect(hidden).toMatchObject({
        employmentPercent: null,
        reductionPercent: null,
        note: null,
        hrHidden: true,
        signature: 'KOL',
        contractKind: 'FERIE',
      });

      for (const principal of [
        testUser({ adminProfile: 'SCHEMALAGGARE', hrRead: true }),
        testUser({ adminProfile: 'REKTOR' }),
        testUser(),
      ]) {
        const [shown] = await service.list(YEAR_ID, principal);
        expect(shown).toMatchObject({ employmentPercent: 80, reductionPercent: 20, note: 'Föräldraledig 20 %' });
        expect(shown).not.toHaveProperty('hrHidden');
      }
    });

    it("leaves SCB's three out for a planner without HR-läs, and hands them to one with it (20261111090000)", async () => {
      tx.teacherEmployment.findMany.mockResolvedValue([
        storedRow({ employmentForm: 'VISSTID', firstTeacherPercent: 20, lecturerPercent: 10 }),
      ]);
      const [hidden] = await service.list(YEAR_ID, testUser({ adminProfile: 'EXPEDITION', hrRead: false }));
      expect(hidden).toMatchObject({ employmentForm: null, firstTeacherPercent: null, lecturerPercent: null, hrHidden: true });
      const [shown] = await service.list(YEAR_ID, testUser({ adminProfile: 'EXPEDITION', hrRead: true }));
      expect(shown).toMatchObject({ employmentForm: 'VISSTID', firstTeacherPercent: 20, lecturerPercent: 10 });
      expect(shown).not.toHaveProperty('hrHidden');
    });

    it('leaves deltid in days out for a planner without HR-läs, and hands it to one with it (20261123090000)', async () => {
      tx.teacherEmployment.findMany.mockResolvedValue([storedRow({ maxTeachingDaysPerWeek: 4 })]);
      const [hidden] = await service.list(YEAR_ID, testUser({ adminProfile: 'SCHEMALAGGARE', hrRead: false }));
      expect(hidden).toMatchObject({ maxTeachingDaysPerWeek: null, hrHidden: true });
      for (const principal of [testUser({ adminProfile: 'SCHEMALAGGARE', hrRead: true }), testUser({ role: Role.TEACHER })]) {
        const [shown] = await service.list(YEAR_ID, principal);
        expect(shown).toMatchObject({ maxTeachingDaysPerWeek: 4 });
      }
    });

    describe('the limit on teaching in a row (20261218090000)', () => {
      const limit = { maxConsecutiveTeachingMinutes: 180, consecutiveBreakMinutes: 30 };

      it('leaves the limit out for a planner without HR-läs, as null beside hrHidden, and hands it to one with it', async () => {
        tx.teacherEmployment.findMany.mockResolvedValue([storedRow(limit)]);
        const [hidden] = await service.list(YEAR_ID, testUser({ adminProfile: 'SCHEMALAGGARE', hrRead: false }));
        expect(hidden).toMatchObject({ maxConsecutiveTeachingMinutes: null, consecutiveBreakMinutes: null, hrHidden: true });
        expect(JSON.stringify(hidden)).not.toMatch(/180|"consecutiveBreakMinutes":30/);
        for (const principal of [
          testUser({ adminProfile: 'SCHEMALAGGARE', hrRead: true }),
          testUser({ adminProfile: 'EXPEDITION', hrRead: true }),
          testUser({ adminProfile: 'REKTOR' }),
          testUser(),
        ]) {
          const [shown] = await service.list(YEAR_ID, principal);
          expect(shown).toMatchObject(limit);
          expect(shown).not.toHaveProperty('hrHidden');
        }
      });

      it('hands a teacher their own limit, as it hands them their own days, and asks for nobody else’s post', async () => {
        tx.teacherEmployment.findMany.mockResolvedValue([storedRow({ ...limit, userId: ME, maxTeachingDaysPerWeek: 4 })]);
        const [own] = await service.list(YEAR_ID, testUser({ role: Role.TEACHER }));
        expect(own).toMatchObject({ ...limit, maxTeachingDaysPerWeek: 4 });
        expect(own).not.toHaveProperty('hrHidden');
        expect(tx.teacherEmployment.findMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: { academicYearId: YEAR_ID, userId: ME } }),
        );
      });
    });

    it('answers a PUT by a reader without HR-läs with the post masked as the list would show it', async () => {
      // The row as Prisma returns it, with the SS12000 stretch key no answer carries (20261104090000).
      tx.teacherEmployment.upsert.mockResolvedValue(
        storedRow({ employmentForm: 'VISSTID', firstTeacherPercent: 20, ss12000StretchKey: 'aaaaaaaa-0000-4000-8000-000000000001' }),
      );
      const answer = await service.upsert(
        COLLEAGUE,
        YEAR_ID,
        { employmentPercent: 80, employmentForm: 'VISSTID', firstTeacherPercent: 20, lecturerPercent: null },
        testUser({ adminProfile: 'SCHEMALAGGARE', hrRead: false }),
      );
      expect(answer).toMatchObject({ employmentPercent: null, employmentForm: null, firstTeacherPercent: null, hrHidden: true });
      expect(answer).not.toHaveProperty('ss12000StretchKey');
    });

    it('leaves a changing post\'s periods out for a planner without HR-läs, and hands them to one with it', async () => {
      const period = {
        id: 'per-1', schoolId: SCHOOL_ID, employmentId: 'emp-1', userId: COLLEAGUE, academicYearId: YEAR_ID,
        validFrom: new Date('2026-11-01T00:00:00.000Z'), validTo: null,
        employmentPercent: new Prisma.Decimal('50.000'), reductionPercent: new Prisma.Decimal('0.000'),
        teachingTargetMinutesPerWeek: null,
        createdAt: new Date('2026-09-01T00:00:00.000Z'), updatedAt: new Date('2026-09-01T00:00:00.000Z'),
      };
      tx.teacherEmployment.findMany.mockResolvedValue([storedRow({ periods: [period] })]);

      const [hidden] = await service.list(YEAR_ID, testUser({ adminProfile: 'SCHEMALAGGARE', hrRead: false }));
      expect(hidden).toMatchObject({ employmentPercent: null, periods: [], hrHidden: true });

      const [shown] = await service.list(YEAR_ID, testUser({ adminProfile: 'SCHEMALAGGARE', hrRead: true }));
      expect(shown!.periods).toEqual([expect.objectContaining({ validFrom: '2026-11-01', employmentPercent: 50 })]);
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
        // SCB's three (20261111090000) are not sent, so not written: a new
        // row takes the columns' null, a stored one keeps what it holds.
      };
      expect(tx.teacherEmployment.upsert).toHaveBeenCalledWith({
        where: KEY,
        create: { schoolId: SCHOOL_ID, userId: COLLEAGUE, academicYearId: YEAR_ID, ...data },
        update: data,
        include: { periods: { orderBy: { validFrom: 'asc' } } },
      });
      expect(answer).toMatchObject({ userId: COLLEAGUE, employmentPercent: 80, signature: 'KOL' });
    });

    it('writes the anställningsform and the karriärtjänst shares, and refuses shares above the whole post', async () => {
      tx.teacherEmployment.upsert.mockResolvedValue(storedRow());
      await service.upsert(
        COLLEAGUE,
        YEAR_ID,
        { employmentPercent: 100, employmentForm: 'TILLSVIDARE', firstTeacherPercent: 20, lecturerPercent: 10 },
        testUser(),
      );
      expect(tx.teacherEmployment.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({ employmentForm: 'TILLSVIDARE', firstTeacherPercent: 20, lecturerPercent: 10 }),
        }),
      );
      await expect(
        service.upsert(COLLEAGUE, YEAR_ID, { employmentPercent: 100, firstTeacherPercent: 60, lecturerPercent: 50 }, testUser()),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('clears one of SCB’s fields sent as null, and keeps the ones a PUT leaves out', async () => {
      tx.teacherEmployment.upsert.mockResolvedValue(storedRow());
      await service.upsert(COLLEAGUE, YEAR_ID, { employmentPercent: 100, employmentForm: null }, testUser());
      const [{ update }] = tx.teacherEmployment.upsert.mock.calls[0] as [{ update: Record<string, unknown> }];
      expect(update).toMatchObject({ employmentForm: null });
      // A web from before the fields, open over the release, clears nothing.
      expect('firstTeacherPercent' in update).toBe(false);
      expect('lecturerPercent' in update).toBe(false);
    });

    it('records a kept SCB field it hands back unsent, and nothing for a PUT that sent all three', async () => {
      tx.teacherEmployment.upsert.mockResolvedValue(storedRow({ firstTeacherPercent: 20 }));
      await service.upsert(COLLEAGUE, YEAR_ID, { employmentPercent: 100 }, testUser({ channel: 'WEB' }));
      expect(recordedReads(tx)).toEqual([{ kind: 'EMPLOYMENT', channel: 'WEB', ids: [COLLEAGUE] }]);

      tx.$executeRaw.mockClear();
      await service.upsert(
        COLLEAGUE,
        YEAR_ID,
        { employmentPercent: 100, employmentForm: null, firstTeacherPercent: 20, lecturerPercent: null },
        testUser({ channel: 'WEB' }),
      );
      expect(recordedReads(tx)).toEqual([]);
    });

    describe('deltid in days (20261123090000)', () => {
      const update = () => (tx.teacherEmployment.upsert.mock.calls[0] as [{ update: Record<string, unknown>; create: Record<string, unknown> }])[0];

      it('writes the days when sent, on create and on update, and clears them sent as null', async () => {
        tx.teacherEmployment.upsert.mockResolvedValue(storedRow({ maxTeachingDaysPerWeek: 4 }));
        const answer = await service.upsert(COLLEAGUE, YEAR_ID, { employmentPercent: 80, maxTeachingDaysPerWeek: 4 }, testUser());
        expect(update().update).toMatchObject({ maxTeachingDaysPerWeek: 4 });
        expect(update().create).toMatchObject({ maxTeachingDaysPerWeek: 4 });
        expect(answer).toMatchObject({ maxTeachingDaysPerWeek: 4 });

        tx.teacherEmployment.upsert.mockClear();
        await service.upsert(COLLEAGUE, YEAR_ID, { employmentPercent: 80, maxTeachingDaysPerWeek: null }, testUser());
        expect(update().update).toMatchObject({ maxTeachingDaysPerWeek: null });
      });

      it('keeps the days a PUT leaves out, and records the read of them it hands back', async () => {
        // The card from before the field, open over the release, clears nothing.
        tx.teacherEmployment.upsert.mockResolvedValue(storedRow({ maxTeachingDaysPerWeek: 4 }));
        await service.upsert(COLLEAGUE, YEAR_ID, { employmentPercent: 80 }, testUser({ channel: 'WEB' }));
        expect('maxTeachingDaysPerWeek' in update().update).toBe(false);
        expect('maxTeachingDaysPerWeek' in update().create).toBe(false);
        expect(recordedReads(tx)).toEqual([{ kind: 'EMPLOYMENT', channel: 'WEB', ids: [COLLEAGUE] }]);

        // Sent, it is the caller's own echo: nothing recorded.
        tx.$executeRaw.mockClear();
        await service.upsert(COLLEAGUE, YEAR_ID, { employmentPercent: 80, maxTeachingDaysPerWeek: 4 }, testUser({ channel: 'WEB' }));
        expect(recordedReads(tx)).toEqual([]);
      });

      it('answers a PUT by a reader without HR-läs without the days', async () => {
        tx.teacherEmployment.upsert.mockResolvedValue(storedRow({ maxTeachingDaysPerWeek: 4 }));
        const answer = await service.upsert(
          COLLEAGUE,
          YEAR_ID,
          { employmentPercent: 80, maxTeachingDaysPerWeek: 4 },
          testUser({ adminProfile: 'SCHEMALAGGARE', hrRead: false }),
        );
        expect(answer).toMatchObject({ maxTeachingDaysPerWeek: null, hrHidden: true });
      });
    });

    describe('the limit on teaching in a row (20261218090000)', () => {
      const sent = { maxConsecutiveTeachingMinutes: 180, consecutiveBreakMinutes: 30 };
      const written = () =>
        (tx.teacherEmployment.upsert.mock.calls[0] as [{ update: Record<string, unknown>; create: Record<string, unknown> }])[0];

      it('writes the pair when sent, on create and on update, and hands it back', async () => {
        tx.teacherEmployment.upsert.mockResolvedValue(storedRow(sent));
        const answer = await service.upsert(COLLEAGUE, YEAR_ID, { employmentPercent: 80, ...sent }, testUser());
        expect(written().update).toMatchObject(sent);
        expect(written().create).toMatchObject(sent);
        expect(answer).toMatchObject(sent);
      });

      it('clears the pair sent as null on both', async () => {
        tx.teacherEmployment.upsert.mockResolvedValue(storedRow());
        await service.upsert(
          COLLEAGUE,
          YEAR_ID,
          { employmentPercent: 80, maxConsecutiveTeachingMinutes: null, consecutiveBreakMinutes: null },
          testUser(),
        );
        expect(written().update).toMatchObject({ maxConsecutiveTeachingMinutes: null, consecutiveBreakMinutes: null });
        expect(written().create).toMatchObject({ maxConsecutiveTeachingMinutes: null, consecutiveBreakMinutes: null });
      });

      it('keeps the pair a PUT leaves out, and records the read of it it hands back', async () => {
        // The card from before the fields, open over the release, clears nothing.
        tx.teacherEmployment.upsert.mockResolvedValue(storedRow(sent));
        await service.upsert(COLLEAGUE, YEAR_ID, { employmentPercent: 80 }, testUser({ channel: 'WEB' }));
        for (const column of ['maxConsecutiveTeachingMinutes', 'consecutiveBreakMinutes']) {
          expect(column in written().update).toBe(false);
          expect(column in written().create).toBe(false);
        }
        expect(recordedReads(tx)).toEqual([{ kind: 'EMPLOYMENT', channel: 'WEB', ids: [COLLEAGUE] }]);

        // Sent, it is the caller's own echo: nothing recorded.
        tx.$executeRaw.mockClear();
        await service.upsert(COLLEAGUE, YEAR_ID, { employmentPercent: 80, ...sent }, testUser({ channel: 'WEB' }));
        expect(recordedReads(tx)).toEqual([]);
      });

      it.each([
        ['the limit alone', { maxConsecutiveTeachingMinutes: 180 }],
        ['the break alone', { consecutiveBreakMinutes: 30 }],
        ['the limit with a null break', { maxConsecutiveTeachingMinutes: 180, consecutiveBreakMinutes: null }],
        ['a null limit with the break', { maxConsecutiveTeachingMinutes: null, consecutiveBreakMinutes: 30 }],
        ['a null limit alone', { maxConsecutiveTeachingMinutes: null }],
      ])('refuses a half pair (%s) as a 400 naming both fields, before anything is read or written', async (_name, half) => {
        const refused = service.upsert(COLLEAGUE, YEAR_ID, { employmentPercent: 80, ...half }, testUser());
        await expect(refused).rejects.toBeInstanceOf(BadRequestException);
        await expect(refused).rejects.toThrow(/gränsen för undervisning i följd och pausen som avslutar en följd/);
        expect(prisma.withRls).not.toHaveBeenCalled();
        expect(tx.teacherEmployment.upsert).not.toHaveBeenCalled();
        expect(queryRaw).not.toHaveBeenCalled();
      });

      it('answers a PUT by a reader without HR-läs without the pair', async () => {
        tx.teacherEmployment.upsert.mockResolvedValue(storedRow(sent));
        const answer = await service.upsert(
          COLLEAGUE,
          YEAR_ID,
          { employmentPercent: 80, ...sent },
          testUser({ adminProfile: 'SCHEMALAGGARE', hrRead: false }),
        );
        expect(answer).toMatchObject({ maxConsecutiveTeachingMinutes: null, consecutiveBreakMinutes: null, hrHidden: true });
      });
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

    /*
     * A POST'S HISTORY IS A READ OF THE POST (EMPLOYMENT): the log keeps the
     * whole row as JSON, the percentages, the days and the limit among them.
     * Recorded for the teacher whose versions were handed out, in the read's
     * own transaction — for a reader without HR-läs too, since the versions
     * were read although the HR values are left out of what they are given.
     */
    it('records the read of a teacher’s history in the Läslogg (EMPLOYMENT), in the same transaction', async () => {
      tx.teacherEmploymentLog.findMany.mockResolvedValue([logRow(2), logRow(1, { action: 'CREATE', before: null })]);

      await service.history(COLLEAGUE, YEAR_ID, testUser({ channel: 'WEB' } as never));

      expect(recordedReads(tx)).toEqual([{ kind: 'EMPLOYMENT', channel: 'WEB', ids: [COLLEAGUE] }]);
    });

    it('records it for a planner without HR-läs as well, although every version of the post is left out of what they are given', async () => {
      const limit = (value: number | null) => ({
        id: 'emp-1', userId: COLLEAGUE, academicYearId: YEAR_ID, employmentPercent: 100, reductionPercent: 0,
        maxConsecutiveTeachingMinutes: value, consecutiveBreakMinutes: value === null ? null : 30,
      });
      tx.teacherEmploymentLog.findMany.mockResolvedValue([logRow(2, { before: limit(null), after: limit(120) })]);

      const answer = await service.history(
        COLLEAGUE, YEAR_ID, testUser({ adminProfile: 'SCHEMALAGGARE', hrRead: false, channel: 'WEB' } as never),
      );

      // The only version changed the limit alone: nothing of it is said.
      expect(answer.entries).toEqual([]);
      expect(recordedReads(tx)).toEqual([{ kind: 'EMPLOYMENT', channel: 'WEB', ids: [COLLEAGUE] }]);
    });

    it('records nothing when there is no version to hand out', async () => {
      tx.teacherEmploymentLog.findMany.mockResolvedValue([]);

      await service.history(COLLEAGUE, YEAR_ID, testUser({ channel: 'WEB' } as never));

      expect(recordedReads(tx)).toEqual([]);
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

    it("leaves a period's versions out for a planner without HR-läs, and the post's percentages' values", async () => {
      const period = { id: 'per-1', employmentId: 'emp-1', validFrom: '2026-11-01', validTo: null, employmentPercent: 80, reductionPercent: 0 };
      tx.teacherEmploymentLog.findMany.mockResolvedValue([
        logRow(3, { entity: 'PERIOD', entityId: 'per-1', action: 'CREATE', before: null, after: period }),
        logRow(2),
        logRow(1, { entity: 'DUTY', entityId: 'duty-1', before: { minutesPerWeek: 60 }, after: { minutesPerWeek: 90 } }),
      ]);
      const hidden = await service.history(COLLEAGUE, YEAR_ID, testUser({ adminProfile: 'SCHEMALAGGARE' }));
      expect(hidden.entries.map((entry) => [entry.id, entry.entity])).toEqual([
        ['log-2', 'EMPLOYMENT'],
        ['log-1', 'DUTY'],
      ]);
      expect(hidden.entries[0]!.changes).toEqual([{ field: 'employmentPercent', before: null, after: null, hrHidden: true }]);
      const shown = await service.history(COLLEAGUE, YEAR_ID, testUser({ adminProfile: 'REKTOR' }));
      expect(shown.entries.map((entry) => entry.entity)).toEqual(['PERIOD', 'EMPLOYMENT', 'DUTY']);
    });

    it("leaves the values of SCB's three out of a version for a planner without HR-läs, and says they changed", async () => {
      tx.teacherEmploymentLog.findMany.mockResolvedValue([
        logRow(1, { before: { employmentForm: null, firstTeacherPercent: 10 }, after: { employmentForm: 'VISSTID', firstTeacherPercent: 20 } }),
      ]);
      const hidden = await service.history(COLLEAGUE, YEAR_ID, testUser({ adminProfile: 'SCHEMALAGGARE' }));
      expect(hidden.entries[0]!.changes).toEqual([
        { field: 'employmentForm', before: null, after: null, hrHidden: true },
        { field: 'firstTeacherPercent', before: null, after: null, hrHidden: true },
      ]);
      const shown = await service.history(COLLEAGUE, YEAR_ID, testUser({ adminProfile: 'REKTOR' }));
      expect(shown.entries[0]!.changes).toEqual([
        { field: 'employmentForm', before: null, after: 'VISSTID' },
        { field: 'firstTeacherPercent', before: 10, after: 20 },
      ]);
    });

    it('leaves out a column no list knows from a planner without HR-läs, and shows it whole to whoever reads HR', async () => {
      // A column added to the post after this code: the trigger logs it with
      // the row, and the diff hands it on under its own name.
      const period = { id: 'per-1', employmentId: 'emp-1', validFrom: '2026-11-01', validTo: null, employmentPercent: 80, reductionPercent: 0 };
      const post = { id: 'emp-1', userId: COLLEAGUE, academicYearId: YEAR_ID, reductionPercent: 0 };
      tx.teacherEmploymentLog.findMany.mockResolvedValue([
        logRow(3, { entity: 'PERIOD', entityId: 'per-1', action: 'CREATE', before: null, after: { ...period, reason: 'studier' } }),
        logRow(2, {
          before: { ...post, employmentPercent: 100, signature: 'ANN', employmentEndsOn: null, noteChanged: null },
          after: { ...post, employmentPercent: 80, signature: 'ANS', employmentEndsOn: '2027-06-15', noteChanged: true },
        }),
        logRow(1, { before: { ...post, employmentEndsOn: null }, after: { ...post, employmentEndsOn: '2027-06-15' } }),
      ]);
      const hidden = await service.history(COLLEAGUE, YEAR_ID, testUser({ adminProfile: 'SCHEMALAGGARE' }));
      expect(hidden.entries.map((entry) => [entry.entity, entry.changes])).toEqual([
        [
          'EMPLOYMENT',
          [
            { field: 'employmentPercent', before: null, after: null, hrHidden: true },
            { field: 'signature', before: 'ANN', after: 'ANS' },
          ],
        ],
      ]);
      expect(JSON.stringify(hidden)).not.toMatch(/employmentEndsOn|2027-06-15|noteChanged|studier/);

      const whole = [
        [
          'PERIOD',
          [
            { field: 'validFrom', before: null, after: '2026-11-01' },
            { field: 'validTo', before: null, after: null },
            { field: 'employmentPercent', before: null, after: 80 },
            { field: 'reductionPercent', before: null, after: 0 },
            { field: 'reason', before: null, after: 'studier' },
          ],
        ],
        [
          'EMPLOYMENT',
          [
            { field: 'employmentPercent', before: 100, after: 80 },
            { field: 'signature', before: 'ANN', after: 'ANS' },
            { field: 'noteChanged', before: null, after: true },
            { field: 'employmentEndsOn', before: null, after: '2027-06-15' },
          ],
        ],
        ['EMPLOYMENT', [{ field: 'employmentEndsOn', before: null, after: '2027-06-15' }]],
      ];
      const readers = [
        testUser(),
        testUser({ adminProfile: 'REKTOR' }),
        testUser({ adminProfile: 'SCHEMALAGGARE', hrRead: true }),
        testUser({ adminProfile: 'EXPEDITION', hrRead: true }),
      ];
      for (const reader of readers) {
        const shown = await service.history(COLLEAGUE, YEAR_ID, reader);
        expect(shown.entries.map((entry) => [entry.entity, entry.changes])).toEqual(whole);
        expect(shown.entries.map((entry) => entry.version)).toEqual([3, 2, 1]);
      }
      // A teacher reads their own post whole.
      const own = await service.history(ME, YEAR_ID, testUser({ role: Role.TEACHER }));
      expect(own.entries.map((entry) => [entry.entity, entry.changes])).toEqual(whole);
      expect(own.entries.map((entry) => entry.version)).toEqual([3, 2, 1]);
    });

    /*
     * #231 R2-2. Versions 2 and 3 moved only HR data, so a reader without
     * HR-läs is handed none of them. Their numbers would have read 5, 4, 1:
     * the hole says that something HR happened, and the dates around it say
     * when. They are handed no number at all; whoever reads HR is handed the
     * database's, as before.
     */
    it('hands a planner without HR-läs no version numbers, where the versions between are left out', async () => {
      const base = { id: 'emp-1', userId: COLLEAGUE, academicYearId: YEAR_ID, employmentPercent: 80, reductionPercent: 0, signature: 'EVA' };
      const none = { maxConsecutiveTeachingMinutes: null, consecutiveBreakMinutes: null, maxTeachingDaysPerWeek: null };
      const limit = (minutes: number, pause: number) => ({ ...base, ...none, maxConsecutiveTeachingMinutes: minutes, consecutiveBreakMinutes: pause });
      tx.teacherEmploymentLog.findMany.mockResolvedValue([
        logRow(5, { before: { ...limit(235, 45) }, after: { ...limit(235, 45), employmentPercent: 100 } }),
        logRow(4, { before: { ...limit(235, 45), employmentPercent: 90 }, after: { ...limit(235, 45), employmentPercent: 90, signature: 'EVB' } }),
        logRow(3, { before: limit(120, 30), after: limit(235, 45) }),
        logRow(2, { before: { ...base, ...none }, after: limit(120, 30) }),
        logRow(1, { action: 'CREATE', before: null, after: { ...base, ...none } }),
      ]);
      const hidden = await service.history(COLLEAGUE, YEAR_ID, testUser({ adminProfile: 'SCHEMALAGGARE', hrRead: false }));
      // 2 and 3 are left out, and nothing of what is left says that they were there.
      expect(hidden.entries.map((entry) => entry.id)).toEqual(['log-5', 'log-4', 'log-1']);
      for (const entry of hidden.entries) expect(entry).not.toHaveProperty('version');
      expect(JSON.stringify(hidden)).not.toMatch(/version|235|120|onsecutive|BreakMinutes/);

      const shown = await service.history(COLLEAGUE, YEAR_ID, testUser({ adminProfile: 'SCHEMALAGGARE', hrRead: true }));
      expect(shown.entries.map((entry) => entry.version)).toEqual([5, 4, 3, 2, 1]);
    });

    describe('deltid in days in Historik (20261123090000)', () => {
      const post = { id: 'emp-1', userId: COLLEAGUE, academicYearId: YEAR_ID, employmentPercent: 100, reductionPercent: 0 };
      const hidden = () => service.history(COLLEAGUE, YEAR_ID, testUser({ adminProfile: 'SCHEMALAGGARE', hrRead: false }));
      const shown = () => service.history(COLLEAGUE, YEAR_ID, testUser({ adminProfile: 'SCHEMALAGGARE', hrRead: true }));

      it('leaves out a version whose only change was the days, and says nothing of it, for a reader without HR-läs', async () => {
        /*
         * An "ändrad, dolt" on exactly the versions where the days moved would
         * say which teacher has a limit; so would the version itself, standing
         * there with no change in it.
         */
        tx.teacherEmploymentLog.findMany.mockResolvedValue([
          logRow(3, { before: { ...post, maxTeachingDaysPerWeek: null }, after: { ...post, maxTeachingDaysPerWeek: 4 } }),
          logRow(2, { before: { ...post, signature: 'A' }, after: { ...post, signature: 'B' } }),
        ]);
        expect((await hidden()).entries.map((entry) => entry.id)).toEqual(['log-2']);
        const answer = await shown();
        expect(answer.entries.map((entry) => entry.version)).toEqual([3, 2]);
        expect(answer.entries[0]!.changes).toEqual([{ field: 'maxTeachingDaysPerWeek', before: null, after: 4 }]);
      });

      it('keeps a version that changed the days and the tjänst %, with the days left out and the percentage said to have changed', async () => {
        tx.teacherEmploymentLog.findMany.mockResolvedValue([
          logRow(2, {
            before: { ...post, maxTeachingDaysPerWeek: null },
            after: { ...post, employmentPercent: 80, maxTeachingDaysPerWeek: 4 },
          }),
        ]);
        expect((await hidden()).entries[0]!.changes).toEqual([
          { field: 'employmentPercent', before: null, after: null, hrHidden: true },
        ]);
        expect((await shown()).entries[0]!.changes).toEqual([
          { field: 'employmentPercent', before: 100, after: 80 },
          { field: 'maxTeachingDaysPerWeek', before: null, after: 4 },
        ]);
      });

      it('keeps a created post that carried the days, without them', async () => {
        tx.teacherEmploymentLog.findMany.mockResolvedValue([
          logRow(1, { action: 'CREATE', before: null, after: { ...post, signature: 'KOL', maxTeachingDaysPerWeek: 4 } }),
        ]);
        const [created] = (await hidden()).entries;
        expect(created!.changes.map((change) => change.field)).toEqual(['employmentPercent', 'reductionPercent', 'signature']);
        expect(JSON.stringify(created)).not.toContain('maxTeachingDaysPerWeek');
        expect((await shown()).entries[0]!.changes).toContainEqual({ field: 'maxTeachingDaysPerWeek', before: null, after: 4 });
      });

      it('keeps a version that changed nothing at all, for every reader, as it always did', async () => {
        tx.teacherEmploymentLog.findMany.mockResolvedValue([logRow(2, { before: post, after: post })]);
        expect((await hidden()).entries.map((entry) => [entry.id, entry.changes])).toEqual([['log-2', []]]);
      });
    });

    describe('the limit on teaching in a row in Historik (20261218090000)', () => {
      const post = { id: 'emp-1', userId: COLLEAGUE, academicYearId: YEAR_ID, employmentPercent: 100, reductionPercent: 0 };
      const none = { maxConsecutiveTeachingMinutes: null, consecutiveBreakMinutes: null };
      const set = { maxConsecutiveTeachingMinutes: 180, consecutiveBreakMinutes: 30 };
      const hidden = () => service.history(COLLEAGUE, YEAR_ID, testUser({ adminProfile: 'SCHEMALAGGARE', hrRead: false }));
      const shown = () => service.history(COLLEAGUE, YEAR_ID, testUser({ adminProfile: 'SCHEMALAGGARE', hrRead: true }));

      it('leaves out a version whose only change was the limit, and says nothing of it, for a reader without HR-läs', async () => {
        tx.teacherEmploymentLog.findMany.mockResolvedValue([
          logRow(3, { before: { ...post, ...none }, after: { ...post, ...set } }),
          logRow(2, { before: { ...post, signature: 'A' }, after: { ...post, signature: 'B' } }),
        ]);
        expect((await hidden()).entries.map((entry) => entry.id)).toEqual(['log-2']);
        const answer = await shown();
        expect(answer.entries.map((entry) => entry.version)).toEqual([3, 2]);
        expect(answer.entries[0]!.changes).toEqual([
          { field: 'maxConsecutiveTeachingMinutes', before: null, after: 180 },
          { field: 'consecutiveBreakMinutes', before: null, after: 30 },
        ]);
      });

      it('keeps a version that changed the limit and the tjänst %, with the limit left out and the percentage said to have changed', async () => {
        tx.teacherEmploymentLog.findMany.mockResolvedValue([
          logRow(2, { before: { ...post, ...none }, after: { ...post, employmentPercent: 80, ...set } }),
        ]);
        const masked = await hidden();
        expect(masked.entries[0]!.changes).toEqual([{ field: 'employmentPercent', before: null, after: null, hrHidden: true }]);
        expect(JSON.stringify(masked)).not.toMatch(/onsecutive|BreakMinutes|180/);
        expect((await shown()).entries[0]!.changes.map((change) => change.field)).toEqual([
          'employmentPercent',
          'maxConsecutiveTeachingMinutes',
          'consecutiveBreakMinutes',
        ]);
      });

      it('keeps a created post that carried the limit, without it', async () => {
        tx.teacherEmploymentLog.findMany.mockResolvedValue([
          logRow(1, { action: 'CREATE', before: null, after: { ...post, signature: 'KOL', ...set } }),
        ]);
        const [created] = (await hidden()).entries;
        expect(created!.changes.map((change) => change.field)).toEqual(['employmentPercent', 'reductionPercent', 'signature']);
        expect(JSON.stringify(created)).not.toMatch(/onsecutive|BreakMinutes/);
        expect((await shown()).entries[0]!.changes).toContainEqual({ field: 'maxConsecutiveTeachingMinutes', before: null, after: 180 });
      });

      it('hands a teacher the versions of their own post with the limit in them', async () => {
        tx.teacherEmploymentLog.findMany.mockResolvedValue([
          logRow(2, { before: { ...post, userId: ME, ...none }, after: { ...post, userId: ME, ...set } }),
        ]);
        const own = await service.history(ME, YEAR_ID, testUser({ role: Role.TEACHER }));
        expect(own.entries[0]!.changes.map((change) => change.field)).toEqual([
          'maxConsecutiveTeachingMinutes',
          'consecutiveBreakMinutes',
        ]);
      });
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
