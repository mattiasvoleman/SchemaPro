import { Logger } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { createPgAdapter, pgAdapterSettings, poolErrorLogging } from './pool-config';

/** docker-compose.yml's API connection, which the latency gate sizes at 25. */
const COMPOSE_URL =
  'postgresql://app_authenticated:app_authenticated_local@db:5432/schemapro?schema=public&connection_limit=25';

/** The Supabase pooler string docs/DEPLOYMENT.md §3 documents. */
const PRODUCTION_SHAPED_URL =
  'postgresql://app_authenticated.abcdefgh:s3cret-password@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?schema=public&pgbouncer=true&connection_limit=1';

const BARE_URL = 'postgresql://app_authenticated:s3cret-password@db:5432/schemapro';

/**
 * Exact objects throughout. The pool options are the whole contract with pg,
 * and an assertion that only looks for the keys it knows would keep passing
 * while something like a client-side query timeout was added beside them.
 */
describe('pgAdapterSettings', () => {
  it('sizes the pool from connection_limit and keeps Prisma 5’s timeouts', () => {
    expect(pgAdapterSettings(COMPOSE_URL)).toEqual({
      pool: {
        connectionString: COMPOSE_URL,
        max: 25,
        connectionTimeoutMillis: 10_000,
        idleTimeoutMillis: 300_000,
      },
      schema: 'public',
    });
  });

  it('keeps the documented production pool at one connection', () => {
    expect(pgAdapterSettings(PRODUCTION_SHAPED_URL)).toEqual({
      pool: {
        connectionString: PRODUCTION_SHAPED_URL,
        max: 1,
        connectionTimeoutMillis: 10_000,
        idleTimeoutMillis: 300_000,
      },
      schema: 'public',
    });
  });

  it('leaves the pool size to pg when the URL sets no connection_limit', () => {
    const settings = pgAdapterSettings(BARE_URL);

    expect(settings).toEqual({
      pool: {
        connectionString: BARE_URL,
        connectionTimeoutMillis: 10_000,
        idleTimeoutMillis: 300_000,
      },
      schema: 'public',
    });
    // toEqual treats an undefined property as absent; pg does not, since
    // `max: undefined` would still be spread over its defaults.
    expect(Object.keys(settings.pool)).not.toContain('max');
  });

  it('reads pool_timeout in seconds', () => {
    expect(
      pgAdapterSettings(`${BARE_URL}?pool_timeout=30`).pool.connectionTimeoutMillis,
    ).toBe(30_000);
  });

  it('keeps pool_timeout=0 meaning no limit, as it did in Prisma 5', () => {
    expect(
      pgAdapterSettings(`${BARE_URL}?pool_timeout=0`).pool.connectionTimeoutMillis,
    ).toBe(0);
  });

  it('uses the schema the URL names', () => {
    expect(pgAdapterSettings(`${BARE_URL}?schema=other`).schema).toBe('other');
  });

  describe('refuses', () => {
    it('a URL that sets query_timeout, and says why', () => {
      expect(() => pgAdapterSettings(`${COMPOSE_URL}&query_timeout=1000`)).toThrow(
        /^Refusing to start: DATABASE_URL sets query_timeout\..*row-level-security claims still set for the next\./s,
      );
    });

    it.each([undefined, ''])('a missing DATABASE_URL (%p)', (url) => {
      expect(() => pgAdapterSettings(url)).toThrow(
        'DATABASE_URL is not set, so there is no database to build the connection pool for.',
      );
    });

    it.each(['0', 'abc', '2.5', '-3', ''])('connection_limit=%p', (value) => {
      expect(() => pgAdapterSettings(`${BARE_URL}?connection_limit=${value}`)).toThrow(
        'DATABASE_URL sets connection_limit to something other than a whole number of at least 1.',
      );
    });

    it.each(['-1', 'ten', '1.5'])('pool_timeout=%p', (value) => {
      expect(() => pgAdapterSettings(`${BARE_URL}?pool_timeout=${value}`)).toThrow(
        'DATABASE_URL sets pool_timeout to something other than a whole number of at least 0.',
      );
    });

    it('without repeating the URL, which carries the password', () => {
      for (const url of [
        `${BARE_URL}?connection_limit=0`,
        `${BARE_URL}?pool_timeout=-1`,
        `${BARE_URL}?query_timeout=1`,
      ]) {
        expect(() => pgAdapterSettings(url)).toThrow(
          expect.objectContaining({
            message: expect.not.stringContaining('s3cret-password'),
          }),
        );
      }
    });
  });
});

describe('createPgAdapter', () => {
  let logError: jest.SpyInstance;

  beforeEach(() => {
    logError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logError.mockRestore();
  });

  /** An error the way pg raises one: a code, and a message naming the server. */
  const pgError = (code: unknown) =>
    Object.assign(
      new Error('connection to db:5432 as app_authenticated terminated unexpectedly'),
      { code },
    );

  it('builds a PrismaPg adapter without connecting', () => {
    expect(createPgAdapter(COMPOSE_URL)).toBeInstanceOf(PrismaPg);
  });

  it('refuses what the settings refuse', () => {
    expect(() => createPgAdapter(`${COMPOSE_URL}&query_timeout=1`)).toThrow(
      /query_timeout/,
    );
  });

  it('logs an idle pooled connection’s failure by code, never by pg’s message', async () => {
    // connect() builds the pg.Pool, which opens nothing until a query asks.
    const driver = await createPgAdapter(COMPOSE_URL).connect();
    try {
      driver.underlyingDriver().emit('error', pgError('ECONNRESET'));
    } finally {
      await driver.dispose();
    }

    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith(
      'An idle pooled database connection failed and left the pool (code: ECONNRESET).',
    );
  });

  it('hands the adapter the transaction-connection logger too', () => {
    // The adapter attaches this to a connection only once a transaction holds
    // one, which takes a live server; what can be pinned without one is that
    // the adapter was given it.
    const adapter = createPgAdapter(COMPOSE_URL) as unknown as {
      options: { schema: string; onConnectionError: unknown; onPoolError: unknown };
    };

    expect(adapter.options).toEqual({
      schema: 'public',
      onPoolError: poolErrorLogging.onPoolError,
      onConnectionError: poolErrorLogging.onConnectionError,
    });
  });

  it('logs a transaction connection’s failure by code, never by pg’s message', () => {
    poolErrorLogging.onConnectionError(pgError('57P01'));

    expect(logError).toHaveBeenCalledWith(
      'A database connection failed while it held a transaction (code: 57P01).',
    );
  });

  it.each([undefined, 57, 'not a code; DROP', ''])(
    'writes none for a code that is not one (%p)',
    (code) => {
      poolErrorLogging.onPoolError(pgError(code));

      expect(logError).toHaveBeenCalledWith(
        'An idle pooled database connection failed and left the pool (code: none).',
      );
    },
  );
});
