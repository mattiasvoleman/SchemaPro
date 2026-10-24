import { createBrowserClient } from "@supabase/ssr";
import { pageSchool, SCHOOL_HEADER } from "@/lib/school-choice";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

/**
 * The browser's fetch for Supabase, which names the school of the page the
 * request is made from to PostgREST (lib/school-choice.ts), read as each
 * request goes out: @supabase/ssr hands back one client per browser tab
 * whatever page made it first, and a client made on /login, where no school
 * is named, lives on into the app after a sign-in that does not reload the
 * page. Only PostgREST's requests carry it, and only on a page of a session
 * with more than one school: Auth's never do.
 */
export const fetchNamingTheSchool: typeof fetch = (input, init) => {
  const school = pageSchool();
  if (!school || !urlOf(input).includes("/rest/v1/")) return fetch(input, init);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set(SCHOOL_HEADER, school);
  return fetch(input, { ...init, headers });
};

export const createClient = () =>
  createBrowserClient(supabaseUrl!, supabaseKey!, { global: { fetch: fetchNamingTheSchool } });
