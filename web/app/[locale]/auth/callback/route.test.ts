import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

/**
 * /auth/callback: the PKCE code exchange of "Logga in med skolkonto". The
 * Supabase server client is mocked; what it is asked and where the browser
 * is sent are the contract.
 */

const exchange = vi.hoisted(() => vi.fn());
const cookieStore = vi.hoisted(() => ({ getAll: vi.fn(() => []), set: vi.fn() }));

vi.mock("next/headers", () => ({ cookies: async () => cookieStore }));
vi.mock("@/utils/supabase/server", () => ({
  createClient: () => ({ auth: { exchangeCodeForSession: exchange } }),
}));

const call = (query: string, locale = "sv") =>
  GET(new NextRequest(`https://web.example/${locale}/auth/callback${query}`), {
    params: Promise.resolve({ locale }),
  });

beforeEach(() => {
  exchange.mockReset();
});

describe("GET /[locale]/auth/callback", () => {
  it("exchanges the code and sends the person to the locale root, which picks their home", async () => {
    exchange.mockResolvedValue({ error: null });
    const response = await call("?code=abc123");
    expect(exchange).toHaveBeenCalledWith("abc123");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://web.example/sv");
  });

  it("names the hook's refusals on the way back to /login", async () => {
    exchange.mockResolvedValue({ error: { message: "sso_identity_not_allowed", status: 403 } });
    expect((await call("?code=abc123", "en")).headers.get("location")).toBe("https://web.example/en/login?sso=other-organisation");
    exchange.mockResolvedValue({ error: { message: "sso_not_enabled", status: 403 } });
    expect((await call("?code=abc123")).headers.get("location")).toBe("https://web.example/sv/login?sso=not-enabled");
  });

  it("reads any other failed exchange as failed, a thrown one too", async () => {
    exchange.mockResolvedValue({ error: { message: "invalid flow state, no valid flow state found", code: "flow_state_not_found" } });
    expect((await call("?code=abc123")).headers.get("location")).toBe("https://web.example/sv/login?sso=failed");
    exchange.mockRejectedValue(new Error("network"));
    expect((await call("?code=abc123")).headers.get("location")).toBe("https://web.example/sv/login?sso=failed");
  });

  it("names Auth's own refusal from the URL, error_code before error, without exchanging anything", async () => {
    expect((await call("?error=access_denied&error_code=signup_disabled&error_description=Signups+not+allowed")).headers.get("location")).toBe(
      "https://web.example/sv/login?sso=no-account",
    );
    expect((await call("?error=access_denied&error_description=AADSTS65001")).headers.get("location")).toBe(
      "https://web.example/sv/login?sso=cancelled",
    );
    expect((await call("")).headers.get("location")).toBe("https://web.example/sv/login?sso=failed");
    expect(exchange).not.toHaveBeenCalled();
  });

  it("never sends the browser anywhere the URL names", async () => {
    exchange.mockResolvedValue({ error: null });
    const response = await call("?code=abc&next=https://evil.example/&redirect_to=//evil.example", "xx");
    expect(response.headers.get("location")).toBe("https://web.example/sv");
  });
});
