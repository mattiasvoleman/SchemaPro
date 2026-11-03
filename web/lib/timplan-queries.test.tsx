import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The page saves a plan as PATCH (name, weeks, version) and then PUT (the
 * cells). The PATCH's onSuccess invalidates the plan, which starts a GET that
 * reads the plan BEFORE the PUT commits. If that GET answered after the PUT,
 * it wrote the old cells over the ones the PUT had just seeded — and the next
 * save PUT that stale grid wholesale, reverting the server. The GET here is
 * held until after the PUT, as a slow network would hold it.
 */

const pending: Record<string, Array<() => void>> = {};
const held = new Set<string>();
let serverEntries = 1;

const planWith = (entries: number) => ({
  id: "p1",
  schoolId: "s",
  name: "Plan",
  schoolForm: "GRUNDSKOLA",
  nationalTimplanVersionId: "v",
  planningWeeks: 36,
  status: "DRAFT",
  decidedAt: null,
  decidedByUserId: null,
  decisionNote: null,
  copiedFromId: null,
  gradeFrom: null,
  gradeTo: null,
  gradeSpanSetAt: null,
  gradeSpanSetByUserId: null,
  createdAt: "",
  updatedAt: "",
  entries: Array.from({ length: entries }, (_, i) => ({
    id: `e${i}`,
    subjectId: "sub",
    gradeLevel: i + 1,
    minutesPerWeek: 100,
    note: null,
  })),
});
const checkWith = (entries: number) => ({ localTimplanId: "p1", entries, verdicts: [] });

vi.mock("@/lib/api", () => ({
  api: {
    get: vi.fn((path: string) => {
      // The read happens NOW, before a later PUT commits.
      const snapshot = path.endsWith("/check") ? checkWith(serverEntries) : planWith(serverEntries);
      if (held.has(path)) {
        return new Promise((resolve) => (pending[path] ??= []).push(() => resolve(snapshot)));
      }
      return Promise.resolve(snapshot);
    }),
    patch: vi.fn(async () => {
      const { entries: _entries, ...plan } = planWith(serverEntries);
      return plan;
    }),
    put: vi.fn(async (_path: string, body: { entries: unknown[] }) => {
      serverEntries = body.entries.length;
      return { plan: planWith(serverEntries), check: checkWith(serverEntries) };
    }),
    post: vi.fn(),
    delete: vi.fn(),
  },
}));

import { api } from "@/lib/api";
import {
  useLocalTimplan,
  useLocalTimplanActions,
  useLocalTimplanCheck,
  useSchoolUnitsForSpan,
} from "@/lib/timplan-queries";

describe("saving a plan as PATCH then PUT, as the timplan page does", () => {
  beforeEach(() => {
    serverEntries = 1;
    held.clear();
    for (const key of Object.keys(pending)) delete pending[key];
  });

  it("keeps the cells the PUT saved when the PATCH's refetch answers after it", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => ({ plan: useLocalTimplan("p1"), check: useLocalTimplanCheck("p1"), actions: useLocalTimplanActions() }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.plan.data?.entries.length).toBe(1));
    await waitFor(() => expect(result.current.check.data).toBeDefined());

    held.add("/api/v1/local-timplans/p1");
    held.add("/api/v1/local-timplans/p1/check");
    await act(async () => {
      await result.current.actions.update.mutateAsync({ id: "p1", planningWeeks: 36 });
      await result.current.actions.replaceEntries.mutateAsync({
        id: "p1",
        entries: [1, 2, 3].map((gradeLevel) => ({ subjectId: "sub", gradeLevel, minutesPerWeek: 100 })),
      });
    });
    await act(async () => {
      for (const release of Object.values(pending).flat()) release();
    });
    await waitFor(() => expect(result.current.plan.isFetching).toBe(false));
    await waitFor(() => expect(result.current.check.isFetching).toBe(false));

    expect(serverEntries).toBe(3);
    expect(result.current.plan.data?.entries).toHaveLength(3);
    expect((result.current.check.data as unknown as { entries: number }).entries).toBe(3);
  });

  it("reads the plan and its check afresh when the page mounts, however fresh the cache", async () => {
    // A subject deleted or recoded on Ämnen changes both on the server, and
    // nothing there invalidates these keys.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
    client.setQueryData(["localTimplan", "p1"], planWith(2));
    client.setQueryData(["localTimplan", "p1", "check"], checkWith(2));
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const get = vi.mocked(api.get);
    get.mockClear();
    const { result } = renderHook(() => ({ plan: useLocalTimplan("p1"), check: useLocalTimplanCheck("p1") }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.plan.data?.entries).toHaveLength(1));
    expect(get).toHaveBeenCalledWith("/api/v1/local-timplans/p1");
    expect(get).toHaveBeenCalledWith("/api/v1/local-timplans/p1/check");
  });
});

describe("the årskurs span on the wire", () => {
  const client = () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapperOf = (queryClient: QueryClient) =>
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    };
  const posted = (call: number) => vi.mocked(api.post).mock.calls[call]!;

  beforeEach(() => {
    vi.mocked(api.post).mockReset();
    vi.mocked(api.patch).mockClear();
    vi.mocked(api.post).mockResolvedValue(planWith(0));
  });

  it("leaves the span keys out of a copy or a reopen that states none, so the gateway copies the source's", async () => {
    const { result } = renderHook(() => useLocalTimplanActions(), { wrapper: wrapperOf(client()) });
    await act(async () => {
      await result.current.copy.mutateAsync({ id: "p1" });
      await result.current.copy.mutateAsync({ id: "p1", name: "Kopia" });
      await result.current.reopen.mutateAsync({ id: "p1", name: undefined });
    });
    expect(posted(0)).toEqual(["/api/v1/local-timplans/p1/copy", {}]);
    expect(posted(1)).toEqual(["/api/v1/local-timplans/p1/copy", { name: "Kopia" }]);
    expect(posted(2)).toEqual(["/api/v1/local-timplans/p1/reopen", {}]);
  });

  it("sends the span a copy or a reopen states: two numbers, or two nulls for the whole form", async () => {
    const { result } = renderHook(() => useLocalTimplanActions(), { wrapper: wrapperOf(client()) });
    await act(async () => {
      await result.current.reopen.mutateAsync({ id: "p1", gradeFrom: 4, gradeTo: 9 });
      await result.current.copy.mutateAsync({ id: "p1", name: "Hel", gradeFrom: null, gradeTo: null });
    });
    expect(posted(0)).toEqual(["/api/v1/local-timplans/p1/reopen", { gradeFrom: 4, gradeTo: 9 }]);
    expect(posted(1)).toEqual(["/api/v1/local-timplans/p1/copy", { name: "Hel", gradeFrom: null, gradeTo: null }]);
  });

  it("sets a plan's span on a request of its own, null for the whole form", async () => {
    const queryClient = client();
    queryClient.setQueryData(["localTimplan", "p1"], planWith(1));
    const { result } = renderHook(() => useLocalTimplanActions(), { wrapper: wrapperOf(queryClient) });
    await act(async () => {
      await result.current.setSpan.mutateAsync({ id: "p1", span: { gradeFrom: 7, gradeTo: 9 } });
      await result.current.setSpan.mutateAsync({ id: "p1", span: null });
    });
    expect(vi.mocked(api.patch).mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ["/api/v1/local-timplans/p1", { gradeFrom: 7, gradeTo: 9 }],
      ["/api/v1/local-timplans/p1", { gradeFrom: null, gradeTo: null }],
    ]);
  });

  it("reads the plan again when the gateway answers a stale span change with 409 TIMPLAN_IS_DECIDED", async () => {
    const queryClient = client();
    const { result } = renderHook(() => ({ plan: useLocalTimplan("p1"), actions: useLocalTimplanActions() }), {
      wrapper: wrapperOf(queryClient),
    });
    await waitFor(() => expect(result.current.plan.data).toBeDefined());
    vi.mocked(api.patch).mockRejectedValueOnce(Object.assign(new Error("Planen är beslutad."), { status: 409, code: "TIMPLAN_IS_DECIDED" }));
    vi.mocked(api.get).mockClear();
    await act(async () => {
      await expect(result.current.actions.setSpan.mutateAsync({ id: "p1", span: { gradeFrom: 7, gradeTo: 9 } })).rejects.toThrow("beslutad");
    });
    await waitFor(() => expect(vi.mocked(api.get)).toHaveBeenCalledWith("/api/v1/local-timplans/p1"));
  });

  it("asks for the skolenheter only when told the caller may read them: a teacher never sends the request", async () => {
    vi.mocked(api.get).mockClear();
    const { rerender } = renderHook(({ enabled }) => useSchoolUnitsForSpan(enabled), {
      wrapper: wrapperOf(client()),
      initialProps: { enabled: false },
    });
    await act(async () => {});
    expect(vi.mocked(api.get)).not.toHaveBeenCalledWith("/api/v1/school-units");
    rerender({ enabled: true });
    await waitFor(() => expect(vi.mocked(api.get)).toHaveBeenCalledWith("/api/v1/school-units"));
  });
});
