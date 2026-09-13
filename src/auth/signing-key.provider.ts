import { createPublicKey, createSecretKey, type KeyObject } from 'node:crypto';
import { passportJwtSecret } from 'jwks-rsa';
import type { JwtConfig } from '../config/configuration';

/** Every algorithm the API will verify a bearer token with. */
export const ACCEPTED_ALGORITHMS = ['ES256', 'HS256'] as const;

export type SigningKeyProvider = (rawToken: string) => Promise<KeyObject>;

/**
 * How many distinct JWKS public keys are kept parsed. Only keys the JWKS
 * endpoint serves ever reach the cache — an unknown `kid` yields no key at all —
 * so it holds the few keys Supabase has rotated through, nothing a caller can
 * choose. The cap only bounds a process that outlives many rotations.
 */
const PUBLIC_KEY_CACHE_LIMIT = 16;

/**
 * Resolves the key a bearer token must be verified with. Supabase Auth signs
 * user access tokens with an ES256 key it rotates on its own schedule, so the
 * public key is fetched from the project's JWKS endpoint and selected by the
 * token's `kid`; `jwks-rsa` caches and rate-limits those lookups. First-party
 * service tokens remain symmetric HS256 against the shared secret.
 *
 * Choosing the key from the token's own header is only safe because the two
 * algorithms draw on disjoint key material: `passportJwtSecret` returns a key
 * for asymmetric algorithms only, so the public JWKS key can never reach HMAC
 * verification — that substitution is the classic algorithm-confusion forgery.
 *
 * ## The key material is parsed once, not on every request
 *
 * jsonwebtoken turns whatever key it is handed into a KeyObject on every
 * verify. A string secret is first tried as a PEM public key — which throws —
 * and only then made a secret key, so each HS256 request paid for a failed
 * parse and an exception: 290–425 µs per verify, against 46–81 µs with a
 * KeyObject (jsonwebtoken 9.0.3). An ES256 token paid for parsing the same JWKS
 * PEM every time: 890–1106 µs against 585 µs. The secret is now a KeyObject
 * from the start, and a public key becomes one the first time its PEM is seen.
 * What gets verified is unchanged: jsonwebtoken made the same secret key out of
 * the string, and checked the key type against the algorithm after doing so.
 */
export function createSigningKeyProvider(jwt: JwtConfig): SigningKeyProvider {
  const fromJwks = passportJwtSecret({
    jwksUri: jwt.jwksUri,
    cache: true,
    rateLimit: true,
  });

  const secret = createSecretKey(Buffer.from(jwt.secret));
  const publicKeys = new Map<string, KeyObject>();

  const publicKeyFor = (pem: string | Buffer): KeyObject => {
    const cacheKey = pem.toString();
    let key = publicKeys.get(cacheKey);
    if (!key) {
      key = createPublicKey(pem);
      if (publicKeys.size >= PUBLIC_KEY_CACHE_LIMIT) {
        publicKeys.clear();
      }
      publicKeys.set(cacheKey, key);
    }
    return key;
  };

  return (rawToken) =>
    new Promise((resolve, reject) => {
      fromJwks(undefined, rawToken, (error: unknown, key) => {
        if (error) {
          // A JWKS transport/rate-limit failure must not silently downgrade to
          // the secret, which would reject every valid Supabase token as if it
          // were forged.
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }

        // No key means the token is not asymmetrically signed, or its `kid` is
        // absent from the JWKS. Falling back to the secret verifies first-party
        // tokens; anything else simply fails the signature check.
        resolve(key ? publicKeyFor(key) : secret);
      });
    });
}
