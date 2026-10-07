import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { api } from "@/lib/api";
import {
  useReplaceTeacherQualifications,
  useTeacherEmploymentActions,
} from "@/lib/staffing-queries";

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const mockApi = api as unknown as Record<"put" | "delete", Mock>;

function createHarness() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { invalidateSpy, wrapper };
}

const invalidatedKeys = (harness: ReturnType<typeof createHarness>) =>
  harness.invalidateSpy.mock.calls.map((call) => call[0]?.queryKey);

/*
 * Föreslå lärare caches its ranking for 30 s (the app's staleTime). A post or
 * a behörighet changes every figure in it — the badge, the kvar, wouldExceed —
 * so a write to either must make the cached ranking stale, or the admin who
 * just added Y's Ma-behörighet reopens the list and still reads "Saknar
 * behörighet" for Y.
 */
describe("staffing writes refetch the suggestions they change", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockApi.put.mockResolvedValue({});
    mockApi.delete.mockResolvedValue({});
  });

  it("a post saved or removed", async () => {
    const harness = createHarness();
    const { result } = renderHook(() => useTeacherEmploymentActions(), { wrapper: harness.wrapper });
    await act(() =>
      result.current.save.mutateAsync({
        userId: "t-1",
        academicYearId: "y-1",
        employmentPercent: 100,
      } as never),
    );
    expect(invalidatedKeys(harness)).toEqual([
      ["teacherEmployments"],
      ["staffingLoad"],
      ["staffingSuggestions"],
    ]);
  });

  it("a teacher's behörigheter replaced", async () => {
    const harness = createHarness();
    const { result } = renderHook(() => useReplaceTeacherQualifications(), {
      wrapper: harness.wrapper,
    });
    await act(() => result.current.mutateAsync({ userId: "t-1", items: [] }));
    expect(invalidatedKeys(harness)).toEqual([
      ["teacherQualifications"],
      ["staffingLoad"],
      ["staffingSuggestions"],
    ]);
  });
});
