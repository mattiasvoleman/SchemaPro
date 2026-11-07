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
  useAckUsage,
} from "./ack-queries";
import type { AckMine, AckPage } from "./ack";
import { listItem, mineItem, page } from "./__fixtures__/ack";

/**
 * What goes over the wire to /api/v1/acknowledgements: the routes, the verbs
 * and the bodies, and what is read again after a write. The gateway's routes
 * are the contract (src/ack/ack.controller.ts). The two lists are pages: the
 * first has no `after`, and each answer names the id to ask the next after.
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
    api.get.mockResolvedValue(page([]));
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

  it("reads the day's use from its own route, and keeps it for a minute", async () => {
    const usage = { school: { used: 6, limit: 20000 }, mine: { used: 3, limit: 8000 }, senders: [{ name: "Anna Lind", used: 3, limit: 2000 }] };
    api.get.mockResolvedValue(usage);
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useAckUsage(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.get).toHaveBeenCalledWith(`${BASE}/usage`);
    expect(result.current.data).toEqual(usage);
    expect(client.getQueryCache().find({ queryKey: ACK_KEYS.usage })?.observers[0]?.options.staleTime).toBe(60_000);
    // Shown again within the minute, it is not read again.
    renderHook(() => useAckUsage(), { wrapper });
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it("does not retry a refusal: a failed read is shown at once", async () => {
    api.get.mockRejectedValue(new Error("403"));
    const { wrapper } = setup();
    const { result } = renderHook(() => useAckList(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it("does not keep the pupils or an opened request once nothing shows them (the gateway records each reading)", async () => {
    api.get.mockResolvedValue(page([]));
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

describe("the pages of a list", () => {
  const first = page([listItem({ id: "r-3" }), listItem({ id: "r-2" })], "r-2");
  const second = page([listItem({ id: "r-1" })]);

  it.each([
    ["the staff's list", useAckList, BASE],
    ["the guardian's own", useAckMine, `${BASE}/mine`],
  ])("asks %s for the next page after the id the last answer named, and appends it", async (_who, hook, path) => {
    api.get.mockImplementation(async (url: string) => (url === path ? first : second));
    const { wrapper } = setup();
    // Both lists are one shape of query, whatever their items.
    const { result } = renderHook(() => hook() as ReturnType<typeof useAckList>, { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // The first page has no cursor and no limit: the page size is the gateway's.
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenLastCalledWith(path);
    expect(result.current.hasNextPage).toBe(true);

    await act(() => result.current.fetchNextPage());

    expect(api.get).toHaveBeenLastCalledWith(`${path}?after=r-2`);
    await waitFor(() => expect(result.current.data!.pages).toHaveLength(2));
    expect(result.current.data!.pages.flatMap((one) => one.items.map((item) => item.id))).toEqual(["r-3", "r-2", "r-1"]);
    expect(result.current.hasNextPage).toBe(false);
  });

  it("has no next page when the answer names none", async () => {
    api.get.mockResolvedValue(page([listItem()], null));
    const { wrapper } = setup();
    const { result } = renderHook(() => useAckList(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.hasNextPage).toBe(false);
  });

  it("keeps the pages it has when the next one cannot be read, and reads it again when asked", async () => {
    api.get.mockImplementation(async (url: string) => {
      if (url === BASE) return first;
      throw new Error("500");
    });
    const { wrapper } = setup();
    const { result } = renderHook(() => useAckList(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    await act(() => result.current.fetchNextPage());

    await waitFor(() => expect(result.current.isFetchNextPageError).toBe(true));
    expect(result.current.data!.pages).toEqual([first]);
    expect(result.current.hasNextPage).toBe(true);

    api.get.mockImplementation(async (url: string) => (url === BASE ? first : second));
    await act(() => result.current.fetchNextPage());
    await waitFor(() => expect(result.current.data!.pages).toHaveLength(2));
    expect(result.current.isFetchNextPageError).toBe(false);
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
    api.get.mockResolvedValue(page([]));
    const { wrapper } = setup();
    const list = renderHook(() => useAckList(), { wrapper });
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true));
    const { result } = renderHook(() => useAckActions(), { wrapper });
    const before = api.get.mock.calls.length;
    await act(() => result.current.create.mutateAsync(body));
    await waitFor(() => expect(api.get.mock.calls.slice(before).map(([path]) => path)).toContain(BASE));
  });

  it("reads the day's use again when it was made, and when it was refused (a 429 says a colleague has sent)", async () => {
    api.get.mockResolvedValue({ school: null, mine: { used: 0, limit: 2000 }, senders: null });
    const { wrapper } = setup();
    const usage = renderHook(() => useAckUsage(), { wrapper });
    await waitFor(() => expect(usage.result.current.isSuccess).toBe(true));
    const { result } = renderHook(() => useAckActions(), { wrapper });
    let before = api.get.mock.calls.length;
    await act(() => result.current.create.mutateAsync(body));
    await waitFor(() => expect(api.get.mock.calls.slice(before).map(([path]) => path)).toContain(`${BASE}/usage`));

    api.post.mockRejectedValue(new Error("429"));
    before = api.get.mock.calls.length;
    await act(() => result.current.create.mutateAsync(body).catch(() => undefined));
    await waitFor(() => expect(api.get.mock.calls.slice(before).map(([path]) => path)).toContain(`${BASE}/usage`));
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
  const ackedAts = (client: QueryClient) =>
    client.getQueryData<{ pages: Array<AckPage<AckMine>> }>(ACK_KEYS.mine)!.pages.map((one) => one.items.map((item) => item.ackedAt));

  it("POSTs to the request's own route with no body, and writes the gateway's time into the list at once", async () => {
    api.get.mockResolvedValue(page(mine(null)));
    api.post.mockResolvedValue({ ackedAt: "2026-11-06T09:00:00.000Z" });
    const { client, wrapper } = setup();
    const list = renderHook(() => useAckMine(), { wrapper });
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true));
    const { result } = renderHook(() => useAckActions(), { wrapper });

    await act(() => result.current.confirm.mutateAsync("r-1"));

    expect(api.post).toHaveBeenCalledWith(`${BASE}/r-1/confirm`);
    expect(ackedAts(client)).toEqual([["2026-11-06T09:00:00.000Z", null]]);
  });

  it("writes it into the page the request is on, also when that is a later one, and into no other", async () => {
    const first = page([mineItem({ id: "r-3" }), mineItem({ id: "r-2" })], "r-2");
    api.get.mockImplementation(async (url: string) => (url === `${BASE}/mine` ? first : page([mineItem({ id: "r-1" })])));
    api.post.mockResolvedValue({ ackedAt: "2026-11-06T09:00:00.000Z" });
    const { client, wrapper } = setup();
    const list = renderHook(() => useAckMine(), { wrapper });
    // `data` is read first: a hook re-renders only for what the test has looked at.
    await waitFor(() => expect(list.result.current.data?.pages).toHaveLength(1));
    await act(() => list.result.current.fetchNextPage());
    await waitFor(() => expect(list.result.current.data!.pages).toHaveLength(2));
    const { result } = renderHook(() => useAckActions(), { wrapper });
    const before = api.get.mock.calls.length;

    await act(() => result.current.confirm.mutateAsync("r-1"));

    expect(ackedAts(client)).toEqual([
      [null, null],
      ["2026-11-06T09:00:00.000Z"],
    ]);
    // Written, not read again; the cursor of the page before it is as it was.
    expect(api.get.mock.calls).toHaveLength(before);
    expect(client.getQueryData<{ pages: Array<AckPage<AckMine>> }>(ACK_KEYS.mine)!.pages[0]!.next).toBe("r-2");
  });

  it("reads the list again when the gateway refuses (custody ended, or the message is gone)", async () => {
    api.get.mockResolvedValue(page(mine(null)));
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

describe("stopping a reminder", () => {
  const detailBody = { id: "r-1" };

  it("POSTs to the request's own route with no body and hands back where the reminder ended", async () => {
    api.post.mockResolvedValue({ reminder: "STOPPED" });
    const { wrapper } = setup();
    const { result } = renderHook(() => useAckActions(), { wrapper });

    await expect(act(() => result.current.stopReminder.mutateAsync("r-1"))).resolves.toEqual({ reminder: "STOPPED" });

    expect(api.post).toHaveBeenCalledWith(`${BASE}/r-1/stop-reminder`);
  });

  it("reads the list and the request again afterwards, not guessing what the reminder became", async () => {
    api.get.mockImplementation(async (url: string) => (url === BASE ? page([listItem()]) : detailBody));
    api.post.mockResolvedValue({ reminder: "SENT" });
    const { wrapper } = setup();
    const list = renderHook(() => useAckList(), { wrapper });
    const one = renderHook(() => useAckDetail("r-1"), { wrapper });
    await waitFor(() => expect(list.result.current.isSuccess && one.result.current.isSuccess).toBe(true));
    const { result } = renderHook(() => useAckActions(), { wrapper });
    const before = api.get.mock.calls.length;

    await act(() => result.current.stopReminder.mutateAsync("r-1"));

    await waitFor(() => expect(api.get.mock.calls.slice(before).map(([path]) => path).sort()).toEqual([BASE, `${BASE}/r-1`].sort()));
  });

  it("reads them again when the gateway refuses too (403 or 404 say the page is out of date)", async () => {
    api.get.mockImplementation(async (url: string) => (url === BASE ? page([listItem()]) : detailBody));
    api.post.mockRejectedValue(new Error("404"));
    const { wrapper } = setup();
    const list = renderHook(() => useAckList(), { wrapper });
    const one = renderHook(() => useAckDetail("r-1"), { wrapper });
    await waitFor(() => expect(list.result.current.isSuccess && one.result.current.isSuccess).toBe(true));
    const { result } = renderHook(() => useAckActions(), { wrapper });
    const before = api.get.mock.calls.length;

    await act(() => result.current.stopReminder.mutateAsync("r-1").catch(() => undefined));

    await waitFor(() => expect(api.get.mock.calls.slice(before).map(([path]) => path)).toContain(`${BASE}/r-1`));
    expect(api.get.mock.calls.slice(before).map(([path]) => path)).toContain(BASE);
  });

  it("leaves other requests' pages alone", async () => {
    api.get.mockImplementation(async (url: string) => (url === `${BASE}/mine` ? page([mineItem()]) : detailBody));
    api.post.mockResolvedValue({ reminder: "STOPPED" });
    const { wrapper } = setup();
    const mine = renderHook(() => useAckMine(), { wrapper });
    await waitFor(() => expect(mine.result.current.isSuccess).toBe(true));
    const { result } = renderHook(() => useAckActions(), { wrapper });
    const before = api.get.mock.calls.length;

    await act(() => result.current.stopReminder.mutateAsync("r-1"));

    expect(api.get.mock.calls).toHaveLength(before);
  });
});
