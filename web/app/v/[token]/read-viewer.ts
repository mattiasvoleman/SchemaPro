import { headers } from "next/headers";
import { readViewerResponse, viewerFetchOf, type ViewerOutcome, type ViewerQuery } from "@/lib/public-timetable";

/**
 * The viewer's document as the gateway answers it, asked on the web server
 * with no cache of its own (cache: "no-store"): a revoked link is gone when
 * the gateway's minute of public caching is. Schemavisaren's page and its
 * embedded frame (./embed) both read through here, so they ask the gateway
 * the same question in the same way, the viewer's address beside the proxy
 * key for the per-viewer rate limit.
 */
export async function readViewer(token: string, query: ViewerQuery): Promise<ViewerOutcome> {
  const base = process.env.PUBLIC_VIEWER_API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
  const request = viewerFetchOf(base, token, query, (await headers()).get("x-forwarded-for"), process.env.PUBLIC_VIEWER_PROXY_KEY);
  try {
    return await readViewerResponse(await fetch(request.url, { cache: "no-store", headers: request.headers }));
  } catch {
    return { kind: "unavailable" };
  }
}
