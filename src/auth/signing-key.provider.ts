import { passportJwtSecret } from 'jwks-rsa';
import type { JwtConfig } from '../config/configuration';

/** Every algorithm the API will verify a bearer token with. */
export const ACCEPTED_ALGORITHMS = ['ES256', 'HS256'] as const;

export type SigningKeyProvider = (rawToken: string) => Promise<string | Buffer>;

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
 */
export function createSigningKeyProvider(jwt: JwtConfig): SigningKeyProvider {
  const fromJwks = passportJwtSecret({
    jwksUri: jwt.jwksUri,
    cache: true,
    rateLimit: true,
  });

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
        resolve(key ?? jwt.secret);
      });
    });
}
