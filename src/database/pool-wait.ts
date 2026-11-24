import { Prisma } from '@prisma/client';

/** The `code` of the 503 a request gets when no connection came free in time. */
export const DATABASE_BUSY = 'DATABASE_BUSY';

/**
 * Prisma's message for a transaction that found no connection within its
 * maxWait (TransactionManagerError, P2028). Every other P2028 is a transaction
 * that started and then expired or was closed by its timeout.
 */
export const NEVER_STARTED = 'Unable to start a transaction in the given time';

/**
 * pg-pool's own message when its wait for a connection ends first
 * (`connectionTimeoutMillis`, pool-config.ts: the URL's `pool_timeout`, 10 s
 * unless set). It is a plain Error, not a Prisma one, which is why the
 * exception filter used to answer it as the unexpected error it is not.
 */
const PG_CONNECT_TIMEOUT = 'timeout exceeded when trying to connect';

/**
 * Whether `error` is the pool saying it has no connection for the caller: the
 * transaction never started, so nothing ran and nothing was written, and a
 * second try in a moment is as safe as the first.
 *
 * That is a busy server and not a bug, and it is answered as one: a 503
 * DATABASE_BUSY, not a 500 (http-exception.filter.ts). Either wait can end
 * first, Prisma's (PrismaService's CONNECTION_WAIT_MS) or pg's own, and the
 * two read alike here.
 */
export function isPoolBusy(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === 'P2028' && error.message.includes(NEVER_STARTED);
  }
  return error instanceof Error && error.message === PG_CONNECT_TIMEOUT;
}
