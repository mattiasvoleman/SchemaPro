import { type NextRequest, NextResponse } from "next/server";
import createIntlMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";
import { updateSession } from "@/utils/supabase/middleware";

const intlMiddleware = createIntlMiddleware(routing);

const PUBLIC_PATHS = ["/login", "/forgot-password", "/update-password", "/auth"];

// Next.js 16 renamed the root "middleware" convention to "proxy".
export async function proxy(request: NextRequest) {
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
