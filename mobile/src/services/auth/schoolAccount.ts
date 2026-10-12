import { apiRequest } from '../api';

// ─────────────────────────────────────────────────────────────────────────────
// "Logga in med skolkonto" (migration 20261020090000): which provider a
// typed address's domain signs in with, and what came back from the
// provider, as the codes the login screen words. The same rules as the
// web's lib/school-account.ts.
// ─────────────────────────────────────────────────────────────────────────────

export type SchoolAccountProvider = 'azure' | 'google';

/** The table's rule for a domain (SchoolSignInMethods_domains_are_hostnames). */
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,63}$/;

/** The domain of a typed address, lower case, or null when it has none worth asking about. */
export function emailDomain(email: string): string | null {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0) return null;
  const domain = trimmed.slice(at + 1);
  return HOSTNAME.test(domain) ? domain : null;
}

/**
 * Asks the gateway which provider the domain signs in with. Only the domain
 * leaves the phone, never the address. Null when no school names it.
 */
export async function lookupProvider(domain: string): Promise<SchoolAccountProvider | null> {
  const body = await apiRequest<{ provider?: unknown }>(`/public/v1/sign-in-methods/${encodeURIComponent(domain)}`, {
    anonymous: true,
  });
  return body?.provider === 'azure' || body?.provider === 'google' ? body.provider : null;
}

/** What the provider is told about who is signing in (see the web's providerHints). */
export function providerHints(provider: SchoolAccountProvider, email: string, domain: string): Record<string, string> {
  const address = email.trim();
  return provider === 'azure' ? { login_hint: address, domain_hint: domain } : { login_hint: address };
}

/** The screen's codes for a school-account sign-in that did not end in a session. */
export type SchoolAccountRefusal =
  | 'SSO_NO_ACCOUNT'
  | 'SSO_UNVERIFIED'
  | 'SSO_OTHER_ORGANISATION'
  | 'SSO_NOT_ENABLED'
  | 'SSO_CANCELLED'
  | 'LOGIN_FAILED';

/**
 * From Auth's error on the redirect URL (error_code, else error), or from a
 * refused code exchange, where the access-token hook's code is the message.
 */
export function refusalFor(code: string | null | undefined): SchoolAccountRefusal {
  switch (code) {
    case 'signup_disabled':
      return 'SSO_NO_ACCOUNT';
    case 'provider_email_needs_verification':
    case 'email_not_confirmed':
      return 'SSO_UNVERIFIED';
    case 'sso_identity_not_allowed':
      return 'SSO_OTHER_ORGANISATION';
    case 'sso_not_enabled':
      return 'SSO_NOT_ENABLED';
    case 'access_denied':
    case 'consent_required':
    case 'interaction_required':
      return 'SSO_CANCELLED';
    default:
      return 'LOGIN_FAILED';
  }
}

/** The query of the URL the provider sent the browser back to (the app's scheme). */
export function callbackParams(url: string): URLSearchParams {
  const query = url.includes('?') ? url.slice(url.indexOf('?') + 1).split('#')[0]! : '';
  const fragment = url.includes('#') ? url.slice(url.indexOf('#') + 1) : '';
  const params = new URLSearchParams(query);
  // Auth also repeats an error in the fragment; the query wins where both say it.
  for (const [key, value] of new URLSearchParams(fragment)) if (!params.has(key)) params.set(key, value);
  return params;
}
