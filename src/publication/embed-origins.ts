/**
 * The websites a school lets frame Schemavisaren (20261102090000): sources
 * of a Content-Security-Policy frame-ancestors list, as the web server sends
 * them for /v/<token>/embed.
 *
 * An origin here is https, a host of dot-separated labels and an optional
 * port: no path, no query, no wildcard, no user. That is what the
 * PublicationSettings CHECK takes, with the same pattern, so a value the
 * gateway accepts is one the database stores.
 *
 * What an admin types is forgiving within that: "Skolan.se/" becomes
 * https://skolan.se (the case folded, the scheme assumed when none is given,
 * a lone trailing slash dropped), and a repeat is dropped. Anything else
 * (http, a path such as /schema, a wildcard) is kept as typed so validation
 * names it, rather than being quietly changed into a site the admin did not
 * mean: frame-ancestors takes origins, and the page an iframe sits on is the
 * school's to choose within its site.
 */

export const MAX_EMBED_ORIGINS = 10;

const LABEL = '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?';
/** 1 to 65535: the ports an origin can carry. A port past them is no site, and new URL refuses it. */
const PORT = '(:(6553[0-5]|655[0-2][0-9]|65[0-4][0-9]{2}|6[0-4][0-9]{3}|[1-5][0-9]{4}|[1-9][0-9]{0,3}))?';
/** The database CHECK's pattern, for one origin. */
export const EMBED_ORIGIN_PATTERN = new RegExp(`^https://${LABEL}(\\.${LABEL})+${PORT}$`);

/** One typed site as an origin, or the trimmed input when it is not one. */
export function normalizeEmbedOrigin(value: string): string {
  const typed = value.trim();
  if (typed === '') return typed;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return typed;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return typed;
  if (url.pathname !== '/' && url.pathname !== '') return typed;
  const origin = `https://${url.host}`.toLowerCase();
  return EMBED_ORIGIN_PATTERN.test(origin) ? origin : typed;
}

/**
 * The list as the DTO validates it: each entry normalized, blanks and
 * repeats dropped, order kept. Not an array (or not strings) passes through
 * untouched for the validator to refuse.
 */
export function normalizeEmbedOrigins(value: unknown): unknown {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) return value;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value as string[]) {
    const origin = normalizeEmbedOrigin(entry);
    if (origin === '' || seen.has(origin)) continue;
    seen.add(origin);
    out.push(origin);
  }
  return out;
}
