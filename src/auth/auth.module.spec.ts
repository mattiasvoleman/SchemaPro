import { JwtSecretRequestType } from '@nestjs/jwt';
import type { JwtConfig } from '../config/configuration';
import { buildJwtModuleOptions } from './auth.module';
import { ACCEPTED_ALGORITHMS } from './signing-key.provider';

jest.mock('jwks-rsa', () => ({
  // No network: the fake client answers immediately with a public key, so the
  // VERIFY promise settles and these tests exercise option-building only.
  passportJwtSecret: jest.fn(
    () =>
      (
        _req: unknown,
        _token: string,
        done: (error: unknown, key?: string) => void,
      ) =>
        done(null, 'jwks-public-key'),
  ),
}));

const config = (overrides: Partial<JwtConfig> = {}): JwtConfig =>
  ({
    secret: 'shared-secret',
    issuer: 'https://project.supabase.co/auth/v1',
    audience: 'authenticated',
    jwksUri: 'https://project.supabase.co/auth/v1/.well-known/jwks.json',
    ...overrides,
  }) as JwtConfig;

describe('buildJwtModuleOptions', () => {
  it('pins the accepted algorithms so a token cannot choose its own', () => {
    const options = buildJwtModuleOptions(config());

    // Algorithm pinning is the defence against "alg: none" and against a
    // forged token nominating an algorithm the key material does not match.
    expect(options.verifyOptions?.algorithms).toEqual([...ACCEPTED_ALGORITHMS]);
    expect(options.verifyOptions?.algorithms).toContain('ES256');
    expect(options.verifyOptions?.algorithms).toContain('HS256');
  });

  it('resolves the VERIFY key through the JWKS provider, not the shared secret', async () => {
    const options = buildJwtModuleOptions(config());
    const provider = options.secretOrKeyProvider as (
      type: JwtSecretRequestType,
      token: string,
    ) => unknown;

    const resolved = provider(JwtSecretRequestType.VERIFY, 'raw.jwt.token');

    // A promise, not the literal secret: verification goes through the
    // asymmetric lookup so a rotated Supabase key is picked up.
    expect(resolved).toBeInstanceOf(Promise);
    await expect(resolved).resolves.toBe('jwks-public-key');
  });

  it('signs with the shared secret — the JWKS key is public and cannot sign', () => {
    const options = buildJwtModuleOptions(config());
    const provider = options.secretOrKeyProvider as (
      type: JwtSecretRequestType,
      payload: unknown,
    ) => unknown;

    expect(provider(JwtSecretRequestType.SIGN, { sub: 'x' })).toBe('shared-secret');
  });

  it('carries issuer and audience into both verify and sign options', () => {
    const options = buildJwtModuleOptions(config());

    expect(options.verifyOptions).toMatchObject({
      issuer: 'https://project.supabase.co/auth/v1',
      audience: 'authenticated',
    });
    expect(options.signOptions).toMatchObject({
      issuer: 'https://project.supabase.co/auth/v1',
      audience: 'authenticated',
    });
  });

  it('omits issuer and audience entirely when unconfigured', () => {
    // Absent, not undefined: jsonwebtoken treats an explicit `issuer:
    // undefined` differently from an unset key in some versions, so the
    // conditional spread must actually drop the key.
    const options = buildJwtModuleOptions(
      config({ issuer: undefined, audience: undefined }),
    );

    expect(options.verifyOptions).not.toHaveProperty('issuer');
    expect(options.verifyOptions).not.toHaveProperty('audience');
    expect(options.signOptions).not.toHaveProperty('issuer');
    expect(options.signOptions).not.toHaveProperty('audience');
    // Pinning survives regardless of the optional claims.
    expect(options.verifyOptions?.algorithms).toEqual([...ACCEPTED_ALGORITHMS]);
  });

  it('keeps an issuer even when the audience is unset, and vice versa', () => {
    const issuerOnly = buildJwtModuleOptions(config({ audience: undefined }));
    expect(issuerOnly.verifyOptions).toHaveProperty('issuer');
    expect(issuerOnly.verifyOptions).not.toHaveProperty('audience');

    const audienceOnly = buildJwtModuleOptions(config({ issuer: undefined }));
    expect(audienceOnly.verifyOptions).not.toHaveProperty('issuer');
    expect(audienceOnly.verifyOptions).toHaveProperty('audience');
  });
});
