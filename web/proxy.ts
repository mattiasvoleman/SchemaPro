import { type NextRequest, NextResponse } from "next/server";
import createIntlMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";
import { updateSession } from "@/utils/supabase/middleware";
import { embedOriginsOf, embedTokenOf, frameAncestorsOf } from "@/lib/embed-policy";
import { trustedHopsOf, viewerFetchOf } from "@/lib/public-timetable";

const intlMiddleware = createIntlMiddleware(routing);

// /tillganglighet: the tillgänglighetsredogörelse, which Digg says nobody
// should have to sign in to read.
const PUBLIC_PATHS = ["/login", "/forgot-password", "/update-password", "/auth", "/tillganglighet"];

/** Whether the request already holds a Supabase session: its auth cookies are named sb-<project>-auth-token, in chunks when long. */
const carriesSession = (request: NextRequest): boolean => request.cookies.getAll().some(({ name }) => name.startsWith("sb-"));

// Next.js 16 renamed the root "middleware" convention to "proxy".
export async function proxy(request: NextRequest) {
  // 0. Schemavisaren (app/v/[token], and /v where a code is typed): public,
  //    locale-free, and never given a cookie — so it returns before next-intl
  //    (which would redirect it under /sv) and before the Supabase session
  //    refresh (which writes auth cookies and sends anyone without a session
  //    to /login). The share link is the secret: noindex and no-referrer keep
  //    it out of search engines and out of the Referer of a link followed off
  //    the page.
  //
  //    One exception, for the viewer for staff (Schemavisarens lägen): a
  //    visitor who ALREADY carries a Supabase session (cookies named sb-…) has
  //    it refreshed here, as on every other page, so that a teacher whose
  //    access token went stale between two visits is not read as a stranger
  //    when the page forwards it (app/v/[token]/read-as-staff.ts). Nobody
  //    without such a cookie gets one: no session is opened, no Set-Cookie is
  //    written. And the frame (/v/<link>/embed) never reads the session at all.
  //
  //    And nobody frames it (20261102090000): frame-ancestors 'none' and
  //    X-Frame-Options: DENY on every viewer page, except /v/<token>/embed,
  //    which the school's own websites may frame when the school has chosen
  //    so (lib/embed-policy.ts asks the gateway which). A gateway that does
  //    not answer leaves the frame closed.
  const pathname = request.nextUrl.pathname;
  if (pathname === "/v" || pathname.startsWith("/v/")) {
    const embedToken = embedTokenOf(pathname);
    const refreshed = !embedToken && carriesSession(request) ? NextResponse.next() : null;
    if (refreshed) {
      try {
        // Writes a rotated session onto the request (so the page reads the new
        // token, not the one already spent) and onto `refreshed`.
        await updateSession(request, refreshed);
      } catch {
        // A refresh that fails (the auth service is down) costs a staff visitor
        // their fallback, never an anonymous one their page.
      }
    }
    // The page's language for the layout's <html lang> (app/v/layout.tsx);
    // always set here, so whatever a browser sent under that name is replaced.
    const forwarded = new Headers(request.headers);
    forwarded.set("x-viewer-lang", request.nextUrl.searchParams.get("lang") === "en" ? "en" : "sv");
    const response = NextResponse.next({ request: { headers: forwarded } });
    for (const cookie of refreshed?.cookies.getAll() ?? []) response.cookies.set(cookie);
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
    response.headers.set("Referrer-Policy", "no-referrer");
    if (embedToken) {
      const base = process.env.PUBLIC_VIEWER_API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
      const { headers } = viewerFetchOf(
        base,
        embedToken,
        { target: null, date: null },
        request.headers.get("x-forwarded-for"),
        process.env.PUBLIC_VIEWER_PROXY_KEY,
        trustedHopsOf(process.env.PUBLIC_VIEWER_TRUSTED_HOPS),
      );
      const origins = await embedOriginsOf({ base, token: embedToken, headers });
      const policy = frameAncestorsOf(origins);
      response.headers.set("Content-Security-Policy", policy);
      // A frame the school does not allow is refused as every viewer page is,
      // also by a browser that reads only X-Frame-Options.
      if (policy === "frame-ancestors 'none'") response.headers.set("X-Frame-Options", "DENY");
    } else {
      response.headers.set("Content-Security-Policy", "frame-ancestors 'none'");
      response.headers.set("X-Frame-Options", "DENY");
    }
    return response;
  }

  // 1. Locale detection / redirect / rewrite (next-intl).
  const response = intlMiddleware(request);

  // 2. Refresh the Supabase session; refreshed cookies are written onto the
  //    intl response so both concerns share a single response object.
  const claims = await updateSession(request, response);

  // 3. Gate all non-public routes behind authentication.
  const localeMatch = pathname.match(/^\/(sv|en)(?=\/|$)/);
  const pathWithoutLocale = localeMatch
    ? pathname.slice(localeMatch[0].length) || "/"
    : pathname;
  const isPublic = PUBLIC_PATHS.some((path) => pathWithoutLocale.startsWith(path));

  if (!claims && !isPublic) {
    const locale = localeMatch?.[1] ?? routing.defaultLocale;
    const url = request.nextUrl.clone();
    url.pathname = `/${locale}/login`;
    url.search = "";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - image asset extensions
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
