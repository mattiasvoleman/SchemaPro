/*
 * What a viewer address may carry (Schemavisarens lägen, 20270118090000), the
 * web's copy of the gateway's viewerTokenOf (src/publication/public-token.ts).
 * Pure and free of imports, so the proxy, the pages and the admin's pasted
 * addresses all read an address the same way, and a test can hold the two
 * copies to the same rows.
 *
 * Two kinds of secret open a viewer:
 *
 *   a TOKEN  32 random bytes in base64url (43 characters), the links the
 *            school made before the lägen. Case and hyphens are part of it,
 *            so it is taken as it is.
 *   a CODE   20 characters of Crockford's base32 (100 random bits), what a
 *            link has been since: written in four groups of five so that a
 *            person can read it off a letter and type it
 *            ("K7QM2-X9DRT-4V8WN-B5C3H"). Typed any way a person types it:
 *            lower case, hyphens or spaces between the groups, I or L for 1,
 *            O for 0.
 *
 * The gateway normalises the same way; the web does it too so that a page
 * asks about, and links to, the one spelling.
 */

/** 32 random bytes in base64url — the gateway's TOKEN_PATTERN. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Crockford's base32 without I, L, O and U: the code in its canonical spelling. */
const CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{20}$/;

/**
 * The string the gateway hashes for an address, or null for anything that
 * cannot be a link: a token as it is, a code in its canonical spelling (upper
 * case, no separators). Longer than 64 characters is never one.
 */
export function viewerTokenOf(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 64) return null;
  if (TOKEN_PATTERN.test(raw)) return raw;
  const code = raw.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
  return CODE_PATTERN.test(code) ? code : null;
}

/** A code as it is shown: 5-5-5-5, hyphens between. */
export function codeForDisplay(code: string): string {
  return code.replace(/(.{5})(?=.)/g, "$1-");
}

/**
 * The spelling an address is written in after /v/: a token as it is, a code
 * in four groups of five — the form the school hands out. Null for anything
 * that is no link. A path segment still percent-encoded (the proxy sees the
 * raw path; a person's typed space is %20) is decoded once first.
 */
export function viewerAddressOf(raw: unknown): string | null {
  let text = raw;
  if (typeof text === "string" && text.includes("%")) {
    try {
      text = decodeURIComponent(text);
    } catch {
      return null;
    }
  }
  const token = viewerTokenOf(text);
  return token === null ? null : token.length === 43 ? token : codeForDisplay(token);
}
