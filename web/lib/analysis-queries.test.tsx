import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import {
  ANALYSIS_KEYS,
  COST_NOT_YOURS,
  HR_NOT_YOURS,
  isNotYours,
  isRateLimited,
  useAnalysisActions,
  useCostBasis,
  useCostRates,
  useKeyFigures,
  usePayrollBasis,
  usePayrollFile,
  useSchoolParts,
} from "@/lib/analysis-queries";
import { previousMonth } from "@/components/analysis/payroll-panel";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, Wrapper };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue({});
  api.post.mockResolvedValue({});
  api.put.mockResolvedValue({});
  api.patch.mockResolvedValue({});
  api.delete.mockResolvedValue(undefined);
});

describe("the refusals the page says calmly", () => {
  it("knows a refusal by its status and its code, and a rate limit by its status alone", () => {
    expect(isNotYours(new ApiError(403, "no", COST_NOT_YOURS), COST_NOT_YOURS)).toBe(true);
    expect(isNotYours(new ApiError(403, "no", HR_NOT_YOURS), COST_NOT_YOURS)).toBe(false);
    expect(isNotYours(new ApiError(500, "no", COST_NOT_YOURS), COST_NOT_YOURS)).toBe(false);
    expect(isNotYours(new Error("no"), COST_NOT_YOURS)).toBe(false);
    expect(isRateLimited(new ApiError(429, "slow"))).toBe(true);
    expect(isRateLimited(new ApiError(403, "slow"))).toBe(false);
    expect(isRateLimited(null)).toBe(false);
  });
});

describe("the reads", () => {
  it("asks the gateway for the year, once for each view", async () => {
    const { Wrapper } = wrapper();
    renderHook(() => useKeyFigures("y1"), { wrapper: Wrapper });
    renderHook(() => useCostBasis("y1"), { wrapper: Wrapper });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    expect(api.get).toHaveBeenCalledWith("/api/v1/analysis/key-figures?academicYearId=y1");
    expect(api.get).toHaveBeenCalledWith("/api/v1/analysis/cost-basis?academicYearId=y1");
  });

  it("asks nothing without a year, and nothing of the payroll without a period", async () => {
    const { Wrapper } = wrapper();
    renderHook(() => useKeyFigures(null), { wrapper: Wrapper });
    renderHook(() => useCostBasis(null), { wrapper: Wrapper });
    renderHook(() => usePayrollBasis(null, { from: "2026-10-01", to: "2026-10-31" }), { wrapper: Wrapper });
    renderHook(() => usePayrollBasis("y1", null), { wrapper: Wrapper });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.get).not.toHaveBeenCalled();
  });

  it("asks the payroll for exactly its period, and the settings for the school's own", async () => {
    const { Wrapper } = wrapper();
    renderHook(() => usePayrollBasis("y1", { from: "2026-10-01", to: "2026-10-31" }), { wrapper: Wrapper });
    renderHook(() => useSchoolParts(), { wrapper: Wrapper });
    renderHook(() => useCostRates(), { wrapper: Wrapper });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(3));
    expect(api.get).toHaveBeenCalledWith("/api/v1/analysis/payroll-basis?academicYearId=y1&from=2026-10-01&to=2026-10-31");
    expect(api.get).toHaveBeenCalledWith("/api/v1/analysis/school-parts");
    expect(api.get).toHaveBeenCalledWith("/api/v1/analysis/cost-rates");
  });
});

describe("the writes", () => {
  it("orders the file at the click, with the year, the period and the format", async () => {
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => usePayrollFile(), { wrapper: Wrapper });
    await result.current.mutateAsync({ academicYearId: "y1", from: "2026-10-01", to: "2026-10-31", format: "XLSX" });
    expect(api.post).toHaveBeenCalledWith("/api/v1/analysis/payroll-basis/export", {
      academicYearId: "y1",
      from: "2026-10-01",
      to: "2026-10-31",
      format: "XLSX",
    });
  });

  it("writes each skoldel and rate by its own route, and drops every answer of the page after it", async () => {
    const { Wrapper, client } = wrapper();
    client.setQueryData(ANALYSIS_KEYS.keyFigures("y1"), { stale: true });
    client.setQueryData(ANALYSIS_KEYS.costBasis("y1"), { stale: true });
    const { result } = renderHook(() => useAnalysisActions(), { wrapper: Wrapper });
    const input = { name: "Lågstadiet", account: "4010", gradeFrom: 0, gradeTo: 3 };
    await result.current.createPart.mutateAsync(input);
    expect(api.post).toHaveBeenCalledWith("/api/v1/analysis/school-parts", input);
    await result.current.updatePart.mutateAsync({ id: "p1", account: "4011" });
    expect(api.patch).toHaveBeenCalledWith("/api/v1/analysis/school-parts/p1", { account: "4011" });
    await result.current.removePart.mutateAsync("p1");
    expect(api.delete).toHaveBeenCalledWith("/api/v1/analysis/school-parts/p1");
    await result.current.putRate.mutateAsync({ category: "SUBSTITUTE", hourlyCost: 310 });
    expect(api.put).toHaveBeenCalledWith("/api/v1/analysis/cost-rates/SUBSTITUTE", { hourlyCost: 310 });
    await result.current.removeRate.mutateAsync("TEACHER");
    expect(api.delete).toHaveBeenCalledWith("/api/v1/analysis/cost-rates/TEACHER");
    await waitFor(() => expect(client.getQueryState(ANALYSIS_KEYS.keyFigures("y1"))?.isInvalidated).toBe(true));
    expect(client.getQueryState(ANALYSIS_KEYS.costBasis("y1"))?.isInvalidated).toBe(true);
  });
});

describe("previousMonth", () => {
  it("is the whole month before today, across a year end and a leap February", () => {
    expect(previousMonth(new Date(2026, 10, 18))).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(previousMonth(new Date(2027, 0, 5))).toEqual({ from: "2026-12-01", to: "2026-12-31" });
    expect(previousMonth(new Date(2028, 2, 1))).toEqual({ from: "2028-02-01", to: "2028-02-29" });
  });
});
