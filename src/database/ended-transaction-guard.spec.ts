import { Logger } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import {
  PrismaPgWithEndedTransactionGuard,
  REFUSED_STATEMENT_MESSAGE,
} from './ended-transaction-guard';

/**
 * The guard is driven through the real adapter: a real pg.Pool whose connect()
 * hands out a fake connection, a real PrismaPg adapter and a real PgTransaction.
 * What is faked is only the server, so these tests also pin the adapter
 * internals the guard reaches into (the connection and its cleanup).
 */
function fakeConnection() {
  const sent: string[] = [];
  const failing = new Set<string>();
  const held = new Map<string, Promise<void>>();

  const connection = {
    sent,
    /** The next statement with this text is rejected the way pg rejects one. */
    fail: (sql: string) => failing.add(sql),
    /** Statements with this text stay unanswered until the returned function runs. */
    hold: (sql: string): (() => void) => {
      let answer: () => void = () => undefined;
      held.set(sql, new Promise<void>((resolve) => (answer = resolve)));
      return () => answer();
    },
    query: jest.fn(async ({ text }: { text: string }) => {
      sent.push(text);
      await held.get(text);
      if (failing.delete(text)) {
        throw Object.assign(new Error('terminating connection due to administrator command'), {
          code: '57P01',
          severity: 'FATAL',
        });
      }
      return { fields: [], rows: [], rowCount: 0 };
    }),
    release: jest.fn(),
    on: jest.fn(),
    removeListener: jest.fn(),
  };
  return connection;
}

const statement = (sql: string) => ({ sql, args: [], argTypes: [] });

async function openTransaction(isolationLevel?: 'SERIALIZABLE') {
  const connection = fakeConnection();
  const pool = new Pool();
  (pool as unknown as { connect: () => Promise<unknown> }).connect = async () => connection;
  const adapter = await new PrismaPgWithEndedTransactionGuard(pool).connect();
  const transaction = await adapter.startTransaction(isolationLevel);
  return { connection, pool, adapter, transaction };
}

describe('PrismaPgWithEndedTransactionGuard', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('is still the pg adapter, over the pool it was given', async () => {
    const { pool, adapter } = await openTransaction();

    expect(new PrismaPgWithEndedTransactionGuard(pool)).toBeInstanceOf(PrismaPg);
    expect(adapter.underlyingDriver()).toBe(pool);
  });

  it('opens the transaction as the adapter does, isolation level included', async () => {
    const { connection } = await openTransaction('SERIALIZABLE');

    expect(connection.sent).toEqual(['BEGIN', 'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE']);
  });

  it.each(['COMMIT', 'ROLLBACK', ' rollback '])(
    'sends statements until %p, and not one after it',
    async (end) => {
      const { connection, transaction } = await openTransaction();

      await transaction.queryRaw(statement('SELECT 1'));
      await transaction.executeRaw(statement('UPDATE "Rooms" SET name = name'));
      await transaction.executeRaw(statement(end));

      await expect(transaction.queryRaw(statement('SELECT 2'))).rejects.toThrow(
        REFUSED_STATEMENT_MESSAGE,
      );
      await expect(
        transaction.executeRaw(statement('DELETE FROM "RoomBookings"')),
      ).rejects.toThrow(REFUSED_STATEMENT_MESSAGE);
      expect(connection.sent).toEqual([
        'BEGIN',
        'SELECT 1',
        'UPDATE "Rooms" SET name = name',
        end,
      ]);
    },
  );

  it('counts an end sent through queryRaw as an end too', async () => {
    const { connection, transaction } = await openTransaction();

    await transaction.queryRaw(statement('COMMIT'));

    await expect(transaction.queryRaw(statement('SELECT 1'))).rejects.toThrow(
      REFUSED_STATEMENT_MESSAGE,
    );
    expect(connection.sent).toEqual(['BEGIN', 'COMMIT']);
  });

  it('refuses from the moment ROLLBACK is sent, before the server answers it', async () => {
    const { connection, transaction } = await openTransaction();
    const answerRollback = await connection.hold('ROLLBACK');

    const rollback = transaction.executeRaw(statement('ROLLBACK'));
    const late = transaction.executeRaw(statement('UPDATE "RoomBookings" SET title = title'));

    await expect(late).rejects.toThrow(REFUSED_STATEMENT_MESSAGE);
    answerRollback();
    await expect(rollback).resolves.toBe(0);
    expect(connection.sent).toEqual(['BEGIN', 'ROLLBACK']);
  });

  it('lets savepoints and statements merely ending in the word through', async () => {
    const { connection, transaction } = await openTransaction();

    await transaction.createSavepoint?.('prisma_sp_0');
    await transaction.rollbackToSavepoint?.('prisma_sp_0');
    await transaction.releaseSavepoint?.('prisma_sp_0');
    await transaction.queryRaw(statement('SELECT true AS rollback'));
    await transaction.queryRaw(statement('SELECT 1'));

    expect(connection.sent).toEqual([
      'BEGIN',
      'SAVEPOINT prisma_sp_0',
      'ROLLBACK TO SAVEPOINT prisma_sp_0',
      'RELEASE SAVEPOINT prisma_sp_0',
      'SELECT true AS rollback',
      'SELECT 1',
    ]);
  });

  it.each(['commit', 'rollback'] as const)(
    'returns the connection for reuse on %s() after an answered end',
    async (method) => {
      const { connection, transaction } = await openTransaction();

      await transaction.executeRaw(statement(method === 'commit' ? 'COMMIT' : 'ROLLBACK'));
      await transaction[method]();

      expect(connection.release.mock.calls).toEqual([[undefined]]);
      // The adapter's cleanup: its error listener comes off the connection.
      expect(connection.removeListener).toHaveBeenCalledWith(
        'error',
        connection.on.mock.calls[0][1],
      );
    },
  );

  it('has the pool destroy a connection whose COMMIT failed', async () => {
    const { connection, transaction } = await openTransaction();
    connection.fail('COMMIT');

    await expect(transaction.executeRaw(statement('COMMIT'))).rejects.toThrow();
    // Prisma's transaction manager answers a failed COMMIT with rollback().
    await transaction.rollback();

    expect(connection.release).toHaveBeenCalledTimes(1);
    expect(connection.release.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it.each(['commit', 'rollback'] as const)(
    'has the pool destroy a connection released by %s() with no end sent, and refuses after',
    async (method) => {
      const { connection, transaction } = await openTransaction();

      await transaction[method]();

      expect(connection.release.mock.calls[0][0]).toEqual(
        new Error('The transaction was released without a COMMIT or ROLLBACK the server answered.'),
      );
      await expect(transaction.queryRaw(statement('SELECT 1'))).rejects.toThrow(
        REFUSED_STATEMENT_MESSAGE,
      );
      expect(connection.sent).toEqual(['BEGIN']);
    },
  );

  it('logs a refusal once per transaction, as fixed text', async () => {
    const { transaction } = await openTransaction();
    await transaction.executeRaw(statement('ROLLBACK'));

    await expect(transaction.queryRaw(statement('SELECT 1'))).rejects.toThrow();
    await expect(transaction.queryRaw(statement('SELECT 2'))).rejects.toThrow();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'A statement arrived after its transaction had ended, most likely from a query ' +
        'still running when the transaction timed out, and was refused.',
    );
  });

  it('keeps each transaction’s end to itself', async () => {
    const { adapter, connection, transaction } = await openTransaction();
    await transaction.executeRaw(statement('COMMIT'));

    const next = await adapter.startTransaction();
    await next.queryRaw(statement('SELECT 1'));

    expect(connection.sent).toEqual(['BEGIN', 'COMMIT', 'BEGIN', 'SELECT 1']);
    expect(warn).not.toHaveBeenCalled();
  });
});
