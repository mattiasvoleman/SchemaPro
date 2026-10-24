import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MySchool } from "@/lib/types";

/**
 * getSession (Flera skolor per inloggning): which pages ask the gateway for
 * the login's schools. Only a login the gateway marked as several schools',
 * or a browser that chose a school, and then for SCHOOLS_TIMEOUT_MS at most;
 * every other page renders on what it reads from Supabase, as before.
 * Supabase and next/headers are stand-ins; the gateway is fetch.
 */

const A = "33333333-3333-4333-8333-333333333333";
const B = "44444444-4444-4444-8444-444444444444";
const AUTH = "11111111-1111-4111-8111-111111111111";

const state = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_BASE_URL = "https://api.example";
  return {
    cookie: undefined as string | undefined,
    appMetadata: {} as Record<string, unknown>,
    // The profile row PostgREST shows for the school a client names ("" for none).
    rows: {} as Record<string, { id: string; schoolId: string; role: string } | null>,
  };
});

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "rastra_school" && state.cookie ? { value: state.cookie } : undefined),
    getAll: () => [],
  }),
}));

vi.mock("@/utils/supabase/server", () => ({
  createClient: (_store: unknown, options: { school?: string | null } = {}) => {
    const named = (options.school === undefined ? state.cookie : options.school) ?? "";
    const read = (table: string) => ({
      select: () => ({
        eq: (_column: string, value: string) => ({
          maybeSingle: async () => ({
            data: table === "Users" ? (state.rows[named] ?? null) : { id: value, name: `school ${value}`, slug: "s", timezone: "Europe/Stockholm" },
          }),
        }),
      }),
    });
    return {
      auth: {
        getUser: async () => ({ data: { user: { id: AUTH, email: "anna@example.invalid", app_metadata: state.appMetadata } } }),
        getSession: async () => ({ data: { session: { access_token: "token" } } }),
      },
      from: read,
    };
  },
}));

const row = (schoolId: string) => ({ id: `row-${schoolId}`, schoolId, role: "TEACHER" });
const school = (schoolId: string, current: boolean): MySchool => ({
  schoolId,
  schoolName: schoolId === A ? "Ekbacken" : "Granen",
  role: "TEACHER",
  adminProfile: null,
  closed: null,
  current,
});
const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("getSession, the login's schools", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    state.cookie = undefined;
    state.appMetadata = { provider: "email" };
    state.rows = { "": row(A), [A]: row(A) };
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const load = async () => (await import("./auth")).getSession();

  it("does not ask the gateway for a login with one school: the page renders on Supabase alone", async () => {
    const session = await load();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(session?.profile?.schoolId).toBe(A);
    expect(session?.schools).toEqual([]);
    expect(session?.namedSchool).toBeNull();
  });

  it("asks for a marked login's schools, with a deadline, and names the page's school", async () => {
    const { SEVERAL_SCHOOLS } = await import("./auth");
    state.appMetadata = { provider: "email", [SEVERAL_SCHOOLS]: true };
    fetchMock.mockResolvedValue(answer([school(A, true), school(B, false)]));

    const session = await load();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example/api/v1/me/schools");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(session?.schools.map((one) => one.schoolId)).toEqual([A, B]);
    expect(session?.namedSchool).toBe(A);
  });

  it("renders a marked login's page without the switcher, not without its school, when the gateway does not answer in time", async () => {
    const { SEVERAL_SCHOOLS } = await import("./auth");
    state.appMetadata = { [SEVERAL_SCHOOLS]: true };
    fetchMock.mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"));

    const session = await load();

    expect(session?.profile?.schoolId).toBe(A);
    expect(session?.school?.id).toBe(A);
    expect(session?.schools).toEqual([]);
    expect(session?.namedSchool).toBeNull();
  });

  it("asks when the browser chose a school, so that a choice this login cannot use is replaced", async () => {
    // Another person's choice on this browser: no row of this login there.
    state.cookie = B;
    fetchMock.mockResolvedValueOnce(answer({ code: "SCHOOL_NOT_AVAILABLE" }, 403)).mockResolvedValueOnce(answer([school(A, true)]));

    const session = await load();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(session?.profile?.schoolId).toBe(A);
    expect(session?.schools.map((one) => one.schoolId)).toEqual([A]);
    expect(session?.namedSchool).toBeNull();
  });
});
