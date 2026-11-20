import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import {
  askStaffingWeek,
  changesKey,
  classifyStaffingWeekError,
  STAFFING_WEEK_WAIT_MS,
  useStaffingWeek,
  type StaffingWeekRequest,
  type StaffingWeekView,
} from "@/lib/staffing-week";

const apiPost = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: { post: apiPost },
}));

const BASIS = "a".repeat(64);
const view: StaffingWeekView = {
  status: "NOT_CHECKED",
  reason: "NO_CHANGES",
  years: [],
  verdicts: null,
  worse: false,
  basisSha256: null,
  overlay: { given: 0, laidOver: 0, notLaidOver: 0, fromNobody: 0, newToTheWeek: 0 },
  calls: 0,
  elapsedMs: 1,
};
const request = (ids: string[] = ["r1", "r2"]): StaffingWeekRequest => ({
  academicYearId: "year-1",
  basisSha256: BASIS,
  changes: ids.map((id) => ({ requirementId: id, fromTeacherId: null, toTeacherId: `t-${id}` })),
});

beforeEach(() => {
  apiPost.mockReset();
});

describe("askStaffingWeek", () => {
  it("asks its own route with the request as it is, waiting a little longer than the gateway's budget and under a minute", async () => {
    apiPost.mockResolvedValue(view);

    await expect(askStaffingWeek(request())).resolves.toEqual({ kind: "result", view });

    const [path, body, signal] = apiPost.mock.calls[0]!;
    expect(path).toBe("/api/v1/optimization/staffing/proposal/week");
    expect(body).toEqual(request());
    expect(signal).toBeInstanceOf(AbortSignal);
    // The gateway's budget is 30 s (STAFFING_WEEK_BUDGET_MS): a wait under it would cut a good answer.
    expect(STAFFING_WEEK_WAIT_MS).toBeGreaterThan(30_000);
    expect(STAFFING_WEEK_WAIT_MS).toBeLessThan(60_000);
  });

  it("never throws: whatever failed is an outcome, so the proposal and its apply are not taken with it", async () => {
    apiPost.mockRejectedValue(new Error("network"));
    await expect(askStaffingWeek(request())).resolves.toEqual({ kind: "unavailable", reason: "ERROR" });
  });
});

describe("classifyStaffingWeekError", () => {
  it("reads an older API's own 404 as the function that is coming, and does not read the year's 404 so", () => {
    expect(classifyStaffingWeekError(new ApiError(404, "Cannot POST /api/v1/optimization/staffing/proposal/week"))).toEqual({
      kind: "unavailable",
      reason: "ENGINE_OLDER",
    });
    expect(classifyStaffingWeekError(new ApiError(404, "Academic year not found."))).toEqual({ kind: "unavailable", reason: "ERROR" });
  });

  it("reads a throttled ask and a proposal gone old as what they are, and everything else as an error", () => {
    expect(classifyStaffingWeekError(new ApiError(429, "Too many requests"))).toEqual({ kind: "unavailable", reason: "THROTTLED" });
    expect(classifyStaffingWeekError(new ApiError(409, "old", "STAFF_PROPOSAL_STALE"))).toEqual({ kind: "unavailable", reason: "STALE" });
    expect(classifyStaffingWeekError(new ApiError(409, "other", "SOMETHING_ELSE"))).toEqual({ kind: "unavailable", reason: "ERROR" });
    expect(classifyStaffingWeekError(new ApiError(502, "m"))).toEqual({ kind: "unavailable", reason: "ERROR" });
    expect(classifyStaffingWeekError("boom")).toEqual({ kind: "unavailable", reason: "ERROR" });
  });
});

describe("changesKey", () => {
  it("is the same question in any order, and another for another post or another lead", () => {
    expect(changesKey(request(["b", "a"]).changes)).toBe(changesKey(request(["a", "b"]).changes));
    expect(changesKey(request(["a"]).changes)).not.toBe(changesKey(request(["a", "b"]).changes));
    const other = request(["a"]);
    other.changes[0]!.toTeacherId = "t-other";
    expect(changesKey(other.changes)).not.toBe(changesKey(request(["a"]).changes));
    expect(changesKey([])).toBe("");
  });
});

describe("useStaffingWeek", () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
  );

  it("asks nothing without a request, and is not pending then", () => {
    const { result } = renderHook(() => useStaffingWeek(null, 1), { wrapper });

    expect(apiPost).not.toHaveBeenCalled();
    expect(result.current).toEqual({ outcome: null, isPending: false });
  });

  it("asks once for a request, is pending until it answers, and gives the outcome", async () => {
    apiPost.mockResolvedValue(view);
    const { result } = renderHook(() => useStaffingWeek(request(), 1), { wrapper });

    expect(result.current.isPending).toBe(true);
    await waitFor(() => expect(result.current.outcome).toEqual({ kind: "result", view }));
    expect(result.current.isPending).toBe(false);
    expect(apiPost).toHaveBeenCalledTimes(1);
  });

  it("is never an error: a failed ask is an outcome", async () => {
    apiPost.mockRejectedValue(new ApiError(429, "Too many requests"));
    const { result } = renderHook(() => useStaffingWeek(request(), 1), { wrapper });

    await waitFor(() => expect(result.current.outcome).toEqual({ kind: "unavailable", reason: "THROTTLED" }));
  });
});
