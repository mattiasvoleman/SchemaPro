/*
 * The gateway's shapes for "Logga in med skolkonto" (src/sign-in): the
 * school's row, and the school account the admin's own session signed in
 * with (null for a password).
 */

export type SignInProvider = "azure" | "google";

export interface SignInMethodView {
  provider: SignInProvider;
  domains: string[];
  entraTenantId: string | null;
  googleHostedDomain: string | null;
  ssoOnlyForStaff: boolean;
  updatedAt: string;
}

export interface SchoolAccountSession {
  provider: SignInProvider;
  entraTenantId?: string;
  googleHostedDomain?: string;
}

export interface SignInSettings {
  /** False until the deployment turns school accounts on (SCHOOL_ACCOUNTS=on): nothing can be saved. */
  available: boolean;
  method: SignInMethodView | null;
  session: { schoolAccount: SchoolAccountSession | null };
}

export interface SignInMethodInput {
  provider: SignInProvider;
  domains: string[];
  entraTenantId: string | null;
  googleHostedDomain: string | null;
  ssoOnlyForStaff: boolean;
}

/** The table's rule for a domain or an hd (SchoolSignInMethods' CHECKs). */
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,63}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_DOMAINS = 20;

/** The domains of a textarea: one per line (or comma), trimmed, lower case, each once. */
export function domainsOf(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((entry) => entry.trim().toLowerCase()).filter((entry) => entry !== ""))];
}

export const isHostname = (value: string) => HOSTNAME.test(value);
export const isTenantId = (value: string) => GUID.test(value.trim());

/** Whether the admin's session signed in with a school account this row lets through: the gateway's own check (accountFits). */
export function sessionFits(
  account: SchoolAccountSession | null,
  method: { provider: SignInProvider; entraTenantId: string | null; googleHostedDomain: string | null },
): boolean {
  if (!account || account.provider !== method.provider) return false;
  return method.provider === "azure"
    ? account.entraTenantId !== undefined && account.entraTenantId === method.entraTenantId?.toLowerCase()
    : account.googleHostedDomain !== undefined && account.googleHostedDomain === method.googleHostedDomain?.toLowerCase();
}
