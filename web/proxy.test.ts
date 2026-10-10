import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  });

  it("still sends a visitor without a session from an app page to the login", async () => {
    const response = await proxy(new NextRequest("https://schema.example.se/sv/admin/publishing"));
    expect(updateSession).toHaveBeenCalled();
    expect(response.headers.get("location")).toBe("https://schema.example.se/sv/login");
  });
});
