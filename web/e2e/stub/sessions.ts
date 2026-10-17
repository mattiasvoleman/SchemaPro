import type { UserRole } from "../../lib/types";

/**
 * The four people the signed-in suites sign in as, and the Supabase session
 * cookie that makes the app believe them.
 *
 * Nothing here is a credential. The token is an HS256 JWT whose signature is
 * the word "stub": supabase-js decodes it, sees a
 * symmetric algorithm, and asks /auth/v1/user whether it is valid — which the
 * stub server answers from `sub`. The real gateway and the real Supabase
 * project would reject it outright.
 */

/** Where the stub listens. The app is built against this origin (playwright.config.ts). */
export const STUB_PORT = Number(process.env.E2E_STUB_PORT ?? 54329);
export const STUB_ORIGIN = `http://127.0.0.1:${STUB_PORT}`;

/**
 * @supabase/ssr names its cookie after the first label of the project's
 * hostname: https://abc.supabase.co → sb-abc-auth-token, 127.0.0.1 → sb-127-….
 */
export const AUTH_COOKIE = `sb-${new URL(STUB_ORIGIN).hostname.split(".")[0]}-auth-token`;

export type Persona = "admin" | "teacher" | "student" | "guardian";

export interface SignedInPerson {
  persona: Persona;
  role: UserRole;
  /** auth.users.id — the JWT's sub. */
  authId: string;
  /** Users.id — the profile row. */
  userId: string;
  email: string;
}

// Version-4-shaped ids, so nothing that validates a uuid trips on them.
export const uid = (kind: number, n: number) =>
  `${kind.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

export const KIND = {
  auth: 0xa0,
  school: 0x01,
  year: 0x02,
  user: 0x10,
  group: 0x20,
  subject: 0x30,
  room: 0x40,
  roomType: 0x41,
  requirement: 0x50,
  masterLesson: 0x60,
  calendarLesson: 0x61,
  attendance: 0x62,
  constraint: 0x70,
  misc: 0x90,
} as const;

export const PEOPLE: Record<Persona, SignedInPerson> = {
  admin: {
    persona: "admin",
    role: "SCHOOL_ADMIN",
    authId: uid(KIND.auth, 1),
    userId: uid(KIND.user, 1),
    email: "rektor@exempelskolan.example",
  },
  teacher: {
    persona: "teacher",
    role: "TEACHER",
    authId: uid(KIND.auth, 2),
    userId: uid(KIND.user, 101),
    email: "anna.lind@exempelskolan.example",
  },
  student: {
    persona: "student",
    role: "STUDENT",
    authId: uid(KIND.auth, 3),
    userId: uid(KIND.user, 301),
    email: "elev.ella@exempelskolan.example",
  },
  guardian: {
    persona: "guardian",
    role: "GUARDIAN",
    authId: uid(KIND.auth, 4),
    userId: uid(KIND.user, 501),
    email: "vardnadshavare@exempelskolan.example",
  },
};

/**
 * A läsare (Läsbehörighet, 20261120090000): an administrator whose profile
 * writes nothing, signed in to read every admin page read-only. The admin's
 * persona, so the stub's gateway answers it as it answers the administrator;
 * what differs is the profile its own Users row carries (world.ts
 * PROFILE_ROWS), which is what the app reads. Not one of the school's people:
 * no page lists it, so the other suites see the school they always saw.
 */
export const READER: SignedInPerson = {
  persona: "admin",
  role: "SCHOOL_ADMIN",
  authId: uid(KIND.auth, 5),
  userId: uid(KIND.user, 2),
  email: "lasare@exempelskolan.example",
};

/**
 * Someone signed in whom no school knows: an auth user with no Users row, so
 * the (app) layout sends them to /no-profile — the one way to reach that page.
 * Their persona is a pupil's, but no page reads anything for them.
 */
export const ORPHAN: SignedInPerson = {
  persona: "student",
  role: "STUDENT",
  authId: uid(KIND.auth, 9),
  userId: uid(KIND.user, 999),
  email: "okand@exempelskolan.example",
};

const base64url = (text: string) => Buffer.from(text).toString("base64url");

/** 2100-01-01: never refreshed, never expired, during any test run. */
const NEVER = 4_102_444_800;

export function accessToken(person: SignedInPerson): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      sub: person.authId,
      email: person.email,
      aud: "authenticated",
      role: "authenticated",
      iat: 1_760_000_000,
      exp: NEVER,
    }),
  );
  return `${header}.${payload}.${base64url("stub")}`;
}

export function authUser(person: SignedInPerson) {
  return {
    id: person.authId,
    aud: "authenticated",
    role: "authenticated",
    email: person.email,
    app_metadata: { provider: "email", providers: ["email"] },
    user_metadata: {},
    created_at: "2026-08-01T08:00:00.000Z",
  };
}

/** The person a bearer token names, or null for anything the stub did not mint. */
export function personForToken(token: string | null | undefined): SignedInPerson | null {
  if (!token) return null;
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as { sub?: string };
    return [...Object.values(PEOPLE), READER, ORPHAN].find((person) => person.authId === payload.sub) ?? null;
  } catch {
    return null;
  }
}

/** The cookie value @supabase/ssr reads: `base64-` + base64url(session JSON). */
export function sessionCookieValue(person: SignedInPerson): string {
  const session = {
    access_token: accessToken(person),
    refresh_token: "stub-refresh",
    token_type: "bearer",
    expires_in: NEVER - 1_760_000_000,
    expires_at: NEVER,
    user: authUser(person),
  };
  return `base64-${base64url(JSON.stringify(session))}`;
}
