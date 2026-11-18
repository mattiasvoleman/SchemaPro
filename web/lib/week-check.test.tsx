import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import {
  askWeekCheck,
  classifyWeekCheckError,
  ENGINE_LACKS_WEEK_CHECK,
  useWeekCheck,
  WEEK_CHECK_WAIT_MS,
  warnsBeforeRun,
  type WeekCheckOutcome,
  type WeekCheckResult,
} from "@/lib/week-check";

const apiPost = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: { post: apiPost },
}));

const result = (verdict: WeekCheckResult["verdict"]): WeekCheckOutcome => ({
  kind: "result",
  result: { verdict, years: [], conflicts: null, skipped: ["LUNCH_STAGE"], elapsedMs: 10, checkedBy: "ENGINE" },
});

describe("warnsBeforeRun", () => {
  it.each([
    ["nothing found", result("OK"), false],
    ["a tight week", result("TIGHT"), true],
    ["an impossible week", result("IMPOSSIBLE"), true],
    ["a payload refusal", { kind: "refused", code: "X", message: "m", params: null } as WeekCheckOutcome, true],
    ["an engine that cannot check", { kind: "unavailable", reason: "ENGINE_OLDER", message: "m" } as WeekCheckOutcome, false],
    ["a check that failed", { kind: "unavailable", reason: "ERROR", message: "m" } as WeekCheckOutcome, false],
    ["no check at all", null, false],
  ])("%s: %s", (_name, outcome, warns) => {
    expect(warnsBeforeRun(outcome)).toBe(warns);
  });
});

describe("classifyWeekCheckError", () => {
  it("reads the 400 with an engine code as the refusal Generera gives, keeping its values", () => {
    expect(classifyWeekCheckError(new ApiError(400, "English.", "LUNCH_X", { seats: 20 }))).toEqual({
      kind: "refused",
      code: "LUNCH_X",
      message: "English.",
      params: { seats: 20 },
    });
  });

  it("does not read a 400 without a code as a refusal of the week: that is a malformed request", () => {
    expect(classifyWeekCheckError(new ApiError(400, "academicYearId must be a UUID"))).toEqual({
      kind: "unavailable",
      reason: "ERROR",
      message: "academicYearId must be a UUID",
    });
  });

  it("reads the gateway's code for an older engine, and a 404 for an older API, as the function that is coming", () => {
    expect(classifyWeekCheckError(new ApiError(503, "m", ENGINE_LACKS_WEEK_CHECK)).kind).toBe("unavailable");
    expect(classifyWeekCheckError(new ApiError(503, "m", ENGINE_LACKS_WEEK_CHECK))).toMatchObject({ reason: "ENGINE_OLDER" });
    expect(classifyWeekCheckError(new ApiError(404, "Cannot POST /api/v1/optimization/week-check"))).toMatchObject({
      reason: "ENGINE_OLDER",
    });
  });

  it("does not read the gateway's other 404, a year that is not there, as a function that is coming", () => {
    expect(classifyWeekCheckError(new ApiError(404, "Academic year not found."))).toEqual({
      kind: "unavailable",
      reason: "ERROR",
      message: "Academic year not found.",
    });
  });

  it.each([
    ["a throttled check", new ApiError(429, "Too many requests.")],
    ["an engine that is down", new ApiError(503, "The AI engine could not be reached.")],
    ["a failing gateway", new ApiError(500, "Internal")],
    ["a network failure", new TypeError("Failed to fetch")],
  ])("reads %s as an ordinary failure", (_name, error) => {
    expect(classifyWeekCheckError(error)).toMatchObject({ kind: "unavailable", reason: "ERROR" });
  });

  it("says nothing of a thrown value that is not an Error", () => {
    expect(classifyWeekCheckError("boom")).toEqual({ kind: "unavailable", reason: "ERROR", message: "" });
  });
});

describe("askWeekCheck", () => {
  beforeEach(() => {
    apiPost.mockReset();
  });

  it("is the request the hook makes, as an outcome, for a page that loads it when somebody asks", async () => {
    const answer = { verdict: "OK", years: [], conflicts: null, skipped: ["LUNCH_STAGE"], elapsedMs: 4, checkedBy: "ENGINE" };
    apiPost.mockResolvedValueOnce(answer);

    await expect(askWeekCheck("y-1")).resolves.toEqual({ kind: "result", result: answer });
    expect(apiPost).toHaveBeenCalledWith("/api/v1/optimization/week-check", { academicYearId: "y-1" }, expect.any(AbortSignal));
  });

  it("never rejects: a refusal and a failure are outcomes", async () => {
    apiPost.mockRejectedValueOnce(new ApiError(400, "English.", "LUNCH_X", { seats: 20 }));
    await expect(askWeekCheck("y-1")).resolves.toMatchObject({ kind: "refused", code: "LUNCH_X" });

    apiPost.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(askWeekCheck("y-1")).resolves.toMatchObject({ kind: "unavailable", reason: "ERROR" });
  });
});

describe("useWeekCheck", () => {
  // One client for the whole test: a wrapper that builds its own on every render drops the mutation it is watching.
  const client = new QueryClient({ defaultOptions: { mutations: { retry: 2 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );

  // A block, not an arrow returning the mock: vitest calls whatever a beforeEach returns when the test is over.
  beforeEach(() => {
    apiPost.mockReset();
  });

  it("posts the year to the gateway's route and hands back the answer as a result", async () => {
    const answer = { verdict: "TIGHT", years: [], conflicts: null, skipped: [], elapsedMs: 5, checkedBy: "ENGINE" };
    apiPost.mockResolvedValueOnce(answer);
    const { result: hook } = renderHook(() => useWeekCheck(), { wrapper });
    expect(hook.current.outcome).toBeNull();

    let outcome: WeekCheckOutcome | undefined;
    await act(async () => {
      outcome = await hook.current.check("y-1");
    });

    expect(apiPost).toHaveBeenCalledWith("/api/v1/optimization/week-check", { academicYearId: "y-1" }, expect.any(AbortSignal));
    expect(outcome).toEqual({ kind: "result", result: answer });
    await waitFor(() => expect(hook.current.outcome).toEqual({ kind: "result", result: answer }));
  });

  it("never rejects, and never asks twice: a failure is an outcome", async () => {
    apiPost.mockRejectedValue(new ApiError(503, "m", ENGINE_LACKS_WEEK_CHECK));
    const { result: hook } = renderHook(() => useWeekCheck(), { wrapper });

    let outcome: WeekCheckOutcome | undefined;
    await act(async () => {
      outcome = await hook.current.check("y-1");
    });

    expect(outcome).toMatchObject({ kind: "unavailable", reason: "ENGINE_OLDER" });
    // The client above retries mutations twice; this one is asked for once.
    expect(apiPost).toHaveBeenCalledTimes(1);
  });

  it("gives the request a wait of its own, shorter than the gateway's, so that no check can hold a run for long", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    apiPost.mockResolvedValueOnce({ verdict: "OK", years: [], conflicts: null, skipped: [], elapsedMs: 1, checkedBy: "ENGINE" });
    const { result: hook } = renderHook(() => useWeekCheck(), { wrapper });

    await act(async () => {
      await hook.current.check("y-1");
    });

    expect(timeout).toHaveBeenCalledWith(WEEK_CHECK_WAIT_MS);
    expect(WEEK_CHECK_WAIT_MS).toBeLessThan(30_000);
    timeout.mockRestore();
  });

  it("reads a wait that ran out as a check that could not answer, not as an exception", async () => {
    apiPost.mockRejectedValueOnce(new DOMException("The operation timed out.", "TimeoutError"));
    const { result: hook } = renderHook(() => useWeekCheck(), { wrapper });

    let outcome: WeekCheckOutcome | undefined;
    await act(async () => {
      outcome = await hook.current.check("y-1");
    });

    expect(outcome).toMatchObject({ kind: "unavailable", reason: "ERROR" });
    expect(warnsBeforeRun(outcome)).toBe(false);
  });

  it("drops the answer on reset, as a year change does", async () => {
    apiPost.mockResolvedValueOnce({ verdict: "OK", years: [], conflicts: null, skipped: [], elapsedMs: 1, checkedBy: "ENGINE" });
    const { result: hook } = renderHook(() => useWeekCheck(), { wrapper });
    await act(async () => {
      await hook.current.check("y-1");
    });
    await waitFor(() => expect(hook.current.outcome).not.toBeNull());

    act(() => hook.current.reset());

    await waitFor(() => expect(hook.current.outcome).toBeNull());
  });
});
