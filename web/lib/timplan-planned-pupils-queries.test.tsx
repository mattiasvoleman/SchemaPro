import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { usePlannedClassPupils } from "@/lib/timplan-planned-pupils-queries";
import { TIMPLAN_COVERAGE_KEYS } from "@/lib/year-timplan-keys";

vi.mock("@/lib/api", () => ({ api: { get: vi.fn() } }));

/**
 * The pupils of one class on the planned layer, read when "Visa alla elever"
 * opens: which route it asks, that it asks for nothing without a year and a
 * class, and that it asks afresh each time the panel opens — a post saved a
 * moment ago is in the answer, even where the app keeps what it read fresh for
 * a while.
 */

const YEAR = "44444444-4444-4444-8444-444444444444";
const CLASS = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
const answer = { academicYearId: YEAR, layer: "planned", studentGroupId: CLASS, gradeLevel: 8, pupils: [] };

const get = vi.mocked(api.get);
let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

beforeEach(() => {
  get.mockReset();
  get.mockResolvedValue(answer);
  // Fresh for good: only an explicit "always" reads again on a second mount.
  client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
});

describe("usePlannedClassPupils", () => {
  it("asks the per-class route for the year and the class, encoded", async () => {
    const { result } = renderHook(() => usePlannedClassPupils(YEAR, CLASS), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(answer));
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(
      `/api/v1/timplan-coverage/planned/pupils?academicYearId=${YEAR}&studentGroupId=${CLASS}`,
    );
  });

  it("asks nothing without a year or without a class", () => {
    renderHook(() => usePlannedClassPupils(null, CLASS), { wrapper });
    renderHook(() => usePlannedClassPupils(YEAR, null), { wrapper });
    expect(get).not.toHaveBeenCalled();
  });

  it("keeps each class's answer under its own key, below the year's, so what invalidates the year reaches it", () => {
    expect(TIMPLAN_COVERAGE_KEYS.plannedPupils(YEAR, CLASS)).toEqual(["timplanCoverage", YEAR, "plannedPupils", CLASS]);
    expect(TIMPLAN_COVERAGE_KEYS.plannedPupils(YEAR, CLASS).slice(0, 2)).toEqual(TIMPLAN_COVERAGE_KEYS.year(YEAR));
    expect(TIMPLAN_COVERAGE_KEYS.plannedPupils(YEAR, CLASS)).not.toEqual(TIMPLAN_COVERAGE_KEYS.plannedPupils(YEAR, "other"));
  });

  it("reads again each time the panel opens, though the app holds what it read fresh", async () => {
    const first = renderHook(() => usePlannedClassPupils(YEAR, CLASS), { wrapper });
    await waitFor(() => expect(first.result.current.data).toEqual(answer));
    first.unmount();
    expect(get).toHaveBeenCalledTimes(1);

    const second = renderHook(() => usePlannedClassPupils(YEAR, CLASS), { wrapper });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(second.result.current.isFetching).toBe(false));
  });
});
