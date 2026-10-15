import { type NextRequest, NextResponse } from "next/server";
import createIntlMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";
import { updateSession } from "@/utils/supabase/middleware";
import { EMBED_PATH, embedOriginsOf, frameAncestorsOf } from "@/lib/embed-policy";
import { viewerFetchOf } from "@/lib/public-timetable";

const intlMiddleware = createIntlMiddleware(routing);

// /tillganglighet: the tillgänglighetsredogörelse, which Digg says nobody
// should have to sign in to read.
const PUBLIC_PATHS = ["/login", "/forgot-password", "/update-password", "/auth", "/tillganglighet"];

// Next.js 16 renamed the root "middleware" convention to "proxy".
export async function proxy(request: NextRequest) {
  // 0. Schemavisaren (app/v/[token]): public, locale-free, and never given a
  //    cookie — so it returns before next-intl (which would redirect it under
  //    /sv) and before the Supabase session refresh (which writes auth
  //    cookies and sends anyone without a session to /login). The share link
  //    is the secret: noindex and no-referrer keep it out of search engines
  //    and out of the Referer of a link followed off the page.
  //
  //    And nobody frames it (20261102090000): frame-ancestors 'none' and
  //    X-Frame-Options: DENY on every viewer page, except /v/<token>/embed,
  //    which the school's own websites may frame when the school has chosen
  //    so (lib/embed-policy.ts asks the gateway which). A gateway that does
  //    not answer leaves the frame closed.
  if (request.nextUrl.pathname.startsWith("/v/")) {
    // The page's language for the layout's <html lang> (app/v/layout.tsx);
    // always set here, so whatever a browser sent under that name is replaced.
    const forwarded = new Headers(request.headers);
    forwarded.set("x-viewer-lang", request.nextUrl.searchParams.get("lang") === "en" ? "en" : "sv");
    const response = NextResponse.next({ request: { headers: forwarded } });
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
    response.headers.set("Referrer-Policy", "no-referrer");
    const embed = request.nextUrl.pathname.match(EMBED_PATH);
    if (embed) {
      const base = process.env.PUBLIC_VIEWER_API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
      const { headers } = viewerFetchOf(
        base,
        embed[1]!,
        { target: null, date: null },
        request.headers.get("x-forwarded-for"),
        process.env.PUBLIC_VIEWER_PROXY_KEY,
      );
      const origins = await embedOriginsOf({ base, token: embed[1]!, headers });
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
  const pathname = request.nextUrl.pathname;
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
