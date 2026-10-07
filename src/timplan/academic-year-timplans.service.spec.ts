import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  createPrismaMock,
  createTxMock,
  testUser,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import { lockingRead, type LockedTable } from '../../test/utils/locking-read';
import type { PrismaService } from '../database/prisma.service';
import { AcademicYearTimplansService } from './academic-year-timplans.service';

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const YEAR_ID = '44444444-4444-4444-8444-444444444444';
const DECIDED_ID = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const DRAFT_ID = 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2';

/** The year row as the dialog's PUT has to lock it. */
const YEARS: LockedTable = {
  name: 'AcademicYears',
  columns: ['id', 'schoolId', 'name', 'startDate', 'endDate', 'isActive'],
  lock: 'FOR NO KEY UPDATE',
};

/**
 * AcademicYearTimplans as a small in-memory table, so the PUT's diff is judged
 * by the rows it leaves behind, not by the calls someone expected it to make.
 */
function givenTable(tx: TxMock, initial: { gradeLevel: number; localTimplanId: string }[]) {
  const rows = new Map(initial.map((row) => [row.gradeLevel, row.localTimplanId]));
  const plans: Record<string, { name: string; status: 'DRAFT' | 'DECIDED' }> = {
    [DECIDED_ID]: { name: 'Grundskolan 2024', status: 'DECIDED' },
    [DRAFT_ID]: { name: 'Grundskolan 2027 (utkast)', status: 'DRAFT' },
  };
  tx.academicYearTimplan.findMany.mockImplementation((args: { select: Record<string, unknown> }) =>
    Promise.resolve(
      [...rows]
        .sort(([a], [b]) => a - b)
        .map(([gradeLevel, localTimplanId]) =>
          args.select.localTimplan
            ? { gradeLevel, localTimplanId, localTimplan: plans[localTimplanId] }
            : { gradeLevel, localTimplanId },
        ),
    ),
  );
  tx.academicYearTimplan.deleteMany.mockImplementation(
    (args: { where: { gradeLevel: { in: number[] } } }) => {
      for (const grade of args.where.gradeLevel.in) rows.delete(grade);
      return Promise.resolve({ count: args.where.gradeLevel.in.length });
    },
  );
  tx.academicYearTimplan.create.mockImplementation(
    (args: { data: { gradeLevel: number; localTimplanId: string } }) => {
      rows.set(args.data.gradeLevel, args.data.localTimplanId);
      return Promise.resolve(args.data);
    },
  );
  tx.academicYearTimplan.update.mockImplementation(
    (args: {
      where: { academicYearId_gradeLevel: { gradeLevel: number } };
      data: { localTimplanId: string };
    }) => {
      rows.set(args.where.academicYearId_gradeLevel.gradeLevel, args.data.localTimplanId);
      return Promise.resolve(args.data);
    },
  );
  tx.localTimplan.findMany.mockImplementation((args: { where: { id: { in: string[] } } }) =>
    Promise.resolve(args.where.id.in.filter((id) => plans[id]).map((id) => ({ id }))),
  );
  return rows;
}

describe('AcademicYearTimplansService', () => {
  let service: AcademicYearTimplansService;
  let tx: TxMock;
  let prisma: PrismaMock;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new AcademicYearTimplansService(prisma as unknown as PrismaService);
    Object.assign(tx, {
      $queryRaw: jest.fn((...call: unknown[]) =>
        Promise.resolve(lockingRead(YEARS, [{ id: YEAR_ID, schoolId: SCHOOL_ID }], call)),
      ),
    });
  });

  describe('replace', () => {
    it('writes what the dialog shows: new grades created, changed ones updated, null and absent ones gone', async () => {
      const rows = givenTable(tx, [
        { gradeLevel: 6, localTimplanId: DECIDED_ID },
        { gradeLevel: 7, localTimplanId: DECIDED_ID },
        { gradeLevel: 8, localTimplanId: DECIDED_ID },
        { gradeLevel: 9, localTimplanId: DECIDED_ID },
      ]);

      const answer = await service.replace(
        YEAR_ID,
        {
          timplans: [
            { gradeLevel: 7, localTimplanId: DECIDED_ID },
            { gradeLevel: 8, localTimplanId: DRAFT_ID },
            { gradeLevel: 9, localTimplanId: null },
            { gradeLevel: 1, localTimplanId: DRAFT_ID },
          ],
        },
        testUser(),
      );

      expect([...rows].sort(([a], [b]) => a - b)).toEqual([
        [1, DRAFT_ID],
        [7, DECIDED_ID],
        [8, DRAFT_ID],
      ]);
      // The unchanged grade keeps its row: no write touched årskurs 7.
      expect(tx.academicYearTimplan.update).toHaveBeenCalledTimes(1);
      expect(tx.academicYearTimplan.create).toHaveBeenCalledWith({
        data: { schoolId: SCHOOL_ID, academicYearId: YEAR_ID, gradeLevel: 1, localTimplanId: DRAFT_ID },
      });
      // A draft is legal and every row says which it is.
      expect(answer).toEqual([
        { gradeLevel: 1, localTimplanId: DRAFT_ID, planName: 'Grundskolan 2027 (utkast)', planStatus: 'DRAFT' },
        { gradeLevel: 7, localTimplanId: DECIDED_ID, planName: 'Grundskolan 2024', planStatus: 'DECIDED' },
        { gradeLevel: 8, localTimplanId: DRAFT_ID, planName: 'Grundskolan 2027 (utkast)', planStatus: 'DRAFT' },
      ]);
    });

    it('an empty list empties the year', async () => {
      const rows = givenTable(tx, [{ gradeLevel: 4, localTimplanId: DECIDED_ID }]);
      await expect(service.replace(YEAR_ID, { timplans: [] }, testUser())).resolves.toEqual([]);
      expect(rows.size).toBe(0);
      expect(tx.localTimplan.findMany).not.toHaveBeenCalled();
    });

    it('locks the year FOR NO KEY UPDATE before it reads or writes anything', async () => {
      givenTable(tx, []);
      const order: string[] = [];
      const lock = tx.$queryRaw as unknown as jest.Mock;
      const answer = lock.getMockImplementation()!;
      lock.mockImplementation((...call: unknown[]) => {
        order.push('lock');
        return answer(...call);
      });
      tx.localTimplan.findMany.mockImplementation(() => {
        order.push('plans');
        return Promise.resolve([{ id: DECIDED_ID }]);
      });

      await service.replace(YEAR_ID, { timplans: [{ gradeLevel: 4, localTimplanId: DECIDED_ID }] }, testUser());

      expect(order).toEqual(['lock', 'plans']);
    });

    it('404s a year RLS hides, and writes nothing', async () => {
      givenTable(tx, []);
      Object.assign(tx, { $queryRaw: jest.fn().mockResolvedValue([]) });

      await expect(
        service.replace(YEAR_ID, { timplans: [{ gradeLevel: 4, localTimplanId: DECIDED_ID }] }, testUser()),
      ).rejects.toThrow(NotFoundException);
      expect(tx.academicYearTimplan.create).not.toHaveBeenCalled();
    });

    it('400s a plan the school does not have, naming it, and writes nothing', async () => {
      givenTable(tx, [{ gradeLevel: 4, localTimplanId: DECIDED_ID }]);
      const ghost = 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3';

      const error = await service
        .replace(YEAR_ID, { timplans: [{ gradeLevel: 5, localTimplanId: ghost }] }, testUser())
        .catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as Error).message).toContain(ghost);
      expect(tx.academicYearTimplan.deleteMany).not.toHaveBeenCalled();
    });

    it('400s the same årskurs twice, naming both rows, before opening a transaction', async () => {
      await expect(
        service.replace(
          YEAR_ID,
          {
            timplans: [
              { gradeLevel: 7, localTimplanId: DECIDED_ID },
              { gradeLevel: 7, localTimplanId: null },
            ],
          },
          testUser(),
        ),
      ).rejects.toThrow('rad 2 gäller samma årskurs 7 som rad 1');
      expect(prisma.withRls).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('reads the year’s rows with each plan’s name and status', async () => {
      givenTable(tx, [{ gradeLevel: 7, localTimplanId: DRAFT_ID }]);
      tx.academicYear.findUnique.mockResolvedValue({ id: YEAR_ID });

      await expect(service.list(YEAR_ID, testUser())).resolves.toEqual([
        { gradeLevel: 7, localTimplanId: DRAFT_ID, planName: 'Grundskolan 2027 (utkast)', planStatus: 'DRAFT' },
      ]);
    });

    it('404s a year RLS hides', async () => {
      tx.academicYear.findUnique.mockResolvedValue(null);
      await expect(service.list(YEAR_ID, testUser())).rejects.toThrow('Läsåret finns inte.');
    });
  });
});
