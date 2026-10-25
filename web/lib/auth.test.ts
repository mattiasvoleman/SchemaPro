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

describe("getSession, the huvudman's reader (Huvudman)", () => {
  const fetchMock = vi.fn();
  const HUVUDMAN = { id: "h-1", name: "Vimmerby kommun", role: "PLANERARE" as const, memberId: "m-1", firstName: "Pia", lastName: "Planerare" };
  const reads = (schoolId: string, current = false): MySchool => ({
    schoolId,
    schoolName: "Granen",
    role: "SCHOOL_ADMIN",
    adminProfile: "LASARE",
    closed: null,
    current,
    huvudman: HUVUDMAN,
  });

  beforeEach(() => {
    state.cookie = undefined;
    state.appMetadata = { provider: "email", rastraHuvudman: true };
    // A member with no row anywhere.
    state.rows = { "": null };
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const load = async () => (await import("./auth")).getSession();

  it("asks the gateway for a member's schools, and leaves a member with no school chosen without a profile", async () => {
    fetchMock.mockResolvedValue(answer([reads(B)]));

    const session = await load();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(session?.profile).toBeNull();
    expect(session?.huvudmanMember).toBe(true);
    expect(session?.huvudman).toBeNull();
  });

  it("reads a school its huvudman owns as the läsare, with the membership's id and the member's name", async () => {
    state.cookie = B;
    fetchMock.mockResolvedValue(answer([reads(B, true)]));

    const session = await load();

    expect(session?.profile).toMatchObject({
      id: "m-1",
      schoolId: B,
      role: "SCHOOL_ADMIN",
      adminProfile: "LASARE",
      hrRead: false,
      firstName: "Pia",
      lastName: "Planerare",
      studentGroupId: null,
    });
    expect(session?.huvudman).toEqual(HUVUDMAN);
    // The browser names the school, so PostgREST and the gateway answer for the reader there.
    expect(session?.namedSchool).toBe(B);
    expect(session?.school?.id).toBe(B);
  });

  it("does not read a school as the huvudman's when the session may not enter it", async () => {
    state.cookie = B;
    fetchMock.mockResolvedValue(answer([{ ...reads(B), closed: "sso_required" }]));

    const session = await load();

    expect(session?.profile).toBeNull();
    expect(session?.huvudman).toBeNull();
    // Read again with no school named, which the browser then follows.
    const named = fetchMock.mock.calls.map(([, init]) => (init as { headers: Record<string, string> }).headers["x-school-id"] ?? null);
    expect(named).toEqual([B, null]);
    expect(session?.namedSchool).toBeNull();
  });

  it("asks a second time, for longer, when the first ask found nothing at the school chosen", async () => {
    state.cookie = B;
    // The first ask times out (the page's 1 s); the second answers.
    fetchMock.mockRejectedValueOnce(new DOMException("timed out", "TimeoutError")).mockResolvedValueOnce(answer([reads(B, true)]));

    const session = await load();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(session?.profile).toMatchObject({ id: "m-1", schoolId: B, adminProfile: "LASARE" });
    expect(session?.namedSchool).toBe(B);
  });

  it("keeps the choice and says the school could not be read when neither ask answers, sending the member nowhere else", async () => {
    state.cookie = B;
    fetchMock.mockResolvedValue(answer({ code: "TOO_MANY_REQUESTS" }, 429));

    const session = await load();

    // The first ask and the second: a 429 is no list, and no third read with no school named.
    const named = fetchMock.mock.calls.map(([, init]) => (init as { headers: Record<string, string> }).headers["x-school-id"] ?? null);
    expect(named).toEqual([B, B]);
    expect(session?.schoolsUnavailable).toBe(true);
    expect(session?.profile).toBeNull();
    expect(session?.huvudmanMember).toBe(true);
  });

  it("finds a member whose mark was lost through the login's list, when the login has no row at all", async () => {
    state.appMetadata = { provider: "email" };
    fetchMock.mockResolvedValue(answer([reads(B)]));

    const session = await load();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(session?.profile).toBeNull();
    // The start page then sends them to the huvudman's pages, whose read marks the login.
    expect(session?.huvudmanMember).toBe(true);
    expect(session?.schoolsUnavailable).toBe(false);
  });

  it("asks only once for a login that is no member, whose own row is the only profile there is", async () => {
    state.cookie = B;
    state.appMetadata = { provider: "email" };
    state.rows = { "": row(A) };
    fetchMock.mockRejectedValue(new DOMException("timed out", "TimeoutError"));

    await load();

    // The first ask, then the read with no school named: no second, longer ask.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const named = fetchMock.mock.calls.map(([, init]) => (init as { headers: Record<string, string> }).headers["x-school-id"] ?? null);
    expect(named).toEqual([B, null]);
  });

  it("keeps an own row first: a member with a row at the school chosen is that row there", async () => {
    state.cookie = A;
    state.rows = { [A]: row(A) };
    fetchMock.mockResolvedValue(answer([school(A, true)]));

    const session = await load();

    expect(session?.profile?.id).toBe(`row-${A}`);
    expect(session?.huvudman).toBeNull();
  });
});
