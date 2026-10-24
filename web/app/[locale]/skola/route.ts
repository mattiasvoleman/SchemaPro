import { NextResponse, type NextRequest } from "next/server";
import { localePath } from "@/i18n/paths";
import { routing } from "@/i18n/routing";
import { getSession, homePathForRole } from "@/lib/auth";
import { SCHOOL_COOKIE, schoolIdOf } from "@/lib/school-choice";

/** A year: the browser remembers its school as long as it remembers the login. */
const REMEMBERED_SECONDS = 365 * 24 * 60 * 60;

/**
 * The school switcher's form (components/layout/school-switcher.tsx): the
 * person picks another of their schools, and the browser remembers it in a
 * cookie that every later page reads (lib/school-choice.ts). The answer is a
 * 303 to the start page of the person's role at that school, so the browser
 * loads it whole: no client keeps anything of the school before.
 *
 * Only a school the login has an active row in and this session may enter
 * is remembered, as GET /api/v1/me/schools lists them; anything else goes
 * back to the start page with nothing changed. The cookie is a choice, not
 * a grant: the gateway and the database answer only for the login's own
 * rows whatever it says.
 *
 * Only a form from this app's own pages: a request another site's page made
 * the browser send (its Origin is another host, or Sec-Fetch-Site says so)
 * is refused. The session cookies are SameSite=Lax, so such a request would
 * not be signed in either.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ locale: string }> }) {
  const { locale: asked } = await params;
  const locale = (routing.locales as readonly string[]).includes(asked) ? asked : routing.defaultLocale;
  const to = (path: `/${string}`) => NextResponse.redirect(new URL(localePath(locale, path), request.url), 303);

  if (!fromThisApp(request)) {
    return new NextResponse(null, { status: 403 });
  }

  const session = await getSession();
  if (!session) return to("/login");

  const form = await request.formData().catch(() => null);
  const field = form?.get("school");
  const chosen = schoolIdOf(typeof field === "string" ? field : null);
  const school = session.schools.find((one) => one.schoolId === chosen && one.closed === null);
  if (!school) return to("/");

  const response = to(homePathForRole(school.role) as `/${string}`);
  response.cookies.set(SCHOOL_COOKIE, school.schoolId, {
    path: "/",
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
    maxAge: REMEMBERED_SECONDS,
    // Read by the browser too: a tab compares it with the school it was
    // rendered for (components/profile-context.tsx). It is an id, no secret.
    httpOnly: false,
  });
  return response;
}

function fromThisApp(request: NextRequest): boolean {
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
