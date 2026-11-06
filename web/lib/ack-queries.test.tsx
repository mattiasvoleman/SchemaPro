import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACK_KEYS,
  useAckActions,
  useAckDetail,
  useAckList,
  useAckMine,
  useAckPupils,
  useAckSettings,
} from "./ack-queries";
import type { AckMine } from "./ack";

/**
 * What goes over the wire to /api/v1/acknowledgements: the routes, the verbs
 * and the bodies, and what is read again after a write. The gateway's routes
 * are the contract (src/ack/ack.controller.ts).
 */

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock("@/lib/api", () => ({ api }));

const BASE = "/api/v1/acknowledgements";
const SETTINGS = { enabled: true, remindAfterDays: 2 };

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue(SETTINGS);
  api.put.mockResolvedValue(SETTINGS);
  api.post.mockResolvedValue({});
});

describe("reading", () => {
  it("reads each list from its own route", async () => {
    const { wrapper } = setup();
    api.get.mockResolvedValue([]);
    for (const hook of [useAckSettings, useAckPupils, useAckList, useAckMine]) {
      const { result } = renderHook(() => hook(), { wrapper });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
    }
    const detail = renderHook(() => useAckDetail("r-1"), { wrapper });
    await waitFor(() => expect(detail.result.current.isSuccess).toBe(true));
    expect(api.get.mock.calls.map(([path]) => path).sort()).toEqual(
      [`${BASE}/settings`, `${BASE}/pupils`, BASE, `${BASE}/mine`, `${BASE}/r-1`].sort(),
    );
  });

  it("does not retry a refusal: a failed read is shown at once", async () => {
    api.get.mockRejectedValue(new Error("403"));
    const { wrapper } = setup();
    const { result } = renderHook(() => useAckList(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it("does not keep the pupils or an opened request once nothing shows them (the gateway records each reading)", async () => {
    api.get.mockResolvedValue([]);
    const { client, wrapper } = setup();
    const pupils = renderHook(() => useAckPupils(), { wrapper });
    const detail = renderHook(() => useAckDetail("r-1"), { wrapper });
    await waitFor(() => expect(pupils.result.current.isSuccess && detail.result.current.isSuccess).toBe(true));
    pupils.unmount();
    detail.unmount();
    await waitFor(() => expect(client.getQueryData(ACK_KEYS.pupils)).toBeUndefined());
    expect(client.getQueryData(ACK_KEYS.detail("r-1"))).toBeUndefined();

    // Shown again, they are read again.
    const before = api.get.mock.calls.length;
    const again = renderHook(() => useAckPupils(), { wrapper });
    await waitFor(() => expect(again.result.current.isSuccess).toBe(true));
    expect(api.get.mock.calls.length).toBe(before + 1);
  });
});

describe("the school's settings", () => {
  it("PUTs what changed and keeps the answer as the setting", async () => {
    const saved = { enabled: false, remindAfterDays: null };
    api.put.mockResolvedValue(saved);
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useAckActions(), { wrapper });
    await act(() => result.current.updateSettings.mutateAsync({ enabled: false, remindAfterDays: null }));
    expect(api.put).toHaveBeenCalledWith(`${BASE}/settings`, { enabled: false, remindAfterDays: null });
    expect(client.getQueryData(ACK_KEYS.settings)).toEqual(saved);
  });

  it("reads the setting again after a refused save", async () => {
    api.put.mockRejectedValue(new Error("403"));
    const { wrapper } = setup();
    const settings = renderHook(() => useAckSettings(), { wrapper });
    await waitFor(() => expect(settings.result.current.isSuccess).toBe(true));
    const { result } = renderHook(() => useAckActions(), { wrapper });
    const before = api.get.mock.calls.length;
    await act(() => result.current.updateSettings.mutateAsync({ enabled: true }).catch(() => undefined));
    await waitFor(() => expect(api.get.mock.calls.length).toBeGreaterThan(before));
  });
});

describe("a request", () => {
  const body = { title: "Utflykten", body: "På torsdag", rule: "ALL", studentIds: ["p1", "p2"] };

  it("POSTs the title, the text, the rule and the pupils to the route's root", async () => {
    const created = { id: "r-9", pupils: 2, guardians: 3, withoutGuardian: [] };
    api.post.mockResolvedValue(created);
    const { wrapper } = setup();
    const { result } = renderHook(() => useAckActions(), { wrapper });
    await expect(act(() => result.current.create.mutateAsync(body))).resolves.toEqual(created);
    expect(api.post).toHaveBeenCalledWith(BASE, body);
  });

  it("reads the list again when it was made", async () => {
    api.get.mockResolvedValue([]);
    const { wrapper } = setup();
    const list = renderHook(() => useAckList(), { wrapper });
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true));
    const { result } = renderHook(() => useAckActions(), { wrapper });
    const before = api.get.mock.calls.length;
    await act(() => result.current.create.mutateAsync(body));
    await waitFor(() => expect(api.get.mock.calls.slice(before).map(([path]) => path)).toContain(BASE));
  });

  it("reads the setting again when it was refused, because a 409 says the switch moved", async () => {
    api.post.mockRejectedValue(new Error("409"));
    const { wrapper } = setup();
    const settings = renderHook(() => useAckSettings(), { wrapper });
    await waitFor(() => expect(settings.result.current.isSuccess).toBe(true));
    const { result } = renderHook(() => useAckActions(), { wrapper });
    const before = api.get.mock.calls.length;
    await act(() => result.current.create.mutateAsync(body).catch(() => undefined));
    await waitFor(() => expect(api.get.mock.calls.slice(before).map(([path]) => path)).toContain(`${BASE}/settings`));
  });
});

describe("a confirmation", () => {
  const mine = (ackedAt: string | null): AckMine[] => [
    { id: "r-1", title: "Utflykten", body: "På torsdag", rule: "ANY", authorName: "Anna Lind", createdAt: "2026-11-05T08:00:00.000Z", children: [], ackedAt },
    { id: "r-2", title: "Larmet", body: "Det hände", rule: "ALL", authorName: "Anna Lind", createdAt: "2026-11-04T08:00:00.000Z", children: [], ackedAt: null },
  ];

  it("POSTs to the request's own route with no body, and writes the gateway's time into the list at once", async () => {
    api.get.mockResolvedValue(mine(null));
    api.post.mockResolvedValue({ ackedAt: "2026-11-06T09:00:00.000Z" });
    const { client, wrapper } = setup();
    const list = renderHook(() => useAckMine(), { wrapper });
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true));
    const { result } = renderHook(() => useAckActions(), { wrapper });

    await act(() => result.current.confirm.mutateAsync("r-1"));

    expect(api.post).toHaveBeenCalledWith(`${BASE}/r-1/confirm`);
    expect(client.getQueryData<AckMine[]>(ACK_KEYS.mine)!.map((one) => one.ackedAt)).toEqual(["2026-11-06T09:00:00.000Z", null]);
  });

  it("reads the list again when the gateway refuses (custody ended, or the message is gone)", async () => {
    api.get.mockResolvedValue(mine(null));
    api.post.mockRejectedValue(new Error("409"));
    const { wrapper } = setup();
    const list = renderHook(() => useAckMine(), { wrapper });
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true));
    const { result } = renderHook(() => useAckActions(), { wrapper });
    const before = api.get.mock.calls.length;

    await act(() => result.current.confirm.mutateAsync("r-1").catch(() => undefined));

    await waitFor(() => expect(api.get.mock.calls.length).toBeGreaterThan(before));
  });
});
