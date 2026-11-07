import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The proxy in front of every route. Schemavisaren (/v/…) must pass straight
 * through: not under a locale (next-intl would redirect it to /sv/v/…), not
 * through the Supabase session refresh (which writes auth cookies and sends
 * anyone without a session to /login), and tagged noindex and no-referrer.
 * Everything else keeps the gate it had.
 */

const intl = vi.hoisted(() => vi.fn());
vi.mock("next-intl/middleware", () => ({ default: () => intl }));
const updateSession = vi.hoisted(() => vi.fn());
vi.mock("@/utils/supabase/middleware", () => ({ updateSession }));

const { proxy } = await import("./proxy");
const { NextResponse } = await import("next/server");

describe("proxy", () => {
  beforeEach(() => {
    intl.mockReset().mockImplementation(() => NextResponse.next());
    updateSession.mockReset().mockResolvedValue(null);
  });

  it("lets a share link through with no locale, no session and no cookie, tagged noindex and no-referrer", async () => {
    const response = await proxy(new NextRequest(`https://schema.example.se/v/${"A".repeat(43)}?date=2026-10-12`));
    expect(intl).not.toHaveBeenCalled();
    expect(updateSession).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("set-cookie")).toBeNull();
    // The layout's <html lang>: Swedish unless ?lang=en, whatever the browser sent.
    expect(response.headers.get("x-middleware-request-x-viewer-lang")).toBe("sv");
    const english = await proxy(
      new NextRequest(`https://schema.example.se/v/${"A".repeat(43)}?lang=en`, { headers: { "x-viewer-lang": "xx" } }),
    );
    expect(english.headers.get("x-middleware-request-x-viewer-lang")).toBe("en");
  });

  it("lets the page where a code is typed (/v) through as it does a link: no locale, no session, no cookie", async () => {
    for (const path of ["/v", "/v/", "/v?code=K7QM2-X9DRT-4V8WN-B5C3H"]) {
      const response = await proxy(new NextRequest(`https://schema.example.se${path}`));
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
      expect(response.headers.get("set-cookie")).toBeNull();
    }
    expect(intl).not.toHaveBeenCalled();
    expect(updateSession).not.toHaveBeenCalled();
    // Only /v itself and what is under it: /vad is an app path like any other.
    await proxy(new NextRequest("https://schema.example.se/vad"));
    expect(intl).toHaveBeenCalledTimes(1);
  });

  describe("a staff member who holds a session (the viewer for staff)", () => {
    const cookie = "sb-abcdefgh-auth-token=stale.jwt";

    it("has the session refreshed, the new one forwarded to the page and written back to the browser", async () => {
      updateSession.mockImplementation(async (request: NextRequest, response: Awaited<ReturnType<typeof proxy>>) => {
        request.cookies.set("sb-abcdefgh-auth-token", "fresh.jwt");
        response.cookies.set("sb-abcdefgh-auth-token", "fresh.jwt", { path: "/", httpOnly: true, sameSite: "lax" });
        return { sub: "u" };
      });
      const response = await proxy(
        new NextRequest(`https://schema.example.se/v/${"A".repeat(43)}`, { headers: { cookie: `other=1; ${cookie}` } }),
      );
      expect(updateSession).toHaveBeenCalledTimes(1);
      expect(intl).not.toHaveBeenCalled();
      // What the page reads: the refreshed token, not the one already spent.
      expect(response.headers.get("x-middleware-request-cookie")).toContain("sb-abcdefgh-auth-token=fresh.jwt");
      expect(response.headers.get("x-middleware-request-cookie")).not.toContain("stale.jwt");
      expect(response.headers.get("set-cookie")).toContain("sb-abcdefgh-auth-token=fresh.jwt");
      // And still no redirect to the login, still unframed and unindexed.
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    });

    it("is served all the same when the refresh fails, and a split cookie (sb-….0) counts as a session", async () => {
      updateSession.mockRejectedValueOnce(new Error("auth is down"));
      const response = await proxy(
        new NextRequest(`https://schema.example.se/v/${"A".repeat(43)}`, { headers: { cookie: "sb-abcdefgh-auth-token.0=part" } }),
      );
      expect(updateSession).toHaveBeenCalledTimes(1);
      expect(response.headers.get("x-middleware-request-x-viewer-lang")).toBe("sv");
      expect(response.headers.get("set-cookie")).toBeNull();
    });

    it("is not touched on the frame of a link: the embed page never reads the session", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 404 }), { status: 404 }));
      vi.stubGlobal("fetch", fetchMock);
      try {
        const response = await proxy(
          new NextRequest(`https://schema.example.se/v/K7QM2-X9DRT-4V8WN-B5C3H/embed`, { headers: { cookie } }),
        );
        expect(updateSession).not.toHaveBeenCalled();
        expect(response.headers.get("set-cookie")).toBeNull();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("is not asked of a visitor with no Supabase cookie: no session is opened, none written", async () => {
      const response = await proxy(
        new NextRequest(`https://schema.example.se/v/${"A".repeat(43)}`, { headers: { cookie: "theme=dark; rastra_school=x" } }),
      );
      expect(updateSession).not.toHaveBeenCalled();
      expect(response.headers.get("set-cookie")).toBeNull();
    });
  });

  it("lets a visitor without a session read the tillgänglighetsredogörelse, in either language", async () => {
    for (const path of ["/sv/tillganglighet", "/en/tillganglighet"]) {
      const response = await proxy(new NextRequest(`https://schema.example.se${path}`));
      expect(response.headers.get("location")).toBeNull();
    }
  });

  it("lets no website frame a viewer page", async () => {
    const response = await proxy(new NextRequest(`https://schema.example.se/v/${"A".repeat(43)}`));
    expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  describe("a share link's frame (/v/<token>/embed)", () => {
    const fetchMock = vi.fn();
    beforeEach(async () => {
      const { forgetEmbedPolicies } = await import("@/lib/embed-policy");
      forgetEmbedPolicies();
      fetchMock.mockReset();
      vi.stubGlobal("fetch", fetchMock);
      vi.stubEnv("PUBLIC_VIEWER_API_BASE_URL", "http://gateway.internal");
      vi.stubEnv("PUBLIC_VIEWER_PROXY_KEY", "k".repeat(40));
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    });

    it("lets the school's websites frame it, asking the gateway with the viewer's address beside the key", async () => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ frameAncestors: ["https://www.skolan.se"] }), { status: 200 }));
      const response = await proxy(
        new NextRequest(`https://schema.example.se/v/${"B".repeat(43)}/embed?date=2026-10-12`, {
          headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.9" },
        }),
      );
      expect(response.headers.get("content-security-policy")).toBe("frame-ancestors https://www.skolan.se");
      // X-Frame-Options cannot name a site; frame-ancestors decides for every browser that reads it.
      expect(response.headers.get("x-frame-options")).toBeNull();
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(fetchMock).toHaveBeenCalledWith(
        `http://gateway.internal/public/v1/timetables/${"B".repeat(43)}/embed`,
        expect.objectContaining({
          headers: { "X-Viewer-Proxy-Key": "k".repeat(40), "X-Viewer-Client-Ip": "203.0.113.9", Accept: "application/json" },
        }),
      );
      expect(intl).not.toHaveBeenCalled();
      expect(updateSession).not.toHaveBeenCalled();
    });

    it("frames a link's code however it is written, asking the gateway for the one address", async () => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ frameAncestors: ["https://www.skolan.se"] }), { status: 200 }));
      const response = await proxy(new NextRequest("https://schema.example.se/v/k7qm2%20x9drt%204v8wn%20b5c3h/embed"));
      expect(response.headers.get("content-security-policy")).toBe("frame-ancestors https://www.skolan.se");
      expect(fetchMock).toHaveBeenCalledWith(
        "http://gateway.internal/public/v1/timetables/K7QM2-X9DRT-4V8WN-B5C3H/embed",
        expect.anything(),
      );
    });

    it("shuts the frame of an address that is no link without asking anyone", async () => {
      const response = await proxy(new NextRequest("https://schema.example.se/v/short/embed"));
      expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("shuts the frame when the link may not be embedded, or the gateway does not answer", async () => {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: 404 }), { status: 404 }));
      const refused = await proxy(new NextRequest(`https://schema.example.se/v/${"C".repeat(43)}/embed`));
      expect(refused.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
      expect(refused.headers.get("x-frame-options")).toBe("DENY");
      fetchMock.mockRejectedValueOnce(new Error("down"));
      const down = await proxy(new NextRequest(`https://schema.example.se/v/${"D".repeat(43)}/embed`));
      expect(down.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
      expect(down.headers.get("x-frame-options")).toBe("DENY");
    });
  });

  it("still sends a visitor without a session from an app page to the login", async () => {
    const response = await proxy(new NextRequest("https://schema.example.se/sv/admin/publishing"));
    expect(updateSession).toHaveBeenCalled();
    expect(response.headers.get("location")).toBe("https://schema.example.se/sv/login");
  });
});
