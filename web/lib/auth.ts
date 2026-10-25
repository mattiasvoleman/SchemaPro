import "server-only";
import { cookies } from "next/headers";
import { cache } from "react";
import { createClient } from "@/utils/supabase/server";
import { SCHOOL_COOKIE, schoolHeaders, schoolIdOf } from "@/lib/school-choice";
import type { HuvudmanOfSchool, MySchool, Profile, School } from "@/lib/types";

export type { MySchool };

export interface SessionInfo {
  authId: string;
  email: string | null;
  profile: Profile | null;
  school: School | null;
  accessToken: string | null;
  /**
   * The login's schools, the first it got first, for a login the gateway
   * marked as several schools' (or a browser that chose one); none for every
   * other login, which is not asked, and none when the list could not be read.
   */
  schools: MySchool[];
  /**
   * The school this page names to the browser's clients (the layout's
   * <meta>, lib/school-choice.ts): the profile's school, for a session with
   * more than one school or a school the browser chose. Null otherwise, and
   * the browser then names none, as before.
   */
  namedSchool: string | null;
  /**
   * Huvudman (20261212090000): the huvudman this page reads the school for,
   * when the profile is the huvudman's läsare there (no row of the login's
   * own); null otherwise.
   */
  huvudman: HuvudmanOfSchool | null;
  /**
   * Whether the login is a huvudman's member, so its pages link /huvudman:
   * the gateway's mark, or the login's list naming a huvudman (a login whose
   * mark was lost, which the gateway marks again on /huvudman).
   */
  huvudmanMember: boolean;
  /**
   * The browser chose a school the login has no row of its own at, and the
   * gateway did not answer for the login's schools (a timeout, a 429): the
   * page cannot say whether the school is the huvudman's to read, so it says
   * so, and keeps the choice, rather than send the person to another school.
   */
  schoolsUnavailable: boolean;
}

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/+$/, "");

/**
 * The app_metadata mark the gateway sets on a login that rows at more than
 * one school hold (SupabaseAdminService.markSeveralSchools in the gateway).
 * app_metadata is the service role's to write, and getUser() reads it from
 * Supabase Auth on every page.
 */
export const SEVERAL_SCHOOLS = "rastraSeveralSchools";

/**
 * The app_metadata mark the gateway sets on a huvudman's member's login
 * (SupabaseAdminService.markHuvudman): the login reads the schools its
 * huvudman owns, and has the huvudman's own pages.
 */
export const HUVUDMAN_MEMBER = "rastraHuvudman";

/**
 * The profile of the huvudman's läsare at a school the login has no row in
 * (Huvudman, 20261212090000), from the login's list of schools: the
 * administrator who reads every area and writes none, as the gateway and
 * the database answer for them. The id is the membership's, which is no
 * person of the school's.
 */
function readerProfile(authId: string, email: string | null, school: MySchool): Profile | null {
  const huvudman = school.huvudman;
  if (!huvudman) return null;
  return {
    id: huvudman.memberId,
    authId,
    schoolId: school.schoolId,
    role: "SCHOOL_ADMIN",
    firstName: huvudman.firstName,
    lastName: huvudman.lastName,
    email: email ?? "",
    studentGroupId: null,
    adminProfile: "LASARE",
    hrRead: false,
  };
}

/** How long a page waits for the login's schools before it renders without the switcher. */
export const SCHOOLS_TIMEOUT_MS = 1000;

/**
 * How long a page waits for them a second time, when the first ask did not
 * answer and the browser chose a school the login has no row at: the list
 * is then the only source of the huvudman's läsare's profile there. At most
 * SCHOOLS_TIMEOUT_MS + this, and then the page says it could not read.
 */
export const READER_SCHOOLS_TIMEOUT_MS = 2000;

/** How long the school switcher's route (a POST, and rare) waits for the login's schools. */
export const SWITCH_SCHOOLS_TIMEOUT_MS = 5000;

/**
 * The login's schools from the gateway, or null when the gateway did not
 * answer in time or answered with an error (a 429, a 5xx): not the same as
 * a list without the school. A page with no list shows the profile's school
 * without a switcher, as it did.
 */
async function schoolsOf(accessToken: string | null, school: string | null, timeout = SCHOOLS_TIMEOUT_MS): Promise<MySchool[] | null> {
  if (!API_BASE_URL || !accessToken) return [];
  try {
    const response = await fetch(`${API_BASE_URL}/api/v1/me/schools`, {
      headers: { Authorization: `Bearer ${accessToken}`, ...schoolHeaders(school) },
      cache: "no-store",
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as unknown;
    return Array.isArray(body) ? (body as MySchool[]) : null;
  } catch {
    return null;
  }
}

/**
 * The login's schools for the school switcher's route, asked whatever the
 * login's marks say: a member whose mark was lost has no list in its
 * session, and would otherwise never get past the switcher. Null when the
 * gateway does not answer.
 */
export async function switchableSchools(accessToken: string | null): Promise<MySchool[] | null> {
  return schoolsOf(accessToken, null, SWITCH_SCHOOLS_TIMEOUT_MS);
}

type ServerClient = ReturnType<typeof createClient>;

/**
 * Resolves the caller's Supabase session plus their SchemaPro profile row
 * (Users table, scoped by RLS to the caller's own record). Cached per request.
 *
 * A login with rows at several schools reads the row at the school the
 * browser chose (the switcher's cookie). A choice it can no longer use (the
 * person was removed or deactivated there, or the session may not enter it)
 * is read again with no school named, which is the login's first school: the page
 * names that school from then on, and the browser follows it.
 *
 * Only a login the gateway marked as several schools' (SEVERAL_SCHOOLS), or
 * a browser that chose a school, asks the gateway for the login's schools,
 * beside the profile read and for SCHOOLS_TIMEOUT_MS at most. Every other
 * page reads what it read before Flera skolor per inloggning, from Supabase
 * alone, and no gateway holds it up.
 */
export const getSession = cache(async (): Promise<SessionInfo | null> => {
  const cookieStore = await cookies();
  const chosen = schoolIdOf(cookieStore.get(SCHOOL_COOKIE)?.value);
  const supabase = createClient(cookieStore);

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  // The caller's own row: RLS shows a login its row at the school named and
  // no other, so the filter on authId finds that row or none.
  const profileOf = async (client: ServerClient): Promise<Profile | null> => {
    const { data } = await client
      .from("Users")
      .select("id, authId, schoolId, role, firstName, lastName, email, studentGroupId, adminProfile, hrRead")
      .eq("authId", user.id)
      .maybeSingle();
    return (data as Profile | null) ?? null;
  };

  const marked = user.app_metadata?.[HUVUDMAN_MEMBER] === true;
  const asked = user.app_metadata?.[SEVERAL_SCHOOLS] === true || marked || chosen !== null;
  const tokenRead = supabase.auth.getSession().then((result) => result.data.session?.access_token ?? null);
  const [firstProfile, accessToken, firstSchools] = await Promise.all([
    profileOf(supabase),
    tokenRead,
    asked ? tokenRead.then((token) => schoolsOf(token, chosen)) : Promise.resolve<MySchool[] | null>([]),
  ]);

  let profile = firstProfile;
  let schools = firstSchools;
  let named = chosen;
  // A login with no row at its first school and no mark: ask once, so that
  // a member whose mark was lost is found (a rare page: no profile at all).
  if (!profile && !asked) {
    schools = await schoolsOf(accessToken, null);
  }
  // Huvudman: no row of the login's own at the school chosen, which a
  // member's huvudman may own. The list is then the only source of the
  // läsare's profile there: asked once more if the gateway did not answer.
  // (Anybody else falls back to their first school, as before.)
  if (!profile && chosen && schools === null && marked) {
    schools = await schoolsOf(accessToken, chosen, READER_SCHOOLS_TIMEOUT_MS);
  }
  if (!profile && chosen && schools === null && marked) {
    // Neither answered: keep the choice and say so, rather than leave it.
    return {
      authId: user.id,
      email: user.email ?? null,
      profile: null,
      school: null,
      accessToken,
      schools: [],
      namedSchool: null,
      huvudman: null,
      huvudmanMember: marked,
      schoolsUnavailable: true,
    };
  }
  let huvudman: HuvudmanOfSchool | null = null;
  if (!profile && chosen) {
    const read = (schools ?? []).find((school) => school.schoolId === chosen && school.huvudman && school.closed === null);
    profile = read ? readerProfile(user.id, user.email ?? null, read) : null;
    huvudman = read?.huvudman ?? null;
  }
  if (!profile && chosen) {
    // The list was read, and the school is not the login's to read: the
    // login's first school, as before.
    named = null;
    [profile, schools] = await Promise.all([
      profileOf(createClient(cookieStore, { school: null })),
      schoolsOf(accessToken, null),
    ]);
  }
  const list = schools ?? [];

  let school: School | null = null;
  if (profile) {
    const { data } = await createClient(cookieStore, { school: named ?? null })
      .from("Schools")
      .select("id, name, slug, timezone")
      .eq("id", profile.schoolId)
      .maybeSingle();
    school = (data as School | null) ?? null;
  }

  return {
    authId: user.id,
    email: user.email ?? null,
    profile,
    school,
    accessToken,
    schools: list,
    namedSchool: profile && (list.length > 1 || named) ? profile.schoolId : null,
    huvudman,
    huvudmanMember: marked || list.some((one) => Boolean(one.huvudman)),
    schoolsUnavailable: false,
  };
});

export function homePathForRole(role: Profile["role"]): string {
  switch (role) {
    case "SCHOOL_ADMIN":
      return "/admin";
    case "TEACHER":
      return "/teacher";
    case "STUDENT":
      return "/student";
    case "GUARDIAN":
      return "/guardian";
  }
}
