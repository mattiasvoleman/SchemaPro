import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ABSENCE_STATS_KEYS,
  useClassesStats,
  useClassPupils,
  useClassStats,
  usePupilStats,
  useSchoolStats,
} from "./absence-stats-queries";

/**
 * What goes over the wire to /api/v1/absence-stats: the routes and the query,
 * and what is kept afterwards. The gateway's routes are the contract
 * (src/absence-stats/absence-stats.controller.ts).
 */

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api", () => ({ api }));

const BASE = "/api/v1/absence-stats";
const PERIOD = { from: "2025-08-01", to: "2026-06-30" };

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue({});
});

describe("reading", () => {
  it("asks for the school with no dates, and for the classes with the period only when there is one", async () => {
    const { wrapper } = setup();
    renderHook(() => useSchoolStats(), { wrapper });
    renderHook(() => useClassesStats(null), { wrapper });
    renderHook(() => useClassesStats(PERIOD), { wrapper });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(3));
    expect(api.get.mock.calls.map(([path]) => path).sort()).toEqual(
      [`${BASE}/school`, `${BASE}/classes`, `${BASE}/classes?from=2025-08-01&to=2026-06-30`].sort(),
    );
  });

  it("asks for a class, its pupils and a pupil by id, with the period", async () => {
    const { wrapper } = setup();
    renderHook(() => useClassStats("c-1", PERIOD), { wrapper });
    renderHook(() => useClassPupils("c-1", PERIOD, true), { wrapper });
    renderHook(() => usePupilStats("s-1", null), { wrapper });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(3));
    expect(api.get.mock.calls.map(([path]) => path).sort()).toEqual(
      [
        `${BASE}/classes/c-1?from=2025-08-01&to=2026-06-30`,
        `${BASE}/classes/c-1/pupils?from=2025-08-01&to=2026-06-30`,
        `${BASE}/pupils/s-1`,
      ].sort(),
    );
  });

  it("asks for nothing without a class or a pupil, and for no pupils when the reader may not have them", async () => {
    const { wrapper } = setup();
    renderHook(() => useClassStats(null, null), { wrapper });
    renderHook(() => useClassPupils(null, null, true), { wrapper });
    renderHook(() => useClassPupils("c-1", null, false), { wrapper });
    renderHook(() => usePupilStats(null, null), { wrapper });
    await Promise.resolve();
    expect(api.get).not.toHaveBeenCalled();
  });

  it("keeps a period of its own in the cache, for every read", () => {
    expect(ABSENCE_STATS_KEYS.classes(null)).not.toEqual(ABSENCE_STATS_KEYS.classes(PERIOD));
    expect(ABSENCE_STATS_KEYS.classView("c-1", null)).not.toEqual(ABSENCE_STATS_KEYS.classView("c-1", PERIOD));
    expect(ABSENCE_STATS_KEYS.classView("c-1", null)).not.toEqual(ABSENCE_STATS_KEYS.classView("c-2", null));
    expect(ABSENCE_STATS_KEYS.classPupils("c-1", null)).not.toEqual(ABSENCE_STATS_KEYS.classPupils("c-1", PERIOD));
    expect(ABSENCE_STATS_KEYS.pupil("s-1", null)).not.toEqual(ABSENCE_STATS_KEYS.pupil("s-2", null));
  });

  it("keeps the classes on screen, dimmed, while the next period loads", async () => {
    let release!: (value: unknown) => void;
    api.get.mockResolvedValueOnce({ classes: [{ classId: "c-1" }] });
    const { wrapper } = setup();
    const { result, rerender } = renderHook(({ period }) => useClassesStats(period), {
      wrapper,
      initialProps: { period: null as typeof PERIOD | null },
    });
    await waitFor(() => expect(result.current.data).toEqual({ classes: [{ classId: "c-1" }] }));
    api.get.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    rerender({ period: PERIOD });
    await waitFor(() => expect(result.current.isPlaceholderData).toBe(true));
    expect(result.current.data).toEqual({ classes: [{ classId: "c-1" }] });
    release({ classes: [] });
    await waitFor(() => expect(result.current.isPlaceholderData).toBe(false));
  });
});

describe("what is read about a pupil", () => {
  it("leaves the cache the moment the list or the card is closed", async () => {
    api.get.mockResolvedValue({ pupils: [{ studentId: "s-1" }] });
    const { client, wrapper } = setup();
    const list = renderHook(() => useClassPupils("c-1", null, true), { wrapper });
    const card = renderHook(() => usePupilStats("s-1", null), { wrapper });
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(card.result.current.isSuccess).toBe(true));
    expect(client.getQueryCache().findAll({ queryKey: ABSENCE_STATS_KEYS.all })).toHaveLength(2);

    list.unmount();
    card.unmount();
    await waitFor(() => expect(client.getQueryCache().findAll({ queryKey: ABSENCE_STATS_KEYS.all })).toHaveLength(0));
  });

  it("is asked again on the next open, never answered from the cache", async () => {
    const { wrapper } = setup();
    const first = renderHook(() => usePupilStats("s-1", null), { wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    first.unmount();
    const second = renderHook(() => usePupilStats("s-1", null), { wrapper });
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it("writes nothing to the browser's storage", async () => {
    const local = vi.spyOn(Storage.prototype, "setItem");
    const { wrapper } = setup();
    const card = renderHook(() => usePupilStats("s-1", null), { wrapper });
    await waitFor(() => expect(card.result.current.isSuccess).toBe(true));
    expect(local).not.toHaveBeenCalled();
    local.mockRestore();
  });
});
