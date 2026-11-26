import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { api } from "@/lib/api";
import { useDeleteMasterLesson, useUpdateMasterLesson } from "./queries";

/*
 * The chunk of the lesson cache is fetched, and a fetch can fail (a dropped connection, a proxy). A write must not
 * depend on it: the lesson is written, and the year is read again as it was before the cache existed.
 */
vi.mock("./master-lesson-cache", () => {
  throw new Error("Failed to fetch dynamically imported module");
});
vi.mock("@/utils/supabase/client", () => ({ createClient: () => ({ from: vi.fn() }) }));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const mockApi = api as unknown as Record<"patch" | "delete", Mock>;

function harness() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { invalidate, wrapper };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockApi.patch.mockResolvedValue({});
  mockApi.delete.mockResolvedValue({});
});

describe("a lesson cache that did not come", () => {
  it("still writes the lesson, and reads the year again after it", async () => {
    const { invalidate, wrapper } = harness();
    const { result } = renderHook(() => useUpdateMasterLesson(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: "a", dayOfWeek: 2 });
    });
    expect(mockApi.patch).toHaveBeenCalledWith("/api/v1/master-lessons/a", { dayOfWeek: 2 });
    const forYear = invalidate.mock.calls.find((call) => call[0]?.queryKey?.[0] === "masterLessons");
    expect(forYear?.[0]).toEqual({ queryKey: ["masterLessons"] });
  });

  it("still deletes the lesson, and reads the year again after it", async () => {
    const { invalidate, wrapper } = harness();
    const { result } = renderHook(() => useDeleteMasterLesson(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync("a");
    });
    expect(mockApi.delete).toHaveBeenCalledWith("/api/v1/master-lessons/a");
    const forYear = invalidate.mock.calls.find((call) => call[0]?.queryKey?.[0] === "masterLessons");
    expect(forYear?.[0]).toEqual({ queryKey: ["masterLessons"] });
  });
});
