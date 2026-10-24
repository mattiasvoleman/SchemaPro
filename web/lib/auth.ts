import "server-only";
import { cookies } from "next/headers";
import { cache } from "react";
import { createClient } from "@/utils/supabase/server";
import { SCHOOL_COOKIE, schoolHeaders, schoolIdOf } from "@/lib/school-choice";
import type { MySchool, Profile, School } from "@/lib/types";

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
}

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/+$/, "");

/**
 * The app_metadata mark the gateway sets on a login that rows at more than
 * one school hold (SupabaseAdminService.markSeveralSchools in the gateway).
 * app_metadata is the service role's to write, and getUser() reads it from
 * Supabase Auth on every page.
 */
export const SEVERAL_SCHOOLS = "rastraSeveralSchools";

/** How long a page waits for the login's schools before it renders without the switcher. */
export const SCHOOLS_TIMEOUT_MS = 1000;

/**
 * The login's schools from the gateway, or none when it cannot be asked in
 * time: the page then shows the profile's school without a switcher, as it
 * did.
 */
async function schoolsOf(accessToken: string | null, school: string | null): Promise<MySchool[]> {
  if (!API_BASE_URL || !accessToken) return [];
  try {
    const response = await fetch(`${API_BASE_URL}/api/v1/me/schools`, {
      headers: { Authorization: `Bearer ${accessToken}`, ...schoolHeaders(school) },
      cache: "no-store",
      signal: AbortSignal.timeout(SCHOOLS_TIMEOUT_MS),
    });
    if (!response.ok) return [];
    const body = (await response.json()) as unknown;
    return Array.isArray(body) ? (body as MySchool[]) : [];
  } catch {
    return [];
  }
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

  const several = user.app_metadata?.[SEVERAL_SCHOOLS] === true || chosen !== null;
  const tokenRead = supabase.auth.getSession().then((result) => result.data.session?.access_token ?? null);
  const [firstProfile, accessToken, firstSchools] = await Promise.all([
    profileOf(supabase),
    tokenRead,
    several ? tokenRead.then((token) => schoolsOf(token, chosen)) : Promise.resolve([]),
  ]);

  let profile = firstProfile;
  let schools = firstSchools;
  let named = chosen;
  if (!profile && chosen) {
    named = null;
    [profile, schools] = await Promise.all([
      profileOf(createClient(cookieStore, { school: null })),
      schoolsOf(accessToken, null),
    ]);
  }

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
    schools,
    namedSchool: profile && (schools.length > 1 || named) ? profile.schoolId : null,
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
