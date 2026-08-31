// The decorators class-validator reads are emitted as metadata, and nothing
// else in this file pulls the polyfill in — Nest's own bootstrap normally does.
import 'reflect-metadata';
import { validateEnv } from './env.validation';

/*
 * The environment is the one input nothing else can guard.
 *
 * A bad value here does not fail a request, it fails the whole deployment —
 * usually much later, and usually somewhere that reads like a different bug.
 * `AI_ENGINE_URL` is the case that prompted these: it was validated as a
 * non-empty string, so the literal "undefined" — what an unset variable
 * interpolates to — passed, the app booted, and the first attempt to generate a
 * schedule answered "AI engine unavailable". Axios cannot parse
 * "undefined/v1/schedule" and throws a TypeError, which is neither a timeout
 * nor an AxiosError and falls through to the proxy's most generic message.
 * Nothing in it points at the URL, and the obvious next move — is the engine
 * up? — finds an engine that is perfectly healthy.
 */

/** The smallest environment that validates, so a test can break one thing. */
const valid = () => ({
  NODE_ENV: 'test',
  PORT: '4000',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  JWT_SECRET: 'a-secret-long-enough-to-be-plausible-0000',
  JWT_ISSUER: 'https://example.invalid/auth/v1',
  AI_ENGINE_URL: 'http://localhost:8000',
  AI_ENGINE_API_KEY: 'a-key-long-enough-to-be-plausible-000000',
  AI_ENGINE_TIMEOUT_MS: '15000',
  THROTTLE_TTL_SECONDS: '60',
  THROTTLE_LIMIT: '100',
});

describe('validateEnv', () => {
  it('accepts a complete environment', () => {
    expect(() => validateEnv(valid())).not.toThrow();
  });

  describe('AI_ENGINE_URL', () => {
    it.each([
      ['the literal string an unset variable interpolates to', 'undefined'],
      ['a bare host with no protocol', 'localhost:8000'],
      ['a path with no origin', '/v1/schedule'],
      ['a protocol the client cannot speak', 'ftp://engine:8000'],
      ['whitespace that survived a copy-paste', '  '],
    ])('refuses %s', (_label, value) => {
      expect(() => validateEnv({ ...valid(), AI_ENGINE_URL: value })).toThrow(
        /AI_ENGINE_URL/,
      );
    });

    it.each([
      ['localhost in development', 'http://localhost:8000'],
      ['a compose service name, which has no dot in it', 'http://solver:8000'],
      ['a real host over TLS', 'https://engine.schemapro.example'],
    ])('accepts %s', (_label, value) => {
      expect(() => validateEnv({ ...valid(), AI_ENGINE_URL: value })).not.toThrow();
    });
  });

  it('names the offending variable and never echoes its value', () => {
    // The message goes to a log an operator reads, and half of these variables
    // are secrets.
    const secret = 'sk-this-must-never-appear-in-any-log-0000';
    expect(() => validateEnv({ ...valid(), AI_ENGINE_API_KEY: '' , JWT_SECRET: secret }))
      .toThrow(/AI_ENGINE_API_KEY/);
    try {
      validateEnv({ ...valid(), AI_ENGINE_API_KEY: '', JWT_SECRET: secret });
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });
});
