import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serverApiGet } from "./server-api";

/**
 * The server components' gateway read (the admin dashboard's people and
 * attendance figures since the läslogg). It must never throw: a figure it
 * could not read is a "—" and a notice on the page, never a failed render.
 */

const fetchMock = vi.fn();

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "https://api.test//");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("serverApiGet", () => {
  it("asks the gateway as the user, uncached, and returns the body", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ byRole: { STUDENT: 412 } }));

    const result = await serverApiGet("/api/v1/users/counts", "tok-1");

    expect(result).toEqual({ data: { byRole: { STUDENT: 412 } } });
    // The base's trailing slashes are stripped: `//api/v1/...` is a route the gateway 404s.
    expect(fetchMock).toHaveBeenCalledWith("https://api.test/api/v1/users/counts", {
      headers: { Authorization: "Bearer tok-1" },
      cache: "no-store",
    });
  });

  it("answers a refusal with its status, not a body", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: "Forbidden" }, 403));
    expect(await serverApiGet("/api/v1/attendance/summary?since=2026-10-06", "tok-1")).toEqual({
      error: "HTTP 403",
    });
  });

  it("answers a gateway that cannot be reached with the reason, without throwing", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    expect(await serverApiGet("/api/v1/users/counts", "tok-1")).toEqual({ error: "fetch failed" });
  });

  it("asks nothing without a token or a configured gateway", async () => {
    expect(await serverApiGet("/api/v1/users/counts", undefined)).toEqual({
      error: "Not authenticated.",
    });
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "");
    expect(await serverApiGet("/api/v1/users/counts", "tok-1")).toEqual({
      error: "NEXT_PUBLIC_API_BASE_URL is not configured.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
