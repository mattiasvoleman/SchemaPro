import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ABSENCE_WATCH_KEYS, useAbsenceWatchActions, useAbsenceWatchFindings, useAbsenceWatchOverview } from "./absence-watch-queries";

/**
 * What goes over the wire to /api/v1/absence-watch: the routes, the verbs and
 * the bodies, and what is read again after a write. The gateway's routes are
 * the contract (src/absence-watch/absence-watch.controller.ts).
 */

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock("@/lib/api", () => ({ api }));

const OVERVIEW = { settings: { enabled: true, enabledOn: "2026-10-12", cadence: { MENTOR: "WEEKLY", REKTOR: "WEEKLY", KANSLI: "WEEKLY", GUARDIAN: "MONTHLY" } }, limits: [] };

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue(OVERVIEW);
  api.put.mockResolvedValue(OVERVIEW);
  api.post.mockResolvedValue({});
  api.delete.mockResolvedValue(undefined);
});

describe("reading", () => {
  it("reads the overview from the route's root", async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useAbsenceWatchOverview(), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(OVERVIEW));
    expect(api.get).toHaveBeenCalledWith("/api/v1/absence-watch");
  });

  it("asks for the recent findings with recent=1, and the open ones with nothing", async () => {
    const { wrapper } = setup();
    const open = renderHook(() => useAbsenceWatchFindings(false), { wrapper });
    await waitFor(() => expect(open.result.current.isSuccess).toBe(true));
    const recent = renderHook(() => useAbsenceWatchFindings(true), { wrapper });
    await waitFor(() => expect(recent.result.current.isSuccess).toBe(true));
    expect(api.get.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/absence-watch/findings",
      "/api/v1/absence-watch/findings?recent=1",
    ]);
  });

  it("does not retry a refusal: a failed read is shown at once", async () => {
    api.get.mockRejectedValue(new Error("403"));
    const { wrapper } = setup();
    const { result } = renderHook(() => useAbsenceWatchFindings(false), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(api.get).toHaveBeenCalledTimes(1);
  });
});

describe("writing", () => {
  it("PUTs the settings named and keeps the answer as the overview", async () => {
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useAbsenceWatchActions(), { wrapper });
    await act(() => result.current.updateSettings.mutateAsync({ enabled: true, kansliCadence: "MONTHLY" }));
    expect(api.put).toHaveBeenCalledWith("/api/v1/absence-watch/settings", { enabled: true, kansliCadence: "MONTHLY" });
    expect(client.getQueryData(ABSENCE_WATCH_KEYS.overview)).toEqual(OVERVIEW);
  });

  it("POSTs a limit and PUTs a limit's figures to its own route", async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useAbsenceWatchActions(), { wrapper });
    await act(() => result.current.createLimit.mutateAsync({ recipientGroup: "MENTOR", kind: "CONSECUTIVE", basis: "ALL", consecutiveDays: 5 }));
    await act(() => result.current.updateLimit.mutateAsync({ id: "l-1", percent: 20, windowDays: 30 }));
    expect(api.post).toHaveBeenCalledWith("/api/v1/absence-watch/limits", { recipientGroup: "MENTOR", kind: "CONSECUTIVE", basis: "ALL", consecutiveDays: 5 });
    expect(api.put).toHaveBeenCalledWith("/api/v1/absence-watch/limits/l-1", { percent: 20, windowDays: 30 });
  });

  it("reads the overview again after a limit is added, even when it was refused (a 409 says the list is stale)", async () => {
    api.post.mockRejectedValue(new Error("409"));
    const { client, wrapper } = setup();
    const overview = renderHook(() => useAbsenceWatchOverview(), { wrapper });
    await waitFor(() => expect(overview.result.current.isSuccess).toBe(true));
    const { result } = renderHook(() => useAbsenceWatchActions(), { wrapper });
    const before = api.get.mock.calls.length;
    await act(() => result.current.createLimit.mutateAsync({ recipientGroup: "MENTOR", kind: "CONSECUTIVE", basis: "ALL", consecutiveDays: 5 }).catch(() => undefined));
    await waitFor(() => expect(api.get.mock.calls.length).toBeGreaterThan(before));
    expect(client.isFetching()).toBe(0);
  });

  it("DELETEs a limit and reads the findings again, because the database closes the ones it made", async () => {
    const { wrapper } = setup();
    const findings = renderHook(() => useAbsenceWatchFindings(false), { wrapper });
    await waitFor(() => expect(findings.result.current.isSuccess).toBe(true));
    const { result } = renderHook(() => useAbsenceWatchActions(), { wrapper });
    const before = api.get.mock.calls.length;
    await act(() => result.current.deleteLimit.mutateAsync("l-9"));
    expect(api.delete).toHaveBeenCalledWith("/api/v1/absence-watch/limits/l-9");
    await waitFor(() => expect(api.get.mock.calls.slice(before).map(([path]) => path)).toContain("/api/v1/absence-watch/findings"));
  });
});
