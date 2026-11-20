import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { api } from "@/lib/api";
import {
  useAssignTeacher,
  useReplaceTeacherQualifications,
  useTeacherDutyActions,
  useTeacherEmploymentActions,
  useTeacherQualifications,
} from "@/lib/staffing-queries";

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const mockApi = api as unknown as Record<"get" | "put" | "delete" | "post" | "patch", Mock>;

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
 * Behörighet som i ett annat ämne: the stored rows are what a form edits and saves whole, and the
 * derived rows are for the screens that judge. They are two asks, never one list, so a derived row
 * cannot reach a form by sharing its cache entry — and both are under the prefix a write refetches.
 */
describe("useTeacherQualifications", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockApi.get.mockResolvedValue([]);
  });

  it("asks for the stored rows by default, the school's or one teacher's", async () => {
    const harness = createHarness();
    renderHook(() => useTeacherQualifications(), { wrapper: harness.wrapper });
    renderHook(() => useTeacherQualifications("t-anna"), { wrapper: harness.wrapper });
    await waitFor(() => expect(mockApi.get).toHaveBeenCalledTimes(2));
    expect(mockApi.get.mock.calls.map((call) => call[0]).sort()).toEqual([
      "/api/v1/teacher-qualifications",
      "/api/v1/teacher-qualifications?userId=t-anna",
    ]);
  });

  it("asks for the derived rows too, under a key of their own, when a screen judges by them", async () => {
    const harness = createHarness();
    renderHook(() => useTeacherQualifications(null, { inherited: true }), { wrapper: harness.wrapper });
    renderHook(() => useTeacherQualifications("t-anna", { inherited: true }), { wrapper: harness.wrapper });
    renderHook(() => useTeacherQualifications(), { wrapper: harness.wrapper });
    await waitFor(() => expect(mockApi.get).toHaveBeenCalledTimes(3));
    expect(mockApi.get.mock.calls.map((call) => call[0]).sort()).toEqual([
      "/api/v1/teacher-qualifications",
      "/api/v1/teacher-qualifications?inherited=true",
      "/api/v1/teacher-qualifications?userId=t-anna&inherited=true",
    ]);
  });
});

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
      // A saved or removed post is a new version in the teacher's Historik.
      ["teacherEmploymentHistory"],
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

describe("every write to a tjänst refetches its Historik (staffing Fas 3)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockApi.post.mockResolvedValue({});
    mockApi.delete.mockResolvedValue({});
  });

  it("an uppdrag created or removed", async () => {
    const harness = createHarness();
    const { result } = renderHook(() => useTeacherDutyActions(), { wrapper: harness.wrapper });
    await act(() => result.current.create.mutateAsync({ userId: "t-1", academicYearId: "y-1" } as never));
    expect(invalidatedKeys(harness)).toContainEqual(["teacherEmploymentHistory"]);
    harness.invalidateSpy.mockClear();
    await act(() => result.current.remove.mutateAsync("d-1"));
    expect(invalidatedKeys(harness)).toContainEqual(["teacherEmploymentHistory"]);
  });
});

/*
 * Släppt för motorn: a teacher chosen by hand takes the post's release back on the gateway, in the same write, so the card that lists the
 * releases must read them again.
 */
describe("a teacher chosen by hand refetches the releases", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockApi.patch.mockResolvedValue({});
  });

  it("assigning a teacher invalidates the releases beside the load report, the unstaffed list and the suggestions", async () => {
    const harness = createHarness();
    const { result } = renderHook(() => useAssignTeacher(), { wrapper: harness.wrapper });
    await act(() => result.current.mutateAsync({ requirementId: "r-1", teacherId: "t-1" }));
    expect(mockApi.patch).toHaveBeenCalledWith("/api/v1/teaching-requirements/r-1", { teacherId: "t-1" });
    expect(invalidatedKeys(harness)).toEqual([
      ["requirements"],
      ["staffingLoad"],
      ["staffingUnstaffed"],
      ["staffingSuggestions"],
      ["engineReleases"],
    ]);
  });
});
