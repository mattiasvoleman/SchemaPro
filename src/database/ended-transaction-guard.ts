import { Logger } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

type PgDriverAdapter = Awaited<ReturnType<PrismaPg['connect']>>;
type PgTransaction = Awaited<ReturnType<PgDriverAdapter['startTransaction']>>;
type SqlQuery = Parameters<PgTransaction['queryRaw']>[0];

/**
 * What @prisma/adapter-pg 7.10's PgTransaction keeps of its pool connection.
 * Both are internal; ended-transaction-guard.spec.ts drives the real class, so
 * an adapter release that renames them fails there and not in production.
 */
interface PgTransactionInternals {
  client: { release(error?: Error): void };
  cleanup?: () => void;
}

/** The statements Prisma's transaction manager ends a transaction with. */
const END_OF_TRANSACTION = /^\s*(?:COMMIT|ROLLBACK)\s*$/i;

export const REFUSED_STATEMENT_MESSAGE =
  'Statement refused: its transaction has already ended.';

const NOT_ENDED_MESSAGE =
  'The transaction was released without a COMMIT or ROLLBACK the server answered.';

const logger = new Logger('DatabasePool');

/**
 * PrismaPg, except that a transaction takes no statement after its end.
 *
 * ## The hole this closes
 *
 * adapter-pg's PgTransaction.commit() and rollback() hand the connection back
 * to pg's pool and mark nothing closed. Prisma's transaction timeout sends
 * ROLLBACK and calls rollback() without waiting for the query plan still
 * running inside the callback, and that plan keeps the transaction object. A
 * nested write is several statements, so it goes on sending them on a
 * connection the pool has already given to the next request: they run in that
 * request's transaction, under its claims, and its COMMIT commits them. The
 * next request sees nothing wrong. With the documented production pool of one
 * connection, the next request always gets exactly that connection. Prisma 5's
 * engine never did this; measured on a throwaway database, a timed-out nested
 * write reached the next transaction in every run under 7.10 and in none under
 * 5.22.
 *
 * ## What the guard does
 *
 * - From the moment COMMIT or ROLLBACK is sent, every further statement on the
 *   transaction is refused before it reaches pg. The flag goes up when the
 *   statement is sent, not when commit() or rollback() runs: pg queues in
 *   order, so a statement sent before the ROLLBACK still runs inside the
 *   transaction, and one sent between the ROLLBACK and the release would run
 *   in whatever transaction comes next.
 * - A connection whose COMMIT or ROLLBACK never got an answer from the server
 *   goes back with an error, which makes pg-pool destroy it instead of lending
 *   out a connection that may still be inside a transaction.
 *
 * A timed-out request already fails; the refusal only changes which error it
 * fails with. Savepoints (`ROLLBACK TO SAVEPOINT ...`) do not end anything
 * and pass.
 */
export class PrismaPgWithEndedTransactionGuard extends PrismaPg {
  override async connect(): Promise<PgDriverAdapter> {
    const adapter = await super.connect();
    const startTransaction = adapter.startTransaction.bind(adapter);
    adapter.startTransaction = async (isolationLevel) =>
      guardEndedTransaction(await startTransaction(isolationLevel));
    return adapter;
  }
}

export function guardEndedTransaction(transaction: PgTransaction): PgTransaction {
  const internals = transaction as unknown as PgTransactionInternals;
  let ended = false;
  let endAnswered = false;
  let refusalLogged = false;

  const refuse = (): Error => {
    if (!refusalLogged) {
      refusalLogged = true;
      logger.warn(
        'A statement arrived after its transaction had ended, most likely from a query ' +
          'still running when the transaction timed out, and was refused.',
      );
    }
    return new Error(REFUSED_STATEMENT_MESSAGE);
  };

  const guarded =
    <T>(send: (query: SqlQuery) => Promise<T>) =>
    async (query: SqlQuery): Promise<T> => {
      if (ended) throw refuse();
      if (!END_OF_TRANSACTION.test(query.sql)) return send(query);
      ended = true;
      const result = await send(query);
      endAnswered = true;
      return result;
    };

  transaction.queryRaw = guarded(transaction.queryRaw.bind(transaction));
  transaction.executeRaw = guarded(transaction.executeRaw.bind(transaction));

  const release = async (): Promise<void> => {
    ended = true;
    internals.cleanup?.();
    internals.client.release(endAnswered ? undefined : new Error(NOT_ENDED_MESSAGE));
  };
  transaction.commit = release;
  transaction.rollback = release;

  return transaction;
}
