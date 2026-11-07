import { cookies } from "next/headers";
import { SCHOOL_COOKIE } from "@/lib/school-choice";
import { readStaffViewerResponse, staffViewerFetchOf, type ViewerOutcome, type ViewerQuery } from "@/lib/public-timetable";
import { createClient } from "@/utils/supabase/server";

/**
 * The viewer's document as a signed-in teacher or administrator may read it:
 * the other door of a viewer for staff (Schemavisarens lägen, 20270118090000).
 * The public route cannot answer such a viewer, and cannot tell who asks, so
 * the page asks here, with the visitor's own session, after the public route
 * has answered its one 404.
 *
 * ONLY FOR SOMEONE WHO ALREADY HAS A SESSION. A request without a Supabase
 * cookie (sb-…) gets null at once: no client is made, no gateway is asked,
 * and the page's "not found" stands. The session is read only to be
 * forwarded: the gateway verifies the token, takes the person's role and
 * school from it, and answers the same one 404 for a link that is not the
 * school's, a kind that is off, a schedule that is hidden or protected. The
 * web decides nothing here and learns nothing the 404 did not say.
 *
 * The proxy has refreshed that session before the page runs (proxy.ts), so a
 * teacher whose access token went stale between two visits is not read as a
 * stranger. The embedded frame (../embed) does not import this file: a frame
 * on somebody's website never reads the session.
 *
 * Not cached (cache: "no-store"), here as for the public route: the answer
 * names a person's week, and the gateway marks it private.
 */
export async function readViewerAsStaff(token: string, query: ViewerQuery): Promise<ViewerOutcome | null> {
  const store = await cookies();
  if (!store.getAll().some((cookie) => cookie.name.startsWith("sb-"))) return null;
  let accessToken: string | null;
  try {
    accessToken = (await createClient(store).auth.getSession()).data.session?.access_token ?? null;
  } catch {
    return null;
  }
  if (!accessToken) return null;
  const base = process.env.PUBLIC_VIEWER_API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
  const request = staffViewerFetchOf(base, token, query, accessToken, store.get(SCHOOL_COOKIE)?.value);
  try {
    return await readStaffViewerResponse(await fetch(request.url, { cache: "no-store", headers: request.headers }));
  } catch {
    return { kind: "unavailable" };
  }
}
