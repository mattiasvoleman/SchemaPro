import "server-only";

/**
 * A read from the NestJS gateway in a server component, as the signed-in user.
 *
 * lib/api.ts is the browser's client: it takes the token from the browser's
 * Supabase session and throws an ApiError the page's query renders. A server
 * component has neither — it holds the token from the request's cookies, and
 * a figure that could not be read is a "—" on the page, not a thrown render.
 * So this one is handed the token and never throws: the answer is the body,
 * or the reason there is none.
 *
 * Never cached: the answer is one user's, read for one request, like the rest
 * of a force-dynamic page.
 */

export type ServerApiResult<T> = { data: T } | { error: string };

export async function serverApiGet<T>(
  path: string,
  accessToken: string | null | undefined,
): Promise<ServerApiResult<T>> {
  // Trailing slashes stripped, as in lib/api.ts: every path starts with one,
  // and `//api/v1/...` is a route the gateway 404s.
  const base = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/+$/, "");
  if (!base) return { error: "NEXT_PUBLIC_API_BASE_URL is not configured." };
  if (!accessToken) return { error: "Not authenticated." };

  try {
    const response = await fetch(`${base}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
    if (!response.ok) return { error: `HTTP ${response.status}` };
    return { data: (await response.json()) as T };
  } catch (error) {
    // The gateway down or a body that is not JSON: no figure, and the page
    // says so; the render itself must not fail over a dashboard tile.
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
