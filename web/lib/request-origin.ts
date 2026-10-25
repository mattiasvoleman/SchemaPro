import type { NextRequest } from "next/server";

/**
 * Whether a form post came from this app's own pages: a request another
 * site's page made the browser send (its Origin is another host, or
 * Sec-Fetch-Site says so) is not. The session cookies are SameSite=Lax, so
 * such a request would not be signed in either. Shared by the school
 * switcher's route (app/[locale]/skola) and the huvudman's
 * (app/[locale]/huvudman/act).
 */
export function fromThisApp(request: NextRequest): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return false;
  const origin = request.headers.get("origin");
  if (!origin) return site === "same-origin";
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const hosts = [request.headers.get("x-forwarded-host"), request.headers.get("host"), request.nextUrl.host];
  return hosts.some((candidate) => candidate !== null && candidate.split(",")[0]!.trim() === host);
}
