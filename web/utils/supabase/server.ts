import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import { SCHOOL_COOKIE, schoolHeaders } from "@/lib/school-choice";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

type CookieToSet = { name: string; value: string; options: CookieOptions };

/**
 * The server's client for one request. It names the school the browser chose
 * (the switcher's cookie, lib/school-choice.ts) to PostgREST, unless `school`
 * says otherwise: `null` names none, which reads the login's first school.
 */
export const createClient = (
  cookieStore: Awaited<ReturnType<typeof cookies>>,
  options: { school?: string | null } = {},
) => {
  const school = options.school === undefined ? cookieStore.get(SCHOOL_COOKIE)?.value : options.school;
  return createServerClient(supabaseUrl!, supabaseKey!, {
    global: { headers: schoolHeaders(school) },
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: CookieToSet[]) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // The `setAll` method was called from a Server Component.
          // This can be ignored if you have middleware refreshing
          // user sessions.
        }
      },
    },
  });
};
