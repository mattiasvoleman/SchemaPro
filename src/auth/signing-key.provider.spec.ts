import { JwtService } from '@nestjs/jwt';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { passportJwtSecret } from 'jwks-rsa';
import type { JwtConfig } from '../config/configuration';
import {
  ACCEPTED_ALGORITHMS,
  createSigningKeyProvider,
  type SigningKeyProvider,
} from './signing-key.provider';

// Only the JWKS transport is faked. Signatures are produced and verified with
// real crypto, because the bug this guards against is a key/algorithm mismatch
// that a stubbed verifier would hide.
jest.mock('jwks-rsa', () => ({ passportJwtSecret: jest.fn() }));

const KID = 'f3fe84d5-3e20-4933-864d-81e41e2bfe07';
const SECRET = 'a-test-secret-that-is-long-enough-000000';
const SUB = '11111111-1111-4111-8111-111111111111';

const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const EC_PUBLIC = ec.publicKey.export({ format: 'pem', type: 'spki' }).toString();
const EC_PRIVATE = ec.privateKey
  .export({ format: 'pem', type: 'pkcs8' })
  .toString();

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const RSA_PUBLIC = rsa.publicKey
  .export({ format: 'pem', type: 'spki' })
  .toString();
const RSA_PRIVATE = rsa.privateKey
  .export({ format: 'pem', type: 'pkcs8' })
  .toString();

type SecretCallback = (error: unknown, key?: string | Buffer) => void;

/**
 * Mirrors the contract of the real `passportJwtSecret`: it answers only for
 * asymmetric algorithms, and yields no key at all when the `kid` is unknown.
 */
function fakeJwks(keys: Record<string, string>, failure?: Error) {
  return (_request: unknown, rawToken: string, done: SecretCallback) => {
    if (failure) {
      done(failure);
      return;
    }
    const [rawHeader] = rawToken.split('.');
    const header = JSON.parse(
      Buffer.from(rawHeader ?? '', 'base64url').toString(),
    ) as { alg: string; kid?: string };

    if (!header.alg.startsWith('ES') && !header.alg.startsWith('RS')) {
      done(null, undefined);
      return;
    }
    done(null, keys[header.kid ?? '']);
  };
}

const config = (): JwtConfig => ({
  secret: SECRET,
  issuer: 'https://issuer.test/auth/v1',
  jwksUri: 'https://issuer.test/auth/v1/.well-known/jwks.json',
  audience: undefined,
});

const sign = (options: Record<string, unknown>) =>
  new JwtService({}).signAsync({ sub: SUB }, options);

/** Verifies exactly as AuthModule wires JwtService for the realtime gateway. */
const verify = (provider: SigningKeyProvider, token: string) =>
  new JwtService({
    secretOrKeyProvider: (_requestType, tokenOrPayload) =>
      provider(tokenOrPayload as string),
    verifyOptions: { algorithms: [...ACCEPTED_ALGORITHMS] },
  }).verifyAsync(token);

const pemOf = (key: KeyObject) =>
  key.export({ format: 'pem', type: 'spki' }).toString();

describe('createSigningKeyProvider', () => {
  const mockedJwks = passportJwtSecret as jest.MockedFunction<
    typeof passportJwtSecret
  >;

  beforeEach(() => {
    mockedJwks.mockReset();
    mockedJwks.mockReturnValue(fakeJwks({ [KID]: EC_PUBLIC }));
  });

  it('caches and rate-limits lookups against the configured JWKS endpoint', () => {
    createSigningKeyProvider(config());

    expect(mockedJwks).toHaveBeenCalledWith({
      jwksUri: 'https://issuer.test/auth/v1/.well-known/jwks.json',
      cache: true,
      rateLimit: true,
    });
  });

  it('verifies a Supabase ES256 token with the key its kid points at', async () => {
    const provider = createSigningKeyProvider(config());
    const token = await sign({
      algorithm: 'ES256',
      privateKey: EC_PRIVATE,
      keyid: KID,
    });

    const key = await provider(token);
    expect(key.type).toBe('public');
    expect(pemOf(key)).toBe(EC_PUBLIC);
    await expect(verify(provider, token)).resolves.toMatchObject({ sub: SUB });
  });

  it('rejects an ES256 token whose kid is absent from the JWKS', async () => {
    const provider = createSigningKeyProvider(config());
    const token = await sign({
      algorithm: 'ES256',
      privateKey: EC_PRIVATE,
      keyid: 'a-key-that-was-rotated-out',
    });

    await expect(verify(provider, token)).rejects.toThrow();
  });

  it('still verifies first-party HS256 service tokens', async () => {
    const provider = createSigningKeyProvider(config());
    const token = await sign({ secret: SECRET });

    const key = await provider(token);
    expect(key.type).toBe('secret');
    expect(key.export().toString()).toBe(SECRET);
    await expect(verify(provider, token)).resolves.toMatchObject({ sub: SUB });
  });

  it('parses each key once and hands every request the same KeyObject', async () => {
    // jsonwebtoken re-derives a KeyObject from a string or PEM on every verify,
    // and for a string secret it first fails a public-key parse. Handing it the
    // same parsed key each time is the whole point of the provider owning them.
    const provider = createSigningKeyProvider(config());
    const supabase = await sign({
      algorithm: 'ES256',
      privateKey: EC_PRIVATE,
      keyid: KID,
    });
    const service = await sign({ secret: SECRET });

    expect(await provider(supabase)).toBe(await provider(supabase));
    expect(await provider(service)).toBe(await provider(service));
  });

  it('never hands the public JWKS key to HMAC verification', async () => {
    const provider = createSigningKeyProvider(config());
    // The algorithm-confusion forgery: the attacker knows the public key,
    // because it is public, and signs HS256 with it.
    const forged = await sign({ secret: EC_PUBLIC, keyid: KID });

    const key = await provider(forged);
    expect(key.type).toBe('secret');
    expect(key.export().toString()).toBe(SECRET);
    await expect(verify(provider, forged)).rejects.toThrow();
  });

  it('rejects an algorithm outside the pinned set even with a known kid', async () => {
    mockedJwks.mockReturnValue(fakeJwks({ [KID]: RSA_PUBLIC }));
    const provider = createSigningKeyProvider(config());
    const token = await sign({
      algorithm: 'RS256',
      privateKey: RSA_PRIVATE,
      keyid: KID,
    });

    await expect(verify(provider, token)).rejects.toThrow(/invalid algorithm/i);
  });

  it('rejects when the JWKS serves a key that does not parse', async () => {
    mockedJwks.mockReturnValue(fakeJwks({ [KID]: 'not a public key' }));
    const provider = createSigningKeyProvider(config());
    const token = await sign({
      algorithm: 'ES256',
      privateKey: EC_PRIVATE,
      keyid: KID,
    });

    await expect(provider(token)).rejects.toThrow();
  });

  it('surfaces a JWKS transport failure instead of falling back to the secret', async () => {
    mockedJwks.mockReturnValue(fakeJwks({}, new Error('JWKS unreachable')));
    const provider = createSigningKeyProvider(config());
    const token = await sign({
      algorithm: 'ES256',
      privateKey: EC_PRIVATE,
      keyid: KID,
    });

    await expect(provider(token)).rejects.toThrow('JWKS unreachable');
  });
});
