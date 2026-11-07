import { createHash, randomBytes } from 'node:crypto';

/**
 * A share link's token: 32 random bytes, base64url (43 characters). The API
 * shows it once, when the link is made; the database keeps only its sha256
 * (PublicTimetableLinks.tokenHash, 20261011120000).
 */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The hash a link is kept by. A code is hashed in its canonical spelling
 * whichever way it was written or shown (K7QM2-X9DRT-… and k7qm2x9drt… are
 * one link), a token as it is, and anything that is neither as it stands.
 */
export function tokenHashOf(token: string): string {
  return createHash('sha256').update(viewerTokenOf(token) ?? token).digest('hex');
}

/**
 * A code, the Fritext-ID of Schemavisaren's lägen (20270118090000): 20
 * characters of Crockford's base32, which is 100 random bits, written in four
 * groups of five so that a person can read it off a letter and type it. It
 * is drawn here and never chosen: a name, a signature or a class is not a
 * code, because those can be tried one after another and are printed on the
 * pages of others.
 *
 * Crockford's alphabet leaves out I, L, O and U, and reads a typed I or L as
 * 1 and a typed O as 0, so the commonest slips of the eye still find the
 * link. Like a token, a code is kept as the sha256 of its canonical spelling
 * (upper case, no separators).
 */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{20}$/;

export function newCode(): string {
  // 256 is a multiple of 32, so the low five bits of a byte are uniform.
  const bytes = randomBytes(20);
  let code = '';
  for (const byte of bytes) code += CODE_ALPHABET[byte & 31];
  return code;
}

/** A code as it is shown: 5-5-5-5, hyphens between. */
export function codeForDisplay(code: string): string {
  return code.replace(/(.{5})(?=.)/g, '$1-');
}

/**
 * What a viewer address may carry, as the string the database hashes, or
 * null for anything that cannot be a link. A token (43 characters of
 * base64url, case and hyphens significant) is taken as it is; anything else
 * must be a code, typed any way a person types it: lower case, with hyphens
 * or spaces between the groups, I or L for 1, O for 0. The viewer's
 * controllers, its rate limit and the log's redaction all go through here, so
 * they agree on which link an address means.
 */
export function viewerTokenOf(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 64) return null;
  if (TOKEN_PATTERN.test(raw)) return raw;
  const code = raw.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  return CODE_PATTERN.test(code) ? code : null;
}
