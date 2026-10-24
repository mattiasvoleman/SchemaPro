/**
 * Flera skolor per inloggning: a login has one profile per school, and every
 * request says which school it is about.
 *
 * - The browser remembers the school it chose in a cookie, one per browser
 *   like the login itself. The server reads it (lib/auth.ts, the admin
 *   overview's counts) and names the school to PostgREST.
 * - A page names the school it was rendered for in a <meta>, written by the
 *   (app) layout. The browser's clients send that school, not the cookie's,
 *   so a tab left open on one school never writes in another after a switch
 *   in another tab. ProfileProvider reloads such a tab when it is looked at
 *   again (components/profile-context.tsx).
 * - Only a session with more than one school writes the meta, and only the
 *   switcher sets the cookie: a person with one school sends exactly the
 *   requests they always sent, and the database gives them their one row.
 *
 * The gateway reads the header as X-School-Id (src/auth/school-choice.ts),
 * PostgREST hands it to the database as request.headers, and a school the
 * login has no row in is answered with no row, never another school.
 */
export const SCHOOL_COOKIE = "rastra_school";
export const SCHOOL_HEADER = "x-school-id";
export const SCHOOL_META = "rastra-school";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A school id as the cookie, a form or the meta carry it: lower case, or null. */
export function schoolIdOf(value: string | null | undefined): string | null {
  const id = value?.trim().toLowerCase();
  return id && UUID.test(id) ? id : null;
}

/** The headers that name `school`, or none when there is none to name. */
export function schoolHeaders(school: string | null | undefined): Record<string, string> {
  const id = schoolIdOf(school);
  return id ? { [SCHOOL_HEADER]: id } : {};
}

/** The school this page was rendered for (the layout's <meta>); null on a page with one school. */
export function pageSchool(): string | null {
  if (typeof document === "undefined") return null;
  return schoolIdOf(document.querySelector<HTMLMetaElement>(`meta[name="${SCHOOL_META}"]`)?.content);
}

/** The school the browser's cookie names now, which a switch in another tab may have changed. */
export function cookieSchool(): string | null {
  if (typeof document === "undefined") return null;
  const entry = document.cookie.split("; ").find((part) => part.startsWith(`${SCHOOL_COOKIE}=`));
  return schoolIdOf(entry?.slice(SCHOOL_COOKIE.length + 1));
}
