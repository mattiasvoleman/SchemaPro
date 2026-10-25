import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The huvudman's pages ask the gateway with a bound (LOW 8 of #202's
 * review): a read 2 s, so the page's two reads in a row say "could not
 * read" within 4 s; a write 10 s, since an invitation waits on Supabase.
 */

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_BASE_URL = "https://api.example";
});
vi.mock("server-only", () => ({}));

import { HUVUDMAN_READ_TIMEOUT_MS, HUVUDMAN_WRITE_TIMEOUT_MS, huvudmanGateway } from "./huvudman";

describe("huvudmanGateway", () => {
  const timeout = vi.spyOn(AbortSignal, "timeout");

  beforeEach(() => {
    timeout.mockClear();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("bounds a read at 2 s and a write at 10 s", async () => {
    expect(HUVUDMAN_READ_TIMEOUT_MS).toBe(2000);
    expect(HUVUDMAN_WRITE_TIMEOUT_MS).toBe(10_000);
    await huvudmanGateway("token", "GET", "/api/v1/huvudman");
    expect(timeout).toHaveBeenLastCalledWith(2000);
    await huvudmanGateway("token", "POST", "/api/v1/huvudman/h/members", { email: "a@b.se" });
    expect(timeout).toHaveBeenLastCalledWith(10_000);
  });

  it("answers status 0 when the gateway does not answer in time", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }));
    await expect(huvudmanGateway("token", "GET", "/api/v1/huvudman")).resolves.toEqual({ status: 0, body: null, code: null });
  });
});
