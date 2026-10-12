/**
 * "Logga in med skolkonto" in the browser and at /auth/callback (migration
 * 20261020090000).
 *
 * Imported by the sign-in page, so nothing here may pull in a client
 * runtime: no next-intl, no Supabase client, no lib/api.ts (which imports the
 * client statically). The texts come from the page as strings, and the
 * Supabase client is fetched on the click (utils/supabase/load-client.ts).
 */

/** The school-account providers, in Supabase Auth's names. */
export type SchoolAccountProvider = "azure" | "google";

/**
 * Why a school-account sign-in did not end in a session, as /login names it
 * in `?sso=`. Each has a sentence in messages (auth.ssoReasons).
 */
export const SSO_REASONS = [
  "no-account",
  "unverified",
  "other-organisation",
  "not-enabled",
  "cancelled",
  "blocked",
  "failed",
] as const;
export type SsoReason = (typeof SSO_REASONS)[number];

export function isSsoReason(value: unknown): value is SsoReason {
  return typeof value === "string" && (SSO_REASONS as readonly string[]).includes(value);
}

/** The table's rule for a domain (SchoolSignInMethods_domains_are_hostnames). */
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,63}$/;

/** The domain of a typed address, lower case, or null when it has none worth asking about. */
export function emailDomain(email: string): string | null {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return null;
  const domain = trimmed.slice(at + 1);
  return HOSTNAME.test(domain) ? domain : null;
}

/**
 * Asks the gateway which provider a domain signs in with
 * (GET /public/v1/sign-in-methods/:domain). Only the domain leaves the
 * browser, never the address. Null when no school names it; throws when the
 * gateway could not be asked, which the form reports as a failure rather
 * than as "no school account".
 */
export async function lookupProvider(
  apiBase: string,
  domain: string,
  fetcher: typeof fetch = fetch,
): Promise<SchoolAccountProvider | null> {
  const base = apiBase.replace(/\/+$/, "");
  const response = await fetcher(`${base}/public/v1/sign-in-methods/${encodeURIComponent(domain)}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`lookup answered ${response.status}`);
  const body = (await response.json()) as { provider?: unknown };
  return body.provider === "azure" || body.provider === "google" ? body.provider : null;
}

/**
 * What the provider is told about who is signing in, so the person does not
 * pick their account twice. Entra: the address and the domain, which routes
 * a federated tenant to its own sign-in. Google: the address. Google's own
 * `hd` hint is left out on purpose: a Workspace's hd is its primary domain,
 * which a person on one of its other domains does not type.
 */
export function providerHints(provider: SchoolAccountProvider, email: string, domain: string): Record<string, string> {
  const address = email.trim();
  return provider === "azure" ? { login_hint: address, domain_hint: domain } : { login_hint: address };
}

/**
 * The scopes Auth asks the provider for beyond its own. Entra ID returns an
 * e-mail address only when the email scope is asked for, and without one
 * Auth cannot link the school account to the invited person (Supabase's
 * Azure guide). Google's provider asks for email and profile itself.
 */
export function providerScopes(provider: SchoolAccountProvider): string | undefined {
  return provider === "azure" ? "email" : undefined;
}

/**
 * The access-token hook refused a password sign-in for staff at a school
 * that requires the school account: Auth answers 403 with the hook's code as
 * the message ({"code":403,"error_code":"unknown","msg":"sso_required"},
 * measured against GoTrue v2.197.0).
 */
export function isSsoRequired(error: { status?: number; message?: string } | null | undefined): boolean {
  return error?.status === 403 && error.message === "sso_required";
}

/**
 * The reason for /login's `?sso=`, from what came back: the error Auth put
 * on the callback URL (error_code first, then error), or the message of a
 * refused code exchange, where the access-token hook's codes arrive.
 */
export function ssoReasonFor(code: string | null | undefined): SsoReason {
  switch (code) {
    case "signup_disabled":
      return "no-account";
    case "provider_email_needs_verification":
    case "email_not_confirmed":
      return "unverified";
    case "sso_identity_not_allowed":
      return "other-organisation";
    case "sso_not_enabled":
      return "not-enabled";
    case "access_denied":
    case "consent_required":
    case "interaction_required":
      return "cancelled";
    case "user_banned":
      return "blocked";
    default:
      return "failed";
  }
}

/**
 * The address of a session that signed in with a school account (its amr
 * says "oauth"), read from the verified claims, or null for any other
 * session. /no-profile says it, since it is the one thing such a person can
 * take to their administrator.
 */
export function schoolAccountAddressOf(claims: unknown): string | null {
  if (!claims || typeof claims !== "object") return null;
  const { amr, email } = claims as { amr?: unknown; email?: unknown };
  const viaSchoolAccount =
    Array.isArray(amr) &&
    amr.some((entry: unknown) => !!entry && typeof entry === "object" && (entry as { method?: unknown }).method === "oauth");
  return viaSchoolAccount && typeof email === "string" && email !== "" ? email : null;
}
