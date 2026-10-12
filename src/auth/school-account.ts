/**
 * The school account a session signed in with ("Logga in med skolkonto",
 * migration 20261020090000), read from a verified Supabase access token.
 *
 * Supabase Auth writes the session's methods into `amr` and merges the
 * provider identity's data into `user_metadata` at every school-account
 * sign-in: the ID token's issuer as `iss` (for Entra ID
 * https://login.microsoftonline.com/<tid>/v2.0) and its other claims under
 * `custom_claims`, Google's `hd` among them.
 *
 * `user_metadata` is something a signed-in person can rewrite for themselves
 * (supabase.auth.updateUser({ data })), so what this returns is never an
 * authorization. It answers one question for the person asking it: "would
 * this setting lock me out?" (SignInMethodsService). Who may sign in is the
 * access-token hook's to decide, from auth.identities, which nobody but Auth
 * writes.
 */
export interface SchoolAccountSession {
  provider: 'azure' | 'google';
  /** Entra ID's tenant, lower case, from the issuer. */
  entraTenantId?: string;
  /** Google Workspace's hd, lower case. */
  googleHostedDomain?: string;
}

/** Methods Auth adds on top of a sign-in, and the refresh, which is not one. */
const NOT_FIRST_FACTORS = new Set(['token_refresh', 'totp', 'mfa/phone', 'mfa/webauthn', 'mfa/recovery_code']);

const ENTRA_ISSUER =
  /^https:\/\/login\.microsoftonline\.com\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/v2\.0\/?$/i;
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

/** The session's first factors, from `amr` entries ({ method } objects, or plain strings). */
export function firstFactorsOf(amr: unknown): string[] {
  if (!Array.isArray(amr)) return [];
  const methods = amr
    .map((entry: unknown) =>
      typeof entry === 'string'
        ? entry
        : entry && typeof entry === 'object' && typeof (entry as { method?: unknown }).method === 'string'
          ? (entry as { method: string }).method
          : null,
    )
    .filter((method): method is string => method !== null && !NOT_FIRST_FACTORS.has(method));
  return [...new Set(methods)];
}

/**
 * The school account of a session that signed in with one and nothing else,
 * as the access-token hook counts it (sign_in.verdict); null for any other
 * session, or when the metadata names neither an Entra tenant nor a Google
 * Workspace.
 */
export function schoolAccountOf(payload: { amr?: unknown; user_metadata?: unknown }): SchoolAccountSession | null {
  const factors = firstFactorsOf(payload.amr);
  if (factors.length === 0 || factors.some((method) => method !== 'oauth')) return null;

  const metadata = payload.user_metadata;
  if (!metadata || typeof metadata !== 'object') return null;
  const { iss, custom_claims: claims } = metadata as { iss?: unknown; custom_claims?: unknown };
  if (typeof iss !== 'string') return null;
  const custom = claims && typeof claims === 'object' ? (claims as Record<string, unknown>) : {};

  const entra = ENTRA_ISSUER.exec(iss);
  if (entra) {
    const tenant = entra[1]!.toLowerCase();
    const claimed = typeof custom['tid'] === 'string' ? custom['tid'].toLowerCase() : null;
    if (claimed !== null && claimed !== tenant) return null;
    return { provider: 'azure', entraTenantId: tenant };
  }
  if (GOOGLE_ISSUERS.has(iss) && typeof custom['hd'] === 'string' && custom['hd'] !== '') {
    return { provider: 'google', googleHostedDomain: custom['hd'].toLowerCase() };
  }
  return null;
}
