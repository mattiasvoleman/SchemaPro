import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { api } from "@/lib/api";
import { useScopeAssessmentActions } from "@/lib/scope-assessment-queries";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } };
});
const put = api.put as unknown as Mock;
const del = api.delete as unknown as Mock;

/*
 * The card closes its form when the write has gone through and shows the summary of the row it is handed (the load report's). A write that
 * is over before the report has been read again closes the form on the row as it was: "Ingen bedömning" for as long as the report takes,
 * after a save. The write is therefore pending until the report is read again, so that nothing is shown in between.
 */
describe("scope assessment actions: the write is pending until the report is read again", () => {
  beforeEach(() => vi.resetAllMocks());

  it.each([
    ["a save", (r: ReturnType<typeof useScopeAssessmentActions>) => r.save.mutateAsync({ userId: "t-1", academicYearId: "y1", teachingLevelHours: 580, exceptionKind: null, ownInitiativeOn: null, note: null }), () => put.mockResolvedValue({})],
    ["a removal", (r: ReturnType<typeof useScopeAssessmentActions>) => r.remove.mutateAsync({ userId: "t-1", academicYearId: "y1" }), () => del.mockResolvedValue(undefined)],
  ] as const)("after %s", async (_name, run, arm) => {
    arm();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    let release: () => void = () => undefined;
    vi.spyOn(queryClient, "invalidateQueries").mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useScopeAssessmentActions(), { wrapper });
    let done = false;
    act(() => {
      void run(result.current).then(() => {
        done = true;
      });
    });
    await waitFor(() => expect(queryClient.invalidateQueries).toHaveBeenCalled());
    expect(done).toBe(false);
    await act(async () => {
      release();
    });
    await waitFor(() => expect(done).toBe(true));
  });
});
