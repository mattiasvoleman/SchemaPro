import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { localePath } from "@/i18n/paths";
import { routing } from "@/i18n/routing";
import { ssoReasonFor } from "@/lib/school-account";
import { createClient } from "@/utils/supabase/server";

/**
 * Where a school-account sign-in comes back (PKCE): Supabase Auth has
 * signed the person in with Entra ID or Google and sends the browser here
 * with `?code=`, which is exchanged for a session together with the
 * verifier the sign-in page's Supabase client left in a cookie. The session
 * cookies are written onto the redirect.
 *
 * Success goes to the locale root, which resolves the profile and sends the
 * person to their role's home, or to /no-profile when the account has none.
 * Anything else goes back to /login with `?sso=<reason>`, one of a fixed set
 * the page has a sentence for (lib/school-account.ts):
 *
 *   - Auth's own refusal arrives on this URL (error_code, else error), most
 *     often signup_disabled: the school account's address matched no invited
 *     person, since public signups are off.
 *   - The access-token hook's refusal arrives as the exchange's error message
 *     (sso_identity_not_allowed, sso_not_enabled).
 *
 * Every redirect target is a fixed path of this app; nothing from the query
 * is ever a destination.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ locale: string }> }) {
  const { locale: asked } = await params;
  const locale = (routing.locales as readonly string[]).includes(asked) ? asked : routing.defaultLocale;
  const query = request.nextUrl.searchParams;
  const back = (reason: string) =>
    NextResponse.redirect(new URL(`${localePath(locale, "/login")}?sso=${reason}`, request.url), 303);

  const code = query.get("code");
  if (!code) {
    return back(ssoReasonFor(query.get("error_code") || query.get("error")));
  }

  let failure: string | null;
  try {
    const supabase = createClient(await cookies());
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    // The hook's code is the message; any other refusal (an expired flow, a
    // missing verifier cookie) is prose, which reads as "failed".
    failure = error ? ssoReasonFor(error.message) : null;
  } catch {
    failure = ssoReasonFor(null);
  }
  if (failure) return back(failure);

  return NextResponse.redirect(new URL(localePath(locale, "/"), request.url), 303);
}
