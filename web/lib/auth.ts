import "server-only";
import { cookies } from "next/headers";
import { cache } from "react";
import { createClient } from "@/utils/supabase/server";
import type { Profile, School } from "@/lib/types";

export interface SessionInfo {
  authId: string;
  email: string | null;
  profile: Profile | null;
  school: School | null;
  accessToken: string | null;
}

/**
 * Resolves the caller's Supabase session plus their SchemaPro profile row
 * (Users table, scoped by RLS to the caller's own record). Cached per request.
 */
export const getSession = cache(async (): Promise<SessionInfo | null> => {
  const cookieStore = await cookies();
  const supabase = createClient(cookieStore);

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const [{ data: profile }, sessionResult] = await Promise.all([
    supabase
      .from("Users")
      .select("id, authId, schoolId, role, firstName, lastName, email, studentGroupId")
      .eq("authId", user.id)
      .maybeSingle(),
    supabase.auth.getSession(),
  ]);

  let school: School | null = null;
  if (profile) {
    const { data } = await supabase
      .from("Schools")
      .select("id, name, slug, timezone")
      .eq("id", (profile as Profile).schoolId)
      .maybeSingle();
    school = (data as School | null) ?? null;
  }

  return {
    authId: user.id,
    email: user.email ?? null,
    profile: (profile as Profile | null) ?? null,
    school,
    accessToken: sessionResult.data.session?.access_token ?? null,
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
  }
}
