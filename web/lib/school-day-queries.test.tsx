import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import {
  NOT_OPEN,
  REFRESH_MS,
  SCHOOL_DAY_KEYS,
  isNotOpen,
  useSchoolDay,
  useSchoolDayActions,
  useSchoolDayFree,
  useSchoolDaySettings,
} from "./school-day-queries";

/**
 * What goes over the wire to /api/v1/school-day: the routes, the verbs and the
 * bodies, and what the page does with the answer. The gateway's routes are the
 * contract (src/school-day/school-day.controller.ts).
 */

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue({});
  api.put.mockResolvedValue({ teacherView: "ALL" });
});

describe("the grids", () => {
  it("asks for a range of days, a day being from == to", async () => {
    const { wrapper } = setup();
    const day = renderHook(() => useSchoolDay("2026-11-03", "2026-11-03"), { wrapper });
    await waitFor(() => expect(day.result.current.isSuccess).toBe(true));
    const week = renderHook(() => useSchoolDay("2026-11-02", "2026-11-08"), { wrapper });
    await waitFor(() => expect(week.result.current.isSuccess).toBe(true));
    expect(api.get.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/school-day?from=2026-11-03&to=2026-11-03",
      "/api/v1/school-day?from=2026-11-02&to=2026-11-08",
    ]);
  });

  it("keeps a range of its own in the cache, and asks again once a minute for a screen left open", () => {
    expect(SCHOOL_DAY_KEYS.grid("2026-11-02", "2026-11-08")).not.toEqual(SCHOOL_DAY_KEYS.grid("2026-11-03", "2026-11-03"));
    expect(REFRESH_MS).toBe(60_000);
  });

  it("keeps the last range on screen while the next one loads", async () => {
    let release!: (value: unknown) => void;
    api.get.mockResolvedValueOnce({ days: [{ date: "2026-11-03" }] });
    const { wrapper } = setup();
    const { result, rerender } = renderHook(({ date }: { date: string }) => useSchoolDay(date, date), {
      wrapper,
      initialProps: { date: "2026-11-03" },
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    api.get.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    rerender({ date: "2026-11-04" });
    await waitFor(() => expect(result.current.isPlaceholderData).toBe(true));
    expect(result.current.data).toEqual({ days: [{ date: "2026-11-03" }] });
    await act(async () => release({ days: [{ date: "2026-11-04" }] }));
    await waitFor(() => expect(result.current.isPlaceholderData).toBe(false));
    expect(result.current.data).toEqual({ days: [{ date: "2026-11-04" }] });
  });
});

describe("the finder", () => {
  it("asks nothing until an interval has been submitted", () => {
    const { wrapper } = setup();
    renderHook(() => useSchoolDayFree(null), { wrapper });
    expect(api.get).not.toHaveBeenCalled();
  });

  it("asks for the date and the interval it was given", async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useSchoolDayFree({ date: "2026-11-03", from: "10:00", to: "11:00" }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.get).toHaveBeenCalledWith("/api/v1/school-day/free?date=2026-11-03&from=10:00&to=11:00");
  });

  it("keeps an interval of its own in the cache", () => {
    const one = SCHOOL_DAY_KEYS.free({ date: "2026-11-03", from: "10:00", to: "11:00" });
    expect(one).not.toEqual(SCHOOL_DAY_KEYS.free({ date: "2026-11-03", from: "10:00", to: "12:00" }));
    expect(one).not.toEqual(SCHOOL_DAY_KEYS.free({ date: "2026-11-04", from: "10:00", to: "11:00" }));
  });
});

describe("the school's decision", () => {
  it("reads what a teacher has", async () => {
    api.get.mockResolvedValue({ teacherView: "ROOMS" });
    const { wrapper } = setup();
    const { result } = renderHook(() => useSchoolDaySettings(), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual({ teacherView: "ROOMS" }));
    expect(api.get).toHaveBeenCalledWith("/api/v1/school-day/settings");
  });

  it("saves the choice as it stands and shows the answer at once", async () => {
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useSchoolDayActions(), { wrapper });
    await act(async () => {
      await result.current.updateSettings.mutateAsync("ALL");
    });
    expect(api.put).toHaveBeenCalledWith("/api/v1/school-day/settings", { teacherView: "ALL" });
    expect(client.getQueryData(SCHOOL_DAY_KEYS.settings)).toEqual({ teacherView: "ALL" });
  });

  it("reads the decision again after a refused save, since what is on screen may be stale", async () => {
    api.put.mockRejectedValueOnce(new ApiError(403, "no"));
    const { client, wrapper } = setup();
    client.setQueryData(SCHOOL_DAY_KEYS.settings, { teacherView: "NONE" });
    const { result } = renderHook(() => useSchoolDayActions(), { wrapper });
    await act(async () => {
      await result.current.updateSettings.mutateAsync("ALL").catch(() => undefined);
    });
    expect(client.getQueryState(SCHOOL_DAY_KEYS.settings)?.isInvalidated).toBe(true);
  });
});

describe("a school that has not opened the page for teachers", () => {
  it("is told by the gateway's code and nothing else: another 403, or another code, is an error", () => {
    expect(isNotOpen(new ApiError(403, "x", NOT_OPEN))).toBe(true);
    expect(isNotOpen(new ApiError(403, "x"))).toBe(false);
    expect(isNotOpen(new ApiError(500, "x", NOT_OPEN))).toBe(false);
    expect(isNotOpen(new Error("x"))).toBe(false);
    expect(isNotOpen(null)).toBe(false);
  });
});
