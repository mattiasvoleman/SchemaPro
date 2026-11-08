import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { downloadMealCsv, MEAL_KEYS, rangeQuery, useMealActions, useMealCounts, useMealSettings } from "./meal-counts-queries";

/**
 * What goes over the wire to /api/v1/meal-counts: the routes, the verbs, the bodies, what is read again after
 * a write, and the file's fetch. The gateway's routes are the contract (src/meal-counts/meal-counts.controller.ts).
 */

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));

const session = vi.hoisted(() => ({ data: { session: { access_token: "tok" } as { access_token: string } | null } }));
vi.mock("@/utils/supabase/client", () => ({ createClient: () => ({ auth: { getSession: async () => session } }) }));
vi.mock("@/lib/school-choice", () => ({ pageSchool: () => "school-1", schoolHeaders: (school?: string) => (school ? { "X-School-Id": school } : {}) }));

const SETTINGS = { cutoffTime: "08:30", letterEnabled: false, kitchenEmail: null, lastLetterOn: null };

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue(SETTINGS);
  api.put.mockResolvedValue({ ...SETTINGS, cutoffTime: "09:00" });
});

describe("reading", () => {
  it("asks for days from the school's own today, and names the day only when the reader moved off it", async () => {
    expect(rangeQuery(null, 7)).toBe("days=7");
    expect(rangeQuery("2027-02-11", 1)).toBe("days=1&from=2027-02-11");
    const { wrapper } = setup();
    const week = renderHook(() => useMealCounts(null, 7), { wrapper });
    await waitFor(() => expect(week.result.current.isSuccess).toBe(true));
    const day = renderHook(() => useMealCounts("2027-02-11", 1), { wrapper });
    await waitFor(() => expect(day.result.current.isSuccess).toBe(true));
    expect(api.get.mock.calls.map(([path]) => path)).toEqual(["/api/v1/meal-counts?days=7", "/api/v1/meal-counts?days=1&from=2027-02-11"]);
  });

  it("asks nothing while it is not wanted", async () => {
    const { wrapper } = setup();
    renderHook(() => useMealCounts("2027-02-11", 1, false), { wrapper });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.get).not.toHaveBeenCalled();
  });

  it("keeps a range of its own in the cache", () => {
    expect(MEAL_KEYS.counts(null, 7)).not.toEqual(MEAL_KEYS.counts(null, 1));
    expect(MEAL_KEYS.counts(null, 1)).not.toEqual(MEAL_KEYS.counts("2027-02-11", 1));
  });

  it("reads the settings from their own route", async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useMealSettings(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.get).toHaveBeenCalledWith("/api/v1/meal-counts/settings");
  });
});

describe("saving", () => {
  it("puts what changed, keeps the answer as the settings, and reads the counts again (the cut-off decides what they take off)", async () => {
    const { client, wrapper } = setup();
    client.setQueryData(MEAL_KEYS.counts(null, 7), { days: [] });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useMealActions(), { wrapper });
    await act(async () => {
      await result.current.updateSettings.mutateAsync({ cutoffTime: "09:00" });
    });
    expect(api.put).toHaveBeenCalledWith("/api/v1/meal-counts/settings", { cutoffTime: "09:00" });
    expect(client.getQueryData(MEAL_KEYS.settings)).toEqual({ ...SETTINGS, cutoffTime: "09:00" });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["mealCounts", "counts"] });
  });

  it("reads the settings again when a save is refused, since what is on screen may be stale", async () => {
    api.put.mockRejectedValueOnce(new ApiError(400, "no", "MEAL_LETTER_NEEDS_ADDRESS_AND_HOUR"));
    const { client, wrapper } = setup();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useMealActions(), { wrapper });
    await act(async () => {
      await expect(result.current.updateSettings.mutateAsync({ letterEnabled: true })).rejects.toBeInstanceOf(ApiError);
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: MEAL_KEYS.settings });
  });
});

describe("downloadMealCsv", () => {
  const click = vi.fn();
  let fetched: Array<[string, RequestInit | undefined]>;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "https://api.test/");
    session.data.session = { access_token: "tok" };
    fetched = [];
    click.mockReset();
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) => (tag === "a" ? ({ click, set href(_v: string) {}, set download(_v: string) {} } as unknown as HTMLAnchorElement) : document.createElementNS("http://www.w3.org/1999/xhtml", tag))) as never);
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
  });

  const answer = (init: ResponseInit, body: BodyInit | null) =>
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => (fetched.push([String(url), options]), new Response(body, init)));

  it("is refused without a session, before any request", async () => {
    session.data.session = null;
    const spy = answer({ status: 200 }, "x");
    await expect(downloadMealCsv(null, 7, "x.csv")).rejects.toMatchObject({ status: 401 });
    expect(spy).not.toHaveBeenCalled();
  });

  it("is refused where the gateway's address is not configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "");
    const spy = answer({ status: 200 }, "x");
    await expect(downloadMealCsv(null, 7, "x.csv")).rejects.toMatchObject({ status: 0 });
    expect(spy).not.toHaveBeenCalled();
  });

  it("asks for the days with the token and the page's school, and hands the bytes to the browser unread", async () => {
    answer({ status: 200 }, new Uint8Array([0x66, 0x72, 0xe5, 0x6e]));
    await downloadMealCsv("2027-02-11", 1, "portioner-2027-02-11.csv");
    expect(fetched[0]![0]).toBe("https://api.test/api/v1/meal-counts/csv?days=1&from=2027-02-11");
    expect(fetched[0]![1]).toMatchObject({ headers: { Authorization: "Bearer tok", "X-School-Id": "school-1" } });
    expect(click).toHaveBeenCalledTimes(1);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("says the gateway's code for a refusal, and nothing is saved", async () => {
    answer({ status: 400 }, JSON.stringify({ message: "Antalen gäller dagar från och med i dag.", code: "MEAL_COUNTS_PAST" }));
    await expect(downloadMealCsv("2020-01-01", 1, "x.csv")).rejects.toMatchObject({ status: 400, code: "MEAL_COUNTS_PAST" });
    expect(click).not.toHaveBeenCalled();
  });

  it("keeps the status when the refusal has no JSON body", async () => {
    answer({ status: 502 }, "<html>bad gateway</html>");
    await expect(downloadMealCsv(null, 7, "x.csv")).rejects.toMatchObject({ status: 502, message: "HTTP 502" });
    expect(click).not.toHaveBeenCalled();
  });
});
