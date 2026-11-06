import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  REPORTING_RATE_KEYS,
  useMyReportingRate,
  useReportingActions,
  useReportingRate,
  useReportingSettings,
} from "./reporting-rate-queries";

/**
 * What goes over the wire to /api/v1/reporting-rate: the routes, the verbs and
 * the bodies, and what is read again after a write. The gateway's routes are
 * the contract (src/reporting-rate/reporting-rate.controller.ts).
 */

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock("@/lib/api", () => ({ api }));

const SETTINGS = { teacherReminders: true, rektorDigest: false, openAfterDays: 2 };

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue(SETTINGS);
  api.put.mockResolvedValue(SETTINGS);
});

describe("reading", () => {
  it("asks for the school's figures by period, and names the day only when the reader moved off today", async () => {
    const { wrapper } = setup();
    const today = renderHook(() => useReportingRate("WEEK", null), { wrapper });
    await waitFor(() => expect(today.result.current.isSuccess).toBe(true));
    const moved = renderHook(() => useReportingRate("MONTH", "2026-10-31"), { wrapper });
    await waitFor(() => expect(moved.result.current.isSuccess).toBe(true));
    expect(api.get.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/reporting-rate?period=WEEK",
      "/api/v1/reporting-rate?period=MONTH&anchor=2026-10-31",
    ]);
  });

  it("keeps a period of its own in the cache: the same period around another day is another read", () => {
    expect(REPORTING_RATE_KEYS.school("WEEK", null)).not.toEqual(REPORTING_RATE_KEYS.school("WEEK", "2026-11-02"));
    expect(REPORTING_RATE_KEYS.school("WEEK", null)).not.toEqual(REPORTING_RATE_KEYS.school("MONTH", null));
  });

  it("keeps the figures on screen while the next period loads", async () => {
    let release!: (value: unknown) => void;
    api.get.mockResolvedValueOnce({ period: "WEEK", teachers: [] });
    const { wrapper } = setup();
    const { result, rerender } = renderHook(({ anchor }: { anchor: string | null }) => useReportingRate("WEEK", anchor), {
      wrapper,
      initialProps: { anchor: null as string | null },
    });
    await waitFor(() => expect(result.current.data).toEqual({ period: "WEEK", teachers: [] }));
    api.get.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    rerender({ anchor: "2026-10-26" });
    await waitFor(() => expect(result.current.isPlaceholderData).toBe(true));
    expect(result.current.data).toEqual({ period: "WEEK", teachers: [] });
    release({ period: "WEEK", teachers: [{ teacherId: "t-1" }] });
    await waitFor(() => expect(result.current.isPlaceholderData).toBe(false));
  });

  it("reads the settings and the teacher's own page from their routes", async () => {
    const { wrapper } = setup();
    const settings = renderHook(() => useReportingSettings(), { wrapper });
    await waitFor(() => expect(settings.result.current.data).toEqual(SETTINGS));
    const mine = renderHook(() => useMyReportingRate(), { wrapper });
    await waitFor(() => expect(mine.result.current.isSuccess).toBe(true));
    expect(api.get.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/reporting-rate/settings",
      "/api/v1/reporting-rate/mine",
    ]);
  });

  it("does not retry a refusal: a failed read is shown at once", async () => {
    api.get.mockRejectedValue(new Error("403"));
    const { wrapper } = setup();
    const { result } = renderHook(() => useMyReportingRate(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(api.get).toHaveBeenCalledTimes(1);
  });
});

describe("writing", () => {
  it("PUTs what changed and keeps the answer as the settings", async () => {
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useReportingActions(), { wrapper });
    api.put.mockResolvedValueOnce({ ...SETTINGS, rektorDigest: true });
    await act(() => result.current.updateSettings.mutateAsync({ rektorDigest: true }));
    expect(api.put).toHaveBeenCalledWith("/api/v1/reporting-rate/settings", { rektorDigest: true });
    expect(client.getQueryData(REPORTING_RATE_KEYS.settings)).toEqual({ ...SETTINGS, rektorDigest: true });
  });

  it("reads the settings again after a refused save, because the set on screen may be stale", async () => {
    api.put.mockRejectedValue(new Error("400"));
    const { wrapper } = setup();
    const settings = renderHook(() => useReportingSettings(), { wrapper });
    await waitFor(() => expect(settings.result.current.isSuccess).toBe(true));
    const { result } = renderHook(() => useReportingActions(), { wrapper });
    const before = api.get.mock.calls.length;
    await act(() => result.current.updateSettings.mutateAsync({ openAfterDays: 99 }).catch(() => undefined));
    await waitFor(() => expect(api.get.mock.calls.length).toBeGreaterThan(before));
  });
});
