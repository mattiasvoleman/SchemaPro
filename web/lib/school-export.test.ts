import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { downloadSchoolExport } from "@/lib/school-export";

/**
 * The fetch of the whole-school zip: the session's token and the page's
 * school go with it, a refusal is the gateway's code, a body shorter than the
 * length it announced is refused, and a whole one is handed to the browser
 * under the name the page gave it.
 */

const session = vi.hoisted(() => ({ data: { session: { access_token: "tok" } as { access_token: string } | null } }));
vi.mock("@/utils/supabase/client", () => ({ createClient: () => ({ auth: { getSession: async () => session } }) }));
vi.mock("@/lib/school-choice", () => ({ pageSchool: () => "school-1", schoolHeaders: (school?: string) => (school ? { "X-School-Id": school } : {}) }));

describe("downloadSchoolExport", () => {
  const click = vi.fn();
  let fetched: Array<[string, RequestInit | undefined]>;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "https://api.test");
    session.data.session = { access_token: "tok" };
    fetched = [];
    click.mockReset();
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) => (tag === "a" ? ({ click, set href(_v: string) {}, set download(_v: string) {} } as unknown as HTMLAnchorElement) : document.createElementNS("http://www.w3.org/1999/xhtml", tag))) as never);
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
  });

  const answer = (init: ResponseInit, body: BodyInit | null) => vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => (fetched.push([String(url), options]), new Response(body, init)));

  it("is refused without a session, before any request", async () => {
    session.data.session = null;
    const spy = answer({ status: 200 }, "x");
    await expect(downloadSchoolExport("e1", "x.zip")).rejects.toMatchObject({ status: 401 });
    expect(spy).not.toHaveBeenCalled();
  });

  it("asks for the file with the token and the page's school, and saves a whole body", async () => {
    answer({ status: 200, headers: { "Content-Length": "3" } }, new Uint8Array([1, 2, 3]));
    await downloadSchoolExport("e 1", "rastra-skolexport-2026-11-05.zip");
    expect(fetched[0]![0]).toBe("https://api.test/api/v1/school-exports/e%201/file");
    expect(fetched[0]![1]).toMatchObject({ headers: { Authorization: "Bearer tok", "X-School-Id": "school-1" } });
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("says the gateway's code for a refusal, and nothing is saved", async () => {
    answer({ status: 410 }, JSON.stringify({ message: "Filen har gått ut", code: "SCHOOL_EXPORT_EXPIRED" }));
    await expect(downloadSchoolExport("e1", "x.zip")).rejects.toMatchObject({ status: 410, code: "SCHOOL_EXPORT_EXPIRED" });
    expect(click).not.toHaveBeenCalled();
  });

  it("keeps the status when the refusal has no JSON body", async () => {
    answer({ status: 502 }, "<html>bad gateway</html>");
    await expect(downloadSchoolExport("e1", "x.zip")).rejects.toBeInstanceOf(ApiError);
  });

  it("refuses a body shorter than the length announced", async () => {
    answer({ status: 200, headers: { "Content-Length": "10" } }, new Uint8Array([1, 2, 3]));
    await expect(downloadSchoolExport("e1", "x.zip")).rejects.toMatchObject({ status: 502, code: "SCHOOL_EXPORT_INCOMPLETE" });
    expect(click).not.toHaveBeenCalled();
  });
});
