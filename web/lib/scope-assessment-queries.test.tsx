import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { ApiError, api } from "@/lib/api";
import { STAFFING_KEYS } from "@/lib/staffing-keys";
import { useScopeAssessmentActions } from "@/lib/scope-assessment-queries";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } };
});
const put = api.put as unknown as Mock;
const del = api.delete as unknown as Mock;

function harness() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidated = vi.spyOn(queryClient, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  return { invalidated, wrapper };
}

const body = { teachingLevelHours: 580, exceptionKind: null, ownInitiativeOn: null, note: null };

/**
 * The two writes of the rektor's assessment, and the one read that follows them: the assessment is read back through the load
 * report (STAFFING_KEYS.load), which is where its figures are computed, so a write that does not invalidate it leaves the card
 * and the verdict beside it showing the row as it was. The card's own tests mock this module, so nothing else pins these.
 */
describe("scope assessment actions", () => {
  beforeEach(() => vi.resetAllMocks());

  it("puts the whole row on the teacher and the year, which are in the address and not in the body", async () => {
    put.mockResolvedValue({ userId: "t-1", academicYearId: "y 1" });
    const { wrapper } = harness();
    const { result } = renderHook(() => useScopeAssessmentActions(), { wrapper });
    await act(async () => {
      await result.current.save.mutateAsync({ userId: "t-1", academicYearId: "y 1", ...body });
    });
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith("/api/v1/scope-assessments/t-1?academicYearId=y%201", body);
  });

  it("deletes the teacher's assessment for the year", async () => {
    del.mockResolvedValue(undefined);
    const { wrapper } = harness();
    const { result } = renderHook(() => useScopeAssessmentActions(), { wrapper });
    await act(async () => {
      await result.current.remove.mutateAsync({ userId: "t-1", academicYearId: "y 1" });
    });
    expect(del).toHaveBeenCalledWith("/api/v1/scope-assessments/t-1?academicYearId=y%201");
  });

  it("reads the load report again after a save and after a removal, and not after a refusal", async () => {
    const { wrapper, invalidated } = harness();
    const { result } = renderHook(() => useScopeAssessmentActions(), { wrapper });
    put.mockResolvedValueOnce({});
    await act(async () => {
      await result.current.save.mutateAsync({ userId: "t-1", academicYearId: "y1", ...body });
    });
    expect(invalidated).toHaveBeenCalledWith({ queryKey: STAFFING_KEYS.load });
    invalidated.mockClear();
    del.mockResolvedValueOnce(undefined);
    await act(async () => {
      await result.current.remove.mutateAsync({ userId: "t-1", academicYearId: "y1" });
    });
    expect(invalidated).toHaveBeenCalledWith({ queryKey: STAFFING_KEYS.load });
    invalidated.mockClear();
    put.mockRejectedValueOnce(new ApiError(400, "Nivån kan inte vara över förordningens högsta nivå, 650 timmar vid heltid (SFS 2026:1487 3 §)."));
    await act(async () => {
      await expect(result.current.save.mutateAsync({ userId: "t-1", academicYearId: "y1", ...body })).rejects.toMatchObject({ status: 400 });
    });
    expect(invalidated).not.toHaveBeenCalled();
  });
});
