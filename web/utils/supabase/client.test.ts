import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchNamingTheSchool } from "./client";

/**
 * Flera skolor per inloggning: the browser's Supabase client lives for the
 * whole tab, so it reads the page's school as each request goes out, and
 * names it to PostgREST alone.
 */
describe("fetchNamingTheSchool", () => {
  const A = "33333333-3333-4333-8333-333333333333";
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("[]"));
  const headersOf = (n: number) => new Headers(fetchMock.mock.calls[n]?.[1]?.headers);
  const sent = () => fetchMock.mock.calls.map((_call, n) => headersOf(n).get("x-school-id"));

  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.head.querySelectorAll('meta[name="rastra-school"]').forEach((meta) => meta.remove());
  });

  it("sends nothing new on a page that names no school", async () => {
    await fetchNamingTheSchool("https://x.supabase.co/rest/v1/Rooms?select=id", { headers: { apikey: "k" } });
    expect(sent()).toEqual([null]);
  });

  it("names the page's school as the request goes out, to PostgREST, keeping the request's own headers", async () => {
    await fetchNamingTheSchool("https://x.supabase.co/rest/v1/Rooms", { headers: { apikey: "k" } });
    const meta = document.createElement("meta");
    meta.name = "rastra-school";
    meta.content = A;
    document.head.append(meta);
    await fetchNamingTheSchool("https://x.supabase.co/rest/v1/Rooms", { headers: { apikey: "k" } });
    await fetchNamingTheSchool(new URL("https://x.supabase.co/rest/v1/Subjects"));
    expect(sent()).toEqual([null, A, A]);
    expect(headersOf(1).get("apikey")).toBe("k");
  });

  it("never names it to Auth", async () => {
    const meta = document.createElement("meta");
    meta.name = "rastra-school";
    meta.content = A;
    document.head.append(meta);
    await fetchNamingTheSchool("https://x.supabase.co/auth/v1/token?grant_type=refresh_token", { method: "POST" });
    expect(sent()).toEqual([null]);
  });
});
