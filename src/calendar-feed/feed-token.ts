import { TOKEN_PATTERN } from '../publication/public-token';

/**
 * A feed's address ends in its token, with or without ".ics" (calendars that
 * guess the format by the name get one; the others do not care). The token
 * is a share link's shape (32 random bytes, base64url), drawn and hashed as
 * Schemavisaren's are (src/publication/public-token.ts); anything else is no
 * feed and answers the one 404.
 */
export function feedTokenOf(file: unknown): string | null {
  if (typeof file !== 'string') return null;
  const token = file.endsWith('.ics') ? file.slice(0, -'.ics'.length) : file;
  return TOKEN_PATTERN.test(token) ? token : null;
}
