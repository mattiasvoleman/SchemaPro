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

  it('refuses an environment missing required variables and names every one of them', () => {
    // A secret nobody copied into a new deployment is the commonest
    // misconfiguration there is; it must not be the one that boots.
    const incomplete: Record<string, unknown> = { ...valid() };
    delete incomplete['DATABASE_URL'];
    delete incomplete['JWT_SECRET'];

    expect(() => validateEnv(incomplete)).toThrow(
      'Invalid or missing environment variables: DATABASE_URL, JWT_SECRET. ' +
        'See .env.example for the required configuration.',
    );
  });

  describe('SS12000 consumer', () => {
    it.each([
      ['a 32-byte base64 key and its predecessor', { INTEGRATION_SECRETS_KEY: Buffer.alloc(32, 1).toString('base64'), INTEGRATION_SECRETS_KEY_PREVIOUS: Buffer.alloc(32, 2).toString('base64') }],
      ['the tick off', { SS12000_BACKGROUND: 'off' }],
      ['the loopback override under NODE_ENV=test', { NODE_ENV: 'test', SS12000_ALLOW_INSECURE_LOCAL: '1' }],
      ['empty values', { INTEGRATION_SECRETS_KEY: '', SS12000_ALLOW_INSECURE_LOCAL: '' }],
    ])('accepts %s', (_label, extra) => {
      expect(() => validateEnv({ ...valid(), ...extra })).not.toThrow();
    });

    it.each([
      ['a key of 16 bytes', { INTEGRATION_SECRETS_KEY: Buffer.alloc(16, 1).toString('base64') }, /INTEGRATION_SECRETS_KEY/],
      ['a key that is not base64', { INTEGRATION_SECRETS_KEY: 'x'.repeat(44) }, /INTEGRATION_SECRETS_KEY/],
      ['a tick mode it does not know', { SS12000_BACKGROUND: 'maybe' }, /SS12000_BACKGROUND/],
      ['the loopback override outside NODE_ENV=test', { NODE_ENV: 'production', SS12000_ALLOW_INSECURE_LOCAL: '1' }, /SS12000_ALLOW_INSECURE_LOCAL/],
    ])('refuses %s, naming it and never echoing the value', (_label, extra, name) => {
      let message = '';
      try {
        validateEnv({ ...valid(), ...extra });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(name);
      for (const value of Object.values(extra)) if (String(value).length > 4) expect(message).not.toContain(String(value));
    });
  });

  describe('push', () => {
    it('is off when nothing is set', () => {
      expect(validateEnv(valid()).PUSH_NOTIFICATIONS).toBe('off');
    });

    it.each([
      ['expo', { PUSH_NOTIFICATIONS: 'expo' }],
      ['an access token of twenty characters', { EXPO_ACCESS_TOKEN: 'x'.repeat(20) }],
      ['an https push URL', { EXPO_PUSH_API_URL: 'https://exp.host/--/api/v2/push' }],
      ['the empty values .env.example ships', { PUSH_NOTIFICATIONS: 'off', EXPO_ACCESS_TOKEN: '', EXPO_PUSH_API_URL: '' }],
    ])('accepts %s', (_label, extra) => {
      expect(() => validateEnv({ ...valid(), ...extra })).not.toThrow();
    });

    it.each([
      ['a mode it does not know', { PUSH_NOTIFICATIONS: 'fcm' }, /PUSH_NOTIFICATIONS/],
      ['a short access token', { EXPO_ACCESS_TOKEN: 'x'.repeat(19) }, /EXPO_ACCESS_TOKEN/],
      ['a push URL over plain http, even to localhost', { EXPO_PUSH_API_URL: 'http://127.0.0.1:9000/push' }, /EXPO_PUSH_API_URL/],
      ['a push URL without a protocol', { EXPO_PUSH_API_URL: 'exp.host/--/api/v2/push' }, /EXPO_PUSH_API_URL/],
    ])('refuses %s', (_label, extra, name) => {
      expect(() => validateEnv({ ...valid(), ...extra })).toThrow(name);
    });
  });
});
