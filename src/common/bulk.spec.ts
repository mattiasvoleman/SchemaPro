import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  BULK_BUSY,
  BULK_ROW_NOT_FOUND,
  BULK_ROW_REFERENCE_GONE,
  BULK_ROW_TAKEN,
  BULK_TIMED_OUT,
  BULK_TIMEOUT_MS,
  assertSomeChange,
  bulkTransaction,
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

describe('bulkTransaction', () => {
  /** A withRls that runs `fn` on a transaction whose statements are kept, or fails with `failure`. */
  const withRls = (failure?: unknown) => {
    const sent: string[] = [];
    const tx = {
      $executeRaw: jest.fn((strings: readonly string[], ...values: unknown[]) => {
        sent.push(`${strings.join('?')} ${JSON.stringify(values)}`);
        return Promise.resolve(1);
      }),
    } as unknown as PrismaClient;
    const withRlsMock = jest.fn(async (_user: unknown, fn: (tx: PrismaClient) => Promise<unknown>) => {
      const result = await fn(tx);
      if (failure) throw failure;
      return result;
    });
    const prisma = { withRls: withRlsMock } as unknown as Parameters<typeof bulkTransaction<string>>[0] & {
      withRls: typeof withRlsMock;
    };
    return { prisma, sent };
  };
  const driverError = (originalCode: string) =>
    new Prisma.PrismaClientKnownRequestError('Raw query failed.', {
      code: 'P2010',
      clientVersion: 'test',
      meta: { driverAdapterError: { cause: { originalCode } } },
    });

  it("runs in withRls with the bulk timeout, and gives the database's statements the same", async () => {
    const { prisma, sent } = withRls();

    await expect(bulkTransaction(prisma, 'user')(() => Promise.resolve('done'))).resolves.toBe('done');

    expect(prisma.withRls).toHaveBeenCalledWith('user', expect.any(Function), { timeoutMs: BULK_TIMEOUT_MS });
    expect(sent).toEqual([`SELECT set_config('statement_timeout', ?, true) ["${BULK_TIMEOUT_MS}"]`]);
  });

  // Prisma's own sentences for its P2028s (TransactionManagerError), as 7.10 writes them.
  const transactionError = (message: string) =>
    new Prisma.PrismaClientKnownRequestError(`Transaction API error: ${message}`, {
      code: 'P2028',
      clientVersion: Prisma.prismaVersion.client,
    });
  const expired = transactionError(
    `A query cannot be executed on an expired transaction. The timeout for this transaction was ${BULK_TIMEOUT_MS} ms, however ${BULK_TIMEOUT_MS + 12} ms passed since the start of the transaction. Consider increasing the interactive transaction timeout or doing less work in the transaction.`,
  );
  const rolledBack = transactionError(
    'Transaction already closed: A query cannot be executed on a transaction that was rolled back.',
  );
  const neverStarted = transactionError('Unable to start a transaction in the given time.');

  it.each([
    ['Prisma’s expired transaction (P2028)', expired],
    ['a query after Prisma rolled the expired transaction back (P2028)', rolledBack],
    ['a P2028 of any other sentence', prismaError('P2028')],
    ['the statement the database cancelled (57014)', driverError('57014')],
  ])('answers %s as 409 BULK_TIMED_OUT: nothing written, fewer at a time', async (_what, failure) => {
    const { prisma } = withRls(failure);

    const error = await bulkTransaction(prisma, 'user')(() => Promise.resolve(null)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: BULK_TIMED_OUT,
      message: expect.stringContaining('ingenting sparades'),
    });
  });

  it('answers a transaction that never started, the pool full for maxWait, as 503 BULK_BUSY: nothing written, try again soon', async () => {
    const { prisma } = withRls(neverStarted);

    const error = await bulkTransaction(prisma, 'user')(() => Promise.resolve(null)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    const response = (error as ServiceUnavailableException).getResponse() as { code: string; message: string };
    expect(response).toMatchObject({ code: BULK_BUSY, message: expect.stringContaining('ingenting sparades') });
    expect(response.message).toContain('om en stund');
    expect(response.message).not.toContain('färre');
  });

  it('passes any other failure on as it is: a deadlock, another driver error', async () => {
    for (const failure of [prismaError('P2034'), driverError('40P01'), new Error('connection reset')]) {
      const { prisma } = withRls(failure);
      await expect(bulkTransaction(prisma, 'user')(() => Promise.resolve(null))).rejects.toBe(failure);
    }
  });
});
