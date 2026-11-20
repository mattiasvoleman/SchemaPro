import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { ApiError, api } from "@/lib/api";
import { ENGINE_RELEASE_KEY, useEngineReleases, useSetEngineRelease } from "@/lib/engine-release-queries";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } };
});
const get = api.get as unknown as Mock;
const put = api.put as unknown as Mock;

function harness() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidated = vi.spyOn(queryClient, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { invalidated, wrapper };
}

/**
 * The two calls of "Släppta poster": the year's list, and the one write. The write is by post id and nothing else; the
 * list is read again whatever the write came to.
 */
describe("engine release hooks", () => {
  beforeEach(() => vi.resetAllMocks());

  it("reads the year's releases from the gateway, once the year is known", async () => {
    get.mockResolvedValue({ releases: [{ requirementId: "r-1", releasedAt: "2026-11-19T09:00:00.000Z", releasedById: null }] });
    const { wrapper } = harness();
    const idle = renderHook(() => useEngineReleases(null), { wrapper });
    expect(idle.result.current.fetchStatus).toBe("idle");
    expect(get).not.toHaveBeenCalled();

    const { result } = renderHook(() => useEngineReleases("y 1"), { wrapper });
    await waitFor(() => expect(result.current.data?.releases).toHaveLength(1));
    expect(get).toHaveBeenCalledWith("/api/v1/staffing/engine-release?academicYearId=y%201");
  });

  it("puts the year, the post ids and the state, and answers with what changed", async () => {
    put.mockResolvedValue({ changed: 2, unchanged: 1 });
    const { wrapper } = harness();
    const { result } = renderHook(() => useSetEngineRelease(), { wrapper });
    let answer: unknown;
    await act(async () => {
      answer = await result.current.mutateAsync({ academicYearId: "y1", requirementIds: ["r-1", "r-2", "r-3"], released: true });
    });
    expect(put).toHaveBeenCalledWith("/api/v1/staffing/engine-release", {
      academicYearId: "y1",
      requirementIds: ["r-1", "r-2", "r-3"],
      released: true,
    });
    expect(answer).toEqual({ changed: 2, unchanged: 1 });
  });

  it("reads the list again after a write, and after a refused one", async () => {
    const { wrapper, invalidated } = harness();
    const { result } = renderHook(() => useSetEngineRelease(), { wrapper });
    put.mockResolvedValueOnce({ changed: 1, unchanged: 0 });
    await act(async () => {
      await result.current.mutateAsync({ academicYearId: "y1", requirementIds: ["r-1"], released: false });
    });
    expect(invalidated).toHaveBeenLastCalledWith({ queryKey: ENGINE_RELEASE_KEY });

    // A 400 means a post is not the year's after all: what the card shows is stale, so it is read again.
    invalidated.mockClear();
    put.mockRejectedValueOnce(new ApiError(400, "…", "ENGINE_RELEASE_POST_NOT_IN_YEAR", { count: 1 }));
    await act(async () => {
      await expect(
        result.current.mutateAsync({ academicYearId: "y1", requirementIds: ["r-9"], released: true }),
      ).rejects.toMatchObject({ code: "ENGINE_RELEASE_POST_NOT_IN_YEAR" });
    });
    expect(invalidated).toHaveBeenCalledWith({ queryKey: ENGINE_RELEASE_KEY });
  });

  it("keeps the write pending until the list has been read again, so a switch never shows the old state", async () => {
    const { wrapper } = harness();
    get.mockResolvedValueOnce({ releases: [] });
    const { result } = renderHook(() => ({ list: useEngineReleases("y1"), write: useSetEngineRelease() }), { wrapper });
    await waitFor(() => expect(result.current.list.data).toEqual({ releases: [] }));

    let finishRead: () => void = () => {};
    get.mockImplementationOnce(
      () =>
        new Promise((done) => {
          finishRead = () => done({ releases: [{ requirementId: "r-1", releasedAt: "2026-11-19T09:00:00.000Z", releasedById: "u-1" }] });
        }),
    );
    put.mockResolvedValueOnce({ changed: 1, unchanged: 0 });
    let writing: Promise<unknown> = Promise.resolve();
    act(() => {
      writing = result.current.write.mutateAsync({ academicYearId: "y1", requirementIds: ["r-1"], released: true });
    });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    // The PUT is answered and the read is on its way: still pending, still the old list.
    expect(result.current.write.isPending).toBe(true);
    expect(result.current.list.data).toEqual({ releases: [] });

    await act(async () => {
      finishRead();
      await writing;
    });
    await waitFor(() => expect(result.current.write.isPending).toBe(false));
    expect(result.current.list.data?.releases.map((release) => release.requirementId)).toEqual(["r-1"]);
  });
});
