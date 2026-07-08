import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { type NextRequest, type NextResponse } from "next/server";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

type CookieToSet = { name: string; value: string; options: CookieOptions };

/**
 * Refreshes the Supabase auth session and writes any rotated cookies onto the
 * provided response (which may be a next-intl redirect/rewrite response).
 * Returns the verified JWT claims, or null when the caller is signed out.
 */
export const updateSession = async (
  request: NextRequest,
  response: NextResponse,
): Promise<Record<string, unknown> | null> => {
  const supabase = createServerClient(supabaseUrl!, supabaseKey!, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: CookieToSet[]) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value),
        );
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  // IMPORTANT: getClaims() refreshes the auth token and must run on every
  // request so Server Components always receive a valid session.
  const { data } = await supabase.auth.getClaims();
  return data?.claims ?? null;
};
