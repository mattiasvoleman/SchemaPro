/*
 * Who may frame Schemavisaren (Utskrift och inbäddning, 20261102090000).
 *
 * Every viewer page answers frame-ancestors 'none' (and X-Frame-Options:
 * DENY for browsers that read only that), so a share link cannot be put in
 * somebody else's page. /v/<token>/embed answers the school's own websites
 * instead, as the gateway's GET public/v1/timetables/:token/embed lists them
 * — and 'none' when it answers anything else: a link that may not be
 * embedded, an unknown one, a gateway that does not answer. Closed by
 * default, open only by the school's choice.
 *
 * The proxy (proxy.ts) asks here on every embed request. A list of websites
 * is kept for a minute per token, as the gateway lets it be kept: a school
 * that switches embedding off is out of every frame within a minute, as a
 * revoked link is gone. A 404 is not kept, as the gateway says (no-store),
 * so a school that switches embedding on is in its frames at once; nor is a
 * failed answer.
 */

/** /v/<token>/embed, the token a share link's (32 bytes, base64url). */
export const EMBED_PATH = /^\/v\/([A-Za-z0-9_-]{43})\/embed\/?$/;

/** An origin as the gateway stores it; anything else never reaches the header. */
const ORIGIN = /^https:\/\/[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+(:(6553[0-5]|655[0-2][0-9]|65[0-4][0-9]{2}|6[0-4][0-9]{3}|[1-5][0-9]{4}|[1-9][0-9]{0,3}))?$/;

const TTL_MS = 60_000;
const MAX_ENTRIES = 1_000;
const cache = new Map<string, { origins: string[]; until: number }>();

/** The header's value: the websites, or none. */
export function frameAncestorsOf(origins: readonly string[] | null): string {
  const sources = (origins ?? []).filter((origin) => ORIGIN.test(origin));
  return sources.length > 0 ? `frame-ancestors ${sources.join(" ")}` : "frame-ancestors 'none'";
}

export interface EmbedLookup {
  base: string;
  token: string;
  headers: Record<string, string>;
  now?: number;
  fetchImpl?: typeof fetch;
}

/** The websites that may frame the link's embed page, or null; a minute's memory per token. */
export async function embedOriginsOf({ base, token, headers, now = Date.now(), fetchImpl = fetch }: EmbedLookup): Promise<string[] | null> {
  const kept = cache.get(token);
  if (kept && kept.until > now) return kept.origins;
  let origins: string[];
  try {
    const response = await fetchImpl(`${base.replace(/\/+$/, "")}/public/v1/timetables/${encodeURIComponent(token)}/embed`, {
      cache: "no-store",
      headers: { ...headers, Accept: "application/json" },
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) {
      return null;
    } else {
      // Anything but a list of origins is no answer: the frame stays shut and nothing is kept.
      const body = (await response.json()) as { frameAncestors?: unknown };
      const listed = body.frameAncestors;
      if (
        !Array.isArray(listed) ||
        listed.length === 0 ||
        !listed.every((origin): origin is string => typeof origin === "string" && ORIGIN.test(origin))
      ) {
        return null;
      }
      origins = listed;
    }
  } catch {
    return null;
  }
  if (cache.size >= MAX_ENTRIES) {
    for (const [key, entry] of cache) if (entry.until <= now) cache.delete(key);
    if (cache.size >= MAX_ENTRIES) cache.clear();
  }
  cache.set(token, { origins, until: now + TTL_MS });
  return origins;
}

/** For tests: forget every answer. */
export function forgetEmbedPolicies(): void {
  cache.clear();
}
