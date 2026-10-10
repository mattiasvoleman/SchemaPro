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

export function tokenHashOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
