import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  BULK_ROW_NOT_FOUND,
  BULK_ROW_REFERENCE_GONE,
  BULK_ROW_TAKEN,
  assertSomeChange,
  notFound,
  refusalOf,
  runBulk,
  uniqueIds,
  writeAll,
  type BulkRefusal,
} from './bulk';
import { writeConflict } from './utils/prisma-errors';

/** The sentence a row that is not there, or not the caller's to change, is refused with. */
const NOT_FOUND = 'Raden finns inte längre, eller får inte ändras härifrån.';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';

const prismaError = (code: string): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError(`Simulated ${code}`, {
    code,
    clientVersion: Prisma.prismaVersion.client,
  });

/** The statements a fake transaction was sent, as the SQL text of each tagged template. */
function fakeTx() {
  const statements: string[] = [];
  const executeRaw = jest.fn((strings: TemplateStringsArray) => {
    statements.push(strings.join('?'));
    return Promise.resolve(0);
  });
  return { tx: { $executeRaw: executeRaw } as unknown as PrismaClient, statements };
}

describe('bulk', () => {
  describe('uniqueIds', () => {
    it('keeps each id once, in id order: the order rows are locked and tried in', () => {
      expect(uniqueIds([C, A, C, B, A])).toEqual([A, B, C]);
    });
  });

  describe('assertSomeChange', () => {
    it('refuses a body whose changes name nothing, or that has none', () => {
      expect(() => assertSomeChange({})).toThrow(BadRequestException);
      expect(() => assertSomeChange({ gradeLevel: undefined })).toThrow(BadRequestException);
      expect(() => assertSomeChange(undefined)).toThrow(BadRequestException);
    });

    it('takes null as a change: "no class", "no årskurs"', () => {
      expect(() => assertSomeChange({ gradeLevel: null })).not.toThrow();
      expect(() => assertSomeChange({ isActive: false })).not.toThrow();
    });
  });

  describe('refusalOf', () => {
    it("keeps the single route's code, sentence and params", () => {
      const refusal = refusalOf(
        A,
        new ConflictException({ message: 'Vikarien är bokad.', code: 'USER_HAS_BOOKED_PASS_COVERS', params: { date: '2026-11-04' } }),
      );
      expect(refusal).toEqual({
        id: A,
        code: 'USER_HAS_BOOKED_PASS_COVERS',
        message: 'Vikarien är bokad.',
        params: { date: '2026-11-04' },
      });
    });

    it('drops params that come without a code, as the exception filter does', () => {
      expect(refusalOf(A, new BadRequestException({ message: 'Nej.', params: { x: 1 } }))).toEqual({
        id: A,
        code: null,
        message: 'Nej.',
      });
    });

    it('takes a string body as the sentence', () => {
      expect(refusalOf(A, new BadRequestException('Bara elever.'))).toEqual({ id: A, code: null, message: 'Bara elever.' });
    });

    it('names a 404 without a code as a row that is not there', () => {
      expect(refusalOf(A, new NotFoundException('The requested record does not exist.'))).toMatchObject({
        code: BULK_ROW_NOT_FOUND,
      });
    });

    it('maps a Prisma refusal through rethrowPrismaError, and gives its generic English answer a code and a Swedish sentence', () => {
      expect(refusalOf(A, prismaError('P2025'))).toEqual({ id: A, code: BULK_ROW_NOT_FOUND, message: NOT_FOUND });
      expect(refusalOf(A, prismaError('P2002'))).toEqual({
        id: A,
        code: BULK_ROW_TAKEN,
        message: 'Raden skulle krocka med en annan rad som redan har samma värden.',
      });
      expect(refusalOf(A, prismaError('P2003'))).toEqual({
        id: A,
        code: BULK_ROW_REFERENCE_GONE,
        message: 'Raden skulle peka på något som inte längre finns.',
      });
    });

    it("keeps a refusal's own sentence when it has no code: only the generic answers are rewritten", () => {
      expect(refusalOf(A, new BadRequestException('studentGroupId: klassen finns inte i skolan.'))).toEqual({
        id: A,
        code: null,
        message: 'studentGroupId: klassen finns inte i skolan.',
      });
    });

    it('is no refusal of the row for a deadlock, a 5xx or a plain error: the caller rethrows those', () => {
      expect(refusalOf(A, writeConflict())).toBeNull();
      expect(refusalOf(A, new InternalServerErrorException())).toBeNull();
      expect(refusalOf(A, new Error('connection reset'))).toBeNull();
    });

    it('joins a validation message list', () => {
      expect(refusalOf(A, new BadRequestException({ message: ['a', 'b'] }))?.message).toBe('a b');
    });
  });

  describe('notFound', () => {
    it('says the row is gone, with the report code', () => {
      expect(notFound(A)).toEqual({
        id: A,
        code: BULK_ROW_NOT_FOUND,
        message: expect.stringContaining('finns inte längre'),
      });
    });
  });

  describe('writeAll', () => {
    it('writes every row in one statement and answers no refusal', async () => {
      const { tx, statements } = fakeTx();
      const whole = jest.fn().mockResolvedValue({ count: 2 });
      const one = jest.fn();
      await expect(writeAll(tx, [A, B], whole, one)).resolves.toEqual([]);
      expect(whole).toHaveBeenCalledWith([A, B]);
      expect(one).not.toHaveBeenCalled();
      expect(statements).toEqual(['SAVEPOINT bulk_whole', 'RELEASE SAVEPOINT bulk_whole']);
    });

    it('sends nothing for no rows', async () => {
      const { tx, statements } = fakeTx();
      const whole = jest.fn();
      await expect(writeAll(tx, [], whole, jest.fn())).resolves.toEqual([]);
      expect(whole).not.toHaveBeenCalled();
      expect(statements).toEqual([]);
    });

    it('when the database refuses the whole, tries the rows one by one in savepoints and names the refused', async () => {
      const { tx, statements } = fakeTx();
      const whole = jest.fn().mockRejectedValue(prismaError('P2002'));
      const one = jest.fn((id: string) => (id === B ? Promise.reject(prismaError('P2002')) : Promise.resolve({ id })));
      const refused = await writeAll(tx, [A, B, C], whole, one);
      expect(refused).toEqual([
        { id: B, code: BULK_ROW_TAKEN, message: 'Raden skulle krocka med en annan rad som redan har samma värden.' },
      ] satisfies BulkRefusal[]);
      expect(one.mock.calls.map((call) => call[0])).toEqual([A, B, C]);
      expect(statements).toEqual([
        'SAVEPOINT bulk_whole',
        'ROLLBACK TO SAVEPOINT bulk_whole',
        'SAVEPOINT bulk_row',
        'RELEASE SAVEPOINT bulk_row',
        'SAVEPOINT bulk_row',
        'ROLLBACK TO SAVEPOINT bulk_row',
        'SAVEPOINT bulk_row',
        'RELEASE SAVEPOINT bulk_row',
      ]);
    });

    it('tries the rows one by one when the whole wrote fewer than it named, and refuses the one not found', async () => {
      // B deleted by another request since it was read, or not the caller's to write under RLS.
      const { tx, statements } = fakeTx();
      const whole = jest.fn().mockResolvedValue({ count: 2 });
      const one = jest.fn((id: string) => (id === B ? Promise.reject(prismaError('P2025')) : Promise.resolve({ id })));
      const refused = await writeAll(tx, [A, B, C], whole, one);
      expect(refused).toEqual([{ id: B, code: BULK_ROW_NOT_FOUND, message: NOT_FOUND }]);
      expect(statements.slice(0, 2)).toEqual(['SAVEPOINT bulk_whole', 'ROLLBACK TO SAVEPOINT bulk_whole']);
      expect(one).toHaveBeenCalledTimes(3);
    });

    it('writes every row one by one when a short whole finds them all after all', async () => {
      const { tx } = fakeTx();
      const one = jest.fn().mockResolvedValue({});
      await expect(writeAll(tx, [A, B], jest.fn().mockResolvedValue({ count: 1 }), one)).resolves.toEqual([]);
      expect(one).toHaveBeenCalledTimes(2);
    });

    it('rethrows the whole statement\'s error when every row passes alone', async () => {
      const { tx } = fakeTx();
      const error = prismaError('P2002');
      await expect(
        writeAll(tx, [A, B], jest.fn().mockRejectedValue(error), jest.fn().mockResolvedValue({})),
      ).rejects.toBe(error);
    });

    it('rethrows an error that is no refusal of a row, without trying the rows', async () => {
      const { tx } = fakeTx();
      const one = jest.fn();
      const error = new Error('connection reset');
      await expect(writeAll(tx, [A], jest.fn().mockRejectedValue(error), one)).rejects.toBe(error);
      expect(one).not.toHaveBeenCalled();
    });

    it("rethrows a row's error that is no refusal (a deadlock), rather than listing it", async () => {
      const { tx } = fakeTx();
      const conflict = writeConflict();
      await expect(
        writeAll(tx, [A, B], jest.fn().mockRejectedValue(prismaError('P2002')), jest.fn().mockRejectedValue(conflict)),
      ).rejects.toBe(conflict);
    });
  });

  describe('runBulk', () => {
    /** A transaction stand-in: the callback's result is committed unless it throws. */
    const transaction = () => {
      const committed: unknown[] = [];
      const run = async <T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> => {
        const result = await fn({} as PrismaClient);
        committed.push(result);
        return result;
      };
      return { run, committed };
    };

    it('commits a call with no refusal and says it was applied', async () => {
      const { run, committed } = transaction();
      const result = await runBulk(run, false, async () => ({ done: [A, B], refused: [] }));
      expect(result).toEqual({ applied: true, dryRun: false, done: [A, B], refused: [] });
      expect(committed).toHaveLength(1);
    });

    it('rolls a call with a refusal back and answers the report, nothing applied', async () => {
      const { run, committed } = transaction();
      const refused = [notFound(B)];
      const result = await runBulk(run, false, async () => ({ done: [A], refused }));
      expect(result).toEqual({ applied: false, dryRun: false, done: [A], refused });
      expect(committed).toEqual([]);
    });

    it('rolls a dry run back with its consequences in the report', async () => {
      const { run, committed } = transaction();
      const result = await runBulk(run, true, async () => ({ done: [A], refused: [], consequences: { halves: 2 } }));
      expect(result).toEqual({ applied: false, dryRun: true, done: [A], refused: [], consequences: { halves: 2 } });
      expect(committed).toEqual([]);
    });

    it('fails the call on anything else the work throws', async () => {
      const { run } = transaction();
      const error = new BadRequestException('replacesSubjectId: ämnet finns inte i skolan.');
      await expect(runBulk(run, false, async () => Promise.reject(error))).rejects.toBe(error);
    });
  });
});
