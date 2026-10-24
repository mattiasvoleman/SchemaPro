import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MySchool } from "@/lib/types";
import { POST } from "./route";

/**
 * POST /[locale]/skola: the school switcher's form (Flera skolor per
 * inloggning). getSession is mocked; which school the browser is told to
 * remember, and where it is sent, are the contract.
 */

const A = "33333333-3333-4333-8333-333333333333";
const B = "44444444-4444-4444-8444-444444444444";
const C = "55555555-5555-4555-8555-555555555555";

const session = vi.hoisted(() => ({ current: null as null | { schools: MySchool[] } }));
vi.mock("@/lib/auth", async (original) => ({
  ...(await original<typeof import("@/lib/auth")>()),
  getSession: async () => session.current,
}));

const school = (id: string, role: MySchool["role"], extra: Partial<MySchool> = {}): MySchool => ({
  schoolId: id,
  schoolName: id === A ? "Ekbacken" : "Granen",
  role,
  adminProfile: role === "SCHOOL_ADMIN" ? "FULL" : null,
  closed: null,
  current: false,
  ...extra,
});

const post = (
  chosen: string | null,
  headers: Record<string, string> = { origin: "https://web.example", "sec-fetch-site": "same-origin" },
  locale = "sv",
) => {
  const body = new URLSearchParams();
  if (chosen !== null) body.set("school", chosen);
  return POST(
    new NextRequest(`https://web.example/${locale}/skola`, {
      method: "POST",
      body,
      headers: { "content-type": "application/x-www-form-urlencoded", host: "web.example", ...headers },
    }),
    { params: Promise.resolve({ locale }) },
  );
};

beforeEach(() => {
  session.current = {
    schools: [
      school(A, "TEACHER", { current: true }),
      school(B, "SCHOOL_ADMIN"),
      school(C, "GUARDIAN", { closed: "sso_required" }),
    ],
  };
});

describe("POST /[locale]/skola", () => {
  it("remembers a school of the login's and sends the browser to that role's start page", async () => {
    const response = await post(B.toUpperCase());
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://web.example/sv/admin");
    const cookie = response.cookies.get("rastra_school");
    expect(cookie?.value).toBe(B);
    expect(cookie).toMatchObject({ path: "/", sameSite: "lax", secure: true, httpOnly: false });
  });

  it("changes nothing for a school the login has no row in, or one the session may not enter", async () => {
    for (const chosen of ["66666666-6666-4666-8666-666666666666", C, "skolan", null]) {
      const response = await post(chosen);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("https://web.example/sv");
      expect(response.cookies.get("rastra_school")).toBeUndefined();
    }
  });

  it("refuses a form another site's page made the browser send", async () => {
    for (const headers of [
      { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      { origin: "https://evil.example" },
      { "sec-fetch-site": "same-site" },
      {},
    ]) {
      const response = await post(B, headers as Record<string, string>);
      expect(response.status).toBe(403);
      expect(response.cookies.get("rastra_school")).toBeUndefined();
    }
  });

  it("accepts its own host behind the proxy, as the forwarded host says it", async () => {
    const response = await post(B, { origin: "https://app.rastra.example", "x-forwarded-host": "app.rastra.example" });
    expect(response.status).toBe(303);
    expect(response.cookies.get("rastra_school")?.value).toBe(B);
  });

  it("sends somebody signed out to the login, in their language", async () => {
    session.current = null;
    const response = await post(B, undefined, "en");
    expect(response.headers.get("location")).toBe("https://web.example/en/login");
  });
});
