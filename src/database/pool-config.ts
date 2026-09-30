import { Logger } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import type { PoolConfig } from 'pg';
import { PrismaPgWithEndedTransactionGuard } from './ended-transaction-guard';

/**
 * The API's connection pool, read from DATABASE_URL.
 *
 * ## Why the URL still sizes the pool
 *
 * Prisma 5's engine read `connection_limit`, `pool_timeout` and `schema` out of
 * the connection string. Under @prisma/adapter-pg the pool is pg's, and pg
 * reads none of them: left alone it opens up to 10 connections and lets a
 * request wait for one forever. That would shrink the latency stack's 25
 * (docker-compose.yml) and grow the documented production 1
 * (docs/DEPLOYMENT.md §3) without anyone deciding either. So the parameters
 * keep their Prisma 5 meaning here, and the URL goes to pg untouched:
 *
 *   connection_limit → max                      absent: pg's default, 10
 *   pool_timeout     → connectionTimeoutMillis  seconds; absent: 10; 0: no limit
 *   schema           → the adapter's schema     absent: public
 *   idleTimeoutMillis 300 s                     Prisma 5's idle lifetime
 *
 * `pgbouncer=true` is inert now. pg sends every statement unnamed, which is
 * what a transaction-mode pooler needs, so nothing here may set
 * `statementNameGenerator`: a named statement lives on one server connection,
 * and the pooler hands the next transaction another.
 *
 * ## Why query_timeout refuses to boot
 *
 * pg honours `query_timeout` straight from the URL, over anything configured
 * here. When that timer fires on a COMMIT or ROLLBACK still queued behind a
 * slow statement, pg drops it unsent, and the client goes back to the pool
 * inside an open transaction, carrying the previous request's `set_config`
 * claims for the next request to run under. A missing claim fails closed; that
 * one fails open, so the setting is refused rather than tolerated.
 */
export interface PgAdapterSettings {
  pool: Pick<
    PoolConfig,
    'connectionString' | 'max' | 'connectionTimeoutMillis' | 'idleTimeoutMillis'
  >;
  schema: string;
}

/** Prisma 5's `pool_timeout` default, in seconds. */
const DEFAULT_POOL_TIMEOUT_SECONDS = 10;

/** Prisma 5's `max_idle_connection_lifetime`. */
const IDLE_TIMEOUT_MILLIS = 300_000;

export function pgAdapterSettings(databaseUrl: string | undefined): PgAdapterSettings {
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is not set, so there is no database to build the connection pool for.',
    );
  }

  // Only the query string is parsed. `new URL` would have to understand the
  // whole string, and a password with a character it rejects would then stop
  // the API booting over nothing the pool needs.
  const queryStart = databaseUrl.indexOf('?');
  const params = new URLSearchParams(
    queryStart === -1 ? '' : databaseUrl.slice(queryStart + 1),
  );

  if (params.has('query_timeout')) {
    throw new Error(
      'Refusing to start: DATABASE_URL sets query_timeout. pg would enforce it ' +
        'client-side, and a timer that drops a queued COMMIT or ROLLBACK returns ' +
        'a connection to the pool inside a transaction, with one request\'s ' +
        'row-level-security claims still set for the next. Remove the parameter ' +
        '(see src/database/pool-config.ts).',
    );
  }

  const connectionLimit = params.get('connection_limit');
  const poolTimeout = params.get('pool_timeout');

  return {
    pool: {
      connectionString: databaseUrl,
      ...(connectionLimit === null
        ? {}
        : { max: wholeNumber('connection_limit', connectionLimit, 1) }),
      connectionTimeoutMillis:
        (poolTimeout === null
          ? DEFAULT_POOL_TIMEOUT_SECONDS
          : wholeNumber('pool_timeout', poolTimeout, 0)) * 1000,
      idleTimeoutMillis: IDLE_TIMEOUT_MILLIS,
    },
    schema: params.get('schema') ?? 'public',
  };
}

/** The value is not echoed: an operator's URL is not something to log. */
function wholeNumber(name: string, value: string, min: number): number {
  const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!(parsed >= min)) {
    throw new Error(
      `DATABASE_URL sets ${name} to something other than a whole number of at least ${min}.`,
    );
  }
  return parsed;
}

const logger = new Logger('DatabasePool');

/**
 * Where the adapter reports a connection that fails.
 *
 * Without these it tells only its `debug` channel, so a pooler restart or a
 * reset socket under an idle or in-transaction connection would leave nothing
 * in the API's log. pg's message can name the host and the user, so the line
 * is fixed text plus the error code, and nothing else of the error.
 */
export const poolErrorLogging = {
  onPoolError(error: Error): void {
    logger.error(
      `An idle pooled database connection failed and left the pool (code: ${errorCode(error)}).`,
    );
  },
  onConnectionError(error: Error): void {
    logger.error(
      `A database connection failed while it held a transaction (code: ${errorCode(error)}).`,
    );
  },
};

/** A Node or SQLSTATE code, or `none` for anything that does not look like one. */
function errorCode(error: Error): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(code)
    ? code
    : 'none';
}

/**
 * The driver adapter PrismaClient needs. Nothing connects until first use.
 *
 * It is PrismaPg with ended-transaction-guard.ts around every transaction: a
 * transaction that times out mid-plan would otherwise keep sending statements
 * on a connection the pool has lent to the next request.
 */
export function createPgAdapter(databaseUrl: string | undefined): PrismaPg {
  const { pool, schema } = pgAdapterSettings(databaseUrl);
  return new PrismaPgWithEndedTransactionGuard(pool, { schema, ...poolErrorLogging });
}
