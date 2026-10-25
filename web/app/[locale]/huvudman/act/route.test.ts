import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

/**
 * POST /[locale]/huvudman/act: the huvudman's pages' forms (Huvudman). The
 * gateway is fetch; which request it is sent and where the browser goes back
 * to are the contract.
 */

const H = "55555555-5555-4555-8555-555555555555";
const S = "66666666-6666-4666-8666-666666666666";

const state = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_BASE_URL = "https://api.example";
  return { signedIn: true };
});
vi.mock("@/lib/auth", () => ({
  getSession: async () => (state.signedIn ? { accessToken: "token", schools: [] } : null),
}));

const post = (fields: Record<string, string>, headers: Record<string, string> = { origin: "https://web.example", "sec-fetch-site": "same-origin" }) =>
  POST(
    new NextRequest("https://web.example/sv/huvudman/act", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(fields).toString(),
    }),
    { params: Promise.resolve({ locale: "sv" }) },
  );

describe("POST /[locale]/huvudman/act", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    state.signedIn = true;
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("asks for a school by its slug, with the session's token and no school named, and says which", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: S, name: "Ekbacken" }), { status: 201 }));

    const response = await post({ action: "request", huvudman: H, slug: "Ekbacken" });

    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.example/api/v1/huvudman/${H}/requests`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ slug: "ekbacken" }) }),
    );
    const headers = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer token");
    expect(headers["x-school-id"]).toBeUndefined();
    expect(response.status).toBe(303);
    const to = new URL(response.headers.get("location")!);
    expect(to.pathname).toBe("/sv/huvudman");
    expect(to.hash).toBe("#huvudman-result");
    // The school's id, which the page names from its own list: never words the URL brings.
    expect(Object.fromEntries(to.searchParams)).toEqual({ h: H, done: "doneRequested", school: S });
  });

  it("goes back with the gateway's code when it refuses", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: "HUVUDMAN_SCHOOL_HAS_A_HUVUDMAN" }), { status: 409 }));

    const response = await post({ action: "request", huvudman: H, slug: "granen" });

    expect(new URL(response.headers.get("location")!).searchParams.get("error")).toBe("HUVUDMAN_SCHOOL_HAS_A_HUVUDMAN");
  });

  it.each([
    [{ action: "withdraw", school: S }, "DELETE", `/requests/${S}`, "doneWithdrawn"],
    [{ action: "release", school: S, confirmed: "yes" }, "DELETE", `/schools/${S}`, "doneReleased"],
    [{ action: "revoke", key: S, confirmed: "yes" }, "DELETE", `/keys/${S}`, "doneRevoked"],
    [{ action: "member", member: S, isActive: "false", confirmed: "yes" }, "PATCH", `/members/${S}`, "doneUpdated"],
    [{ action: "member", member: S, isActive: "true" }, "PATCH", `/members/${S}`, "doneUpdated"],
  ])("%o is %s %s", async (fields, method, path, done) => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    const response = await post({ huvudman: H, ...fields });

    expect(fetchMock).toHaveBeenCalledWith(`https://api.example/api/v1/huvudman/${H}${path}`, expect.objectContaining({ method }));
    expect(new URL(response.headers.get("location")!).searchParams.get("done")).toBe(done);
  });

  it.each([
    [{ action: "release", school: S }, "release"],
    [{ action: "revoke", key: S }, "revoke"],
    [{ action: "member", member: S, isActive: "false" }, "member"],
  ])("%o is asked first and sends nothing until confirmed", async (fields, confirm) => {
    const response = await post({ huvudman: H, ...fields });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status).toBe(303);
    const to = new URL(response.headers.get("location")!);
    expect(to.hash).toBe("#huvudman-confirm");
    expect(Object.fromEntries(to.searchParams)).toEqual({ h: H, confirm, target: S });
  });

  it("sends the member's change as the gateway reads it", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await post({ huvudman: H, action: "member", member: S, role: "KOMMUNADMINISTRATOR" });
    expect(fetchMock.mock.calls[0]![1].body).toBe(JSON.stringify({ role: "KOMMUNADMINISTRATOR" }));
  });

  it("builds no path from a value that is no id, and asks the gateway nothing", async () => {
    const forms: Array<Record<string, string>> = [
      { action: "withdraw", huvudman: H, school: "../keys" },
      { action: "release", huvudman: "x", school: S },
      { action: "nothing", huvudman: H },
    ];
    for (const fields of forms) {
      const response = await post(fields);
      expect(response.status).toBe(303);
      expect(new URL(response.headers.get("location")!).searchParams.get("error")).toBe("errorOther");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a form another site's page made the browser send", async () => {
    const response = await post({ action: "release", huvudman: H, school: S }, { origin: "https://evil.example", "sec-fetch-site": "cross-site" });
    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends a session that has ended to sign in", async () => {
    state.signedIn = false;
    const response = await post({ action: "release", huvudman: H, school: S });
    expect(new URL(response.headers.get("location")!).pathname).toBe("/sv/login");
  });
});
