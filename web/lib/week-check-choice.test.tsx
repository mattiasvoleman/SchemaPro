import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { ENGINE_LACKS_WEEK_CHECK } from "@/lib/week-check";
import {
  askWeekCheckChoice,
  classifyChoiceError,
  useWeekCheckChoice,
  WEEK_CHECK_CHOICE_WAIT_MS,
  type WeekCheckChoiceView,
} from "@/lib/week-check-choice";

const apiPost = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: { post: apiPost },
}));

const view: WeekCheckChoiceView = {
  status: "NO_TIGHT_YEAR",
  years: [],
  qualificationsRecorded: true,
  releasedPosts: 0,
  notRun: 0,
  calls: 1,
  elapsedMs: 10,
};

beforeEach(() => {
  apiPost.mockReset();
});

describe("askWeekCheckChoice", () => {
  it("asks its own route about the year, waiting a little longer than the gateway's budget and under a minute", async () => {
    apiPost.mockResolvedValue(view);

    await expect(askWeekCheckChoice("year-1")).resolves.toEqual({ kind: "result", view });

    const [path, body, signal] = apiPost.mock.calls[0]!;
    expect(path).toBe("/api/v1/optimization/week-check/choice");
    expect(body).toEqual({ academicYearId: "year-1" });
    expect(signal).toBeInstanceOf(AbortSignal);
    // The gateway's budget is 24 s (WEEK_CHECK_CHOICE_BUDGET_MS); a wait under it would cut a good answer.
    expect(WEEK_CHECK_CHOICE_WAIT_MS).toBeGreaterThan(24_000);
    expect(WEEK_CHECK_CHOICE_WAIT_MS).toBeLessThan(60_000);
  });

  it("never throws: whatever failed is an outcome, so the check's own answer above it is not taken with it", async () => {
    apiPost.mockRejectedValue(new Error("network"));
    await expect(askWeekCheckChoice("year-1")).resolves.toEqual({ kind: "unavailable", reason: "ERROR" });
  });
});

describe("classifyChoiceError", () => {
  it("reads the gateway's code for an older engine as lib/week-check.ts does: the two files write it once each", () => {
    expect(classifyChoiceError(new ApiError(503, "m", "ENGINE_LACKS_WEEK_CHECK"))).toEqual({ kind: "unavailable", reason: "ENGINE_OLDER" });
    expect(ENGINE_LACKS_WEEK_CHECK).toBe("ENGINE_LACKS_WEEK_CHECK");
  });

  it("reads an older engine's code, and an older API's own 404, as the function that is coming", () => {
    expect(classifyChoiceError(new ApiError(503, "m", ENGINE_LACKS_WEEK_CHECK))).toEqual({ kind: "unavailable", reason: "ENGINE_OLDER" });
    expect(classifyChoiceError(new ApiError(404, "Cannot POST /api/v1/optimization/week-check/choice"))).toEqual({
      kind: "unavailable",
      reason: "ENGINE_OLDER",
    });
  });

  it("does not read the gateway's other 404, a year that is not there, as a function that is coming", () => {
    expect(classifyChoiceError(new ApiError(404, "Academic year not found."))).toEqual({ kind: "unavailable", reason: "ERROR" });
  });

  it("says a throttled ask as that: it is up to twelve checks and the route allows three a minute", () => {
    expect(classifyChoiceError(new ApiError(429, "Too many requests"))).toEqual({ kind: "unavailable", reason: "THROTTLED" });
  });

  it("reads everything else as an error", () => {
    expect(classifyChoiceError(new ApiError(502, "m"))).toEqual({ kind: "unavailable", reason: "ERROR" });
    expect(classifyChoiceError("boom")).toEqual({ kind: "unavailable", reason: "ERROR" });
  });
});

describe("useWeekCheckChoice", () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: true } } })}>{children}</QueryClientProvider>
  );

  it("asks once when asked, holds the outcome, and forgets it on reset; never retried", async () => {
    apiPost.mockRejectedValue(new Error("down"));
    const { result } = renderHook(() => useWeekCheckChoice(), { wrapper });
    expect(result.current.outcome).toBeNull();

    act(() => result.current.ask("year-1"));
    await waitFor(() => expect(result.current.outcome).toEqual({ kind: "unavailable", reason: "ERROR" }));
    expect(apiPost).toHaveBeenCalledTimes(1);

    act(() => result.current.reset());
    await waitFor(() => expect(result.current.outcome).toBeNull());
  });
});
