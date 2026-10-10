// NodeEnv lives beside decorated classes whose metadata needs the polyfill;
// Nest's bootstrap normally loads it first.
import 'reflect-metadata';
import { loadConfiguration } from './configuration';
import { NodeEnv, type EnvironmentVariables } from './env.validation';

/*
 * loadConfiguration is the only reader of the environment. What it gets wrong
 * is wrong everywhere at once: the HTTP server and the socket gateway both read
 * `corsOrigins`, and the JWT strategy fetches its signing keys from `jwksUri`.
 */

/** An environment as validateEnv hands it over, with every optional left unset. */
const env = (overrides: Partial<EnvironmentVariables> = {}): EnvironmentVariables =>
  ({
    NODE_ENV: NodeEnv.Production,
    PORT: 4000,
    DATABASE_URL: 'postgresql://user:pass@db.invalid:5432/schemapro',
    JWT_SECRET: 'a-secret-long-enough-to-be-plausible-0000',
    JWT_ISSUER: 'https://project.supabase.invalid/auth/v1',
    AI_ENGINE_URL: 'http://solver:8000',
    AI_ENGINE_API_KEY: 'a-key-long-enough-to-be-plausible-000000',
    AI_ENGINE_TIMEOUT_MS: 15000,
    THROTTLE_TTL_SECONDS: 60,
    THROTTLE_LIMIT: 120,
    ...overrides,
  }) as EnvironmentVariables;

describe('loadConfiguration', () => {
  it('puts every variable where its consumer reads it', () => {
    // Every optional set, so an emptied branch of the tree cannot pass as a
    // run of undefined values.
    const config = loadConfiguration(
      env({
        CORS_ORIGINS: 'https://app.schemapro.example',
        JWT_AUDIENCE: 'authenticated',
        REDIS_URL: 'redis://cache:6379',
        SUPABASE_URL: 'https://project.supabase.invalid',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-000000',
      }),
    );

    expect(config).toEqual({
      app: {
        nodeEnv: NodeEnv.Production,
        port: 4000,
        corsOrigins: ['https://app.schemapro.example'],
      },
      database: { url: 'postgresql://user:pass@db.invalid:5432/schemapro' },
      jwt: {
        secret: 'a-secret-long-enough-to-be-plausible-0000',
        issuer: 'https://project.supabase.invalid/auth/v1',
        jwksUri: 'https://project.supabase.invalid/auth/v1/.well-known/jwks.json',
        audience: 'authenticated',
      },
      aiEngine: {
        baseUrl: 'http://solver:8000',
        apiKey: 'a-key-long-enough-to-be-plausible-000000',
        timeoutMs: 15000,
      },
      throttle: { ttlSeconds: 60, limit: 120, redisUrl: 'redis://cache:6379' },
      supabase: {
        url: 'https://project.supabase.invalid',
        serviceRoleKey: 'service-role-key-000000',
      },
      // Unset: the viewer trusts no forwarded address.
      publicViewer: { proxyKey: undefined },
    });
  });

  it('carries the public viewer\'s proxy key when it is set, and treats an empty one as unset', () => {
    const key = 'k'.repeat(40);
    expect(loadConfiguration(env({ PUBLIC_VIEWER_PROXY_KEY: key })).publicViewer).toEqual({ proxyKey: key });
    expect(loadConfiguration(env({ PUBLIC_VIEWER_PROXY_KEY: '' })).publicViewer).toEqual({ proxyKey: undefined });
  });

  describe('corsOrigins', () => {
    it('is empty when CORS_ORIGINS is unset, which allows no browser origin', () => {
      expect(loadConfiguration(env()).app.corsOrigins).toEqual([]);
    });

    it('splits the list and trims the space typed after each comma', () => {
      const { corsOrigins } = loadConfiguration(
        env({
          CORS_ORIGINS: 'https://app.schemapro.example, https://admin.schemapro.example',
        }),
      ).app;

      expect(corsOrigins).toEqual([
        'https://app.schemapro.example',
        'https://admin.schemapro.example',
      ]);
    });

    it('drops the empty entries a doubled or trailing comma leaves', () => {
      // An empty string in the allowlist is not harmless: the adapter and
      // main.ts read a non-empty list as "CORS is on".
      const { corsOrigins } = loadConfiguration(
        env({ CORS_ORIGINS: 'https://a.example,, https://b.example ,' }),
      ).app;

      expect(corsOrigins).toEqual(['https://a.example', 'https://b.example']);
    });

    it('reads a list of nothing but blanks as no allowlist at all', () => {
      expect(
        loadConfiguration(env({ CORS_ORIGINS: ' , ' })).app.corsOrigins,
      ).toEqual([]);
    });
  });

  describe('jwksUri', () => {
    it('strips a trailing slash off the issuer rather than doubling it', () => {
      expect(
        loadConfiguration(env({ JWT_ISSUER: 'https://project.supabase.invalid/auth/v1/' }))
          .jwt.jwksUri,
      ).toBe('https://project.supabase.invalid/auth/v1/.well-known/jwks.json');
    });

    it('strips every trailing slash, not only the last one', () => {
      expect(
        loadConfiguration(env({ JWT_ISSUER: 'https://project.supabase.invalid/auth/v1///' }))
          .jwt.jwksUri,
      ).toBe('https://project.supabase.invalid/auth/v1/.well-known/jwks.json');
    });
  });

  describe('redisUrl', () => {
    it('is absent when REDIS_URL is unset', () => {
      expect(loadConfiguration(env()).throttle.redisUrl).toBeUndefined();
    });

    it('treats an empty REDIS_URL as unset, which is what `REDIS_URL=` in a compose file sends', () => {
      const { throttle } = loadConfiguration(env({ REDIS_URL: '' }));

      expect(throttle).toHaveProperty('redisUrl', undefined);
    });
  });
});
