import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import {
  STAFFING_SEARCH_POLL_MS,
  classifyProposalError,
  classifyStartError,
  endedKey,
  failedKey,
  isActiveSearch,
  latestSearchKey,
  leftOutLines,
  splitDuration,
  tightestPercent,
  useCancelStaffingSearch,
  useLatestStaffingSearch,
  useStaffingSearchProposal,
  useStartStaffingSearch,
  yearLines,
  type StaffingSearchFiguresDoc,
  type StaffingSearchLeftOut,
  type StaffingSearchStatus,
  type StaffingSearchView,
  type StaffingSearchWeekFigure,
} from "@/lib/staffing-search";

/**
 * Lärarval F3 (lib/staffing-search.ts), the hooks over the real react-query with the gateway mocked at lib/api: what is
 * sent, what is polled and, above all, when polling stops: when the run has ended, when a read has failed through its
 * retries, and when nobody is looking any more. And the figures the panel prints, as numbers.
 */

const gateway = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: gateway,
}));

const YEAR = "year-1";
const BASE = "/api/v1/optimization/staffing/search";

const view = (status: StaffingSearchStatus, overrides: Partial<StaffingSearchView> = {}): StaffingSearchView => ({
  id: "run-1",
  academicYearId: YEAR,
  status,
  stopReason: null,
  budgetMs: 600_000,
  elapsedMs: 30_000,
  round: 2,
  evaluations: 17,
  acceptedMoves: 0,
  figures: null,
  tally: null,
  errorCode: null,
  errorParams: null,
  error: null,
  hasProposal: false,
  createdAt: "2026-11-20T10:00:00.000Z",
  startedAt: "2026-11-20T10:00:01.000Z",
  finishedAt: null,
  ...overrides,
});

function harness() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidated = vi.spyOn(queryClient, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  return { queryClient, invalidated, wrapper };
}

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => {
  gateway.get.mockReset();
  gateway.post.mockReset();
});

describe("start", () => {
  it("posts the year (and the posts to keep, when there are any) to the search route, and reads the year's newest run again", async () => {
    gateway.post.mockResolvedValue({ runId: "run-1" });
    const { wrapper, invalidated } = harness();
    const { result } = renderHook(() => useStartStaffingSearch(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ academicYearId: YEAR });
    });
    expect(gateway.post).toHaveBeenCalledWith(BASE, { academicYearId: YEAR });

    await act(async () => {
      await result.current.mutateAsync({ academicYearId: YEAR, pinnedRequirementIds: ["r-1"] });
    });
    expect(gateway.post).toHaveBeenLastCalledWith(BASE, { academicYearId: YEAR, pinnedRequirementIds: ["r-1"] });
    expect(invalidated).toHaveBeenCalledWith({ queryKey: latestSearchKey(YEAR) });
  });

  it("reads the newest run again after a refusal too: that is how a search that is already going is found", async () => {
    gateway.post.mockRejectedValue(new ApiError(409, "En sökning pågår redan", "STAFFING_SEARCH_ALREADY_RUNNING"));
    const { wrapper, invalidated } = harness();
    const { result } = renderHook(() => useStartStaffingSearch(), { wrapper });

    await act(async () => {
      await expect(result.current.mutateAsync({ academicYearId: YEAR })).rejects.toBeInstanceOf(ApiError);
    });
    expect(invalidated).toHaveBeenCalledWith({ queryKey: latestSearchKey(YEAR) });
  });

  it("is never retried: a refusal is an answer, and the route is throttled", async () => {
    gateway.post.mockRejectedValue(new ApiError(429, "Too Many Requests"));
    const { queryClient, wrapper } = harness();
    queryClient.setDefaultOptions({ mutations: { retry: 3 } });
    const { result } = renderHook(() => useStartStaffingSearch(), { wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync({ academicYearId: YEAR })).rejects.toBeInstanceOf(ApiError);
    });
    expect(gateway.post).toHaveBeenCalledTimes(1);
  });
});

describe("the newest search of the year", () => {
  it("reads it from the latest route, by year", async () => {
    gateway.get.mockResolvedValue(view("SUCCEEDED"));
    const { wrapper } = harness();
    const { result } = renderHook(() => useLatestStaffingSearch(YEAR), { wrapper });
    await waitFor(() => expect(result.current.data).toBeTruthy());
    expect(gateway.get).toHaveBeenCalledWith(`${BASE}/latest?academicYearId=${YEAR}`);
  });

  it("asks nothing without a year", () => {
    const { wrapper } = harness();
    renderHook(() => useLatestStaffingSearch(null), { wrapper });
    expect(gateway.get).not.toHaveBeenCalled();
  });

  it("reads 'no search yet' (a 200 with no body, which the client reads as undefined) as null, and never polls it", async () => {
    vi.useFakeTimers();
    notifyManager.setScheduler((callback) => callback());
    try {
      gateway.get.mockResolvedValue(undefined);
      const { wrapper } = harness();
      const { result } = renderHook(() => useLatestStaffingSearch(YEAR), { wrapper });
      await advance(0);
      expect(result.current.data).toBeNull();
      await advance(4 * STAFFING_SEARCH_POLL_MS);
      expect(gateway.get).toHaveBeenCalledTimes(1);
    } finally {
      notifyManager.setScheduler((callback) => setTimeout(callback, 0));
      vi.useRealTimers();
    }
  });
});

describe("the poll", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // react-query hands its results to the observers through a setTimeout(0), which fake timers drop from inside a tick.
    notifyManager.setScheduler((callback) => callback());
  });
  afterEach(() => {
    notifyManager.setScheduler((callback) => setTimeout(callback, 0));
    vi.useRealTimers();
  });

  it("reads the run every few seconds while it goes on, and stops for good when it has ended", async () => {
    gateway.get
      .mockResolvedValueOnce(view("PENDING", { startedAt: null, elapsedMs: 0 }))
      .mockResolvedValueOnce(view("RUNNING", { acceptedMoves: 1 }))
      .mockResolvedValueOnce(view("CANCELLING"))
      .mockResolvedValueOnce(view("SUCCEEDED", { stopReason: "LOCAL_OPTIMUM", hasProposal: true, finishedAt: "2026-11-20T10:05:00.000Z" }));
    const { wrapper } = harness();
    const { result } = renderHook(() => useLatestStaffingSearch(YEAR), { wrapper });

    await advance(0);
    expect(result.current.data?.status).toBe("PENDING");
    expect(gateway.get).toHaveBeenCalledTimes(1);

    // Not before its time.
    await advance(STAFFING_SEARCH_POLL_MS - 1);
    expect(gateway.get).toHaveBeenCalledTimes(1);

    await advance(1);
    expect(result.current.data?.status).toBe("RUNNING");
    await advance(STAFFING_SEARCH_POLL_MS);
    expect(result.current.data?.status).toBe("CANCELLING");
    await advance(STAFFING_SEARCH_POLL_MS);
    expect(result.current.data?.status).toBe("SUCCEEDED");
    expect(gateway.get).toHaveBeenCalledTimes(4);

    // Ended: nothing is read again, however long the dialog stays open.
    await advance(60 * STAFFING_SEARCH_POLL_MS);
    expect(gateway.get).toHaveBeenCalledTimes(4);
  });

  it.each<StaffingSearchStatus>(["SUCCEEDED", "CANCELLED", "FAILED"])("never polls a run that has ended (%s)", async (status) => {
    gateway.get.mockResolvedValue(view(status));
    const { wrapper } = harness();
    renderHook(() => useLatestStaffingSearch(YEAR), { wrapper });
    await advance(0);
    await advance(10 * STAFFING_SEARCH_POLL_MS);
    expect(gateway.get).toHaveBeenCalledTimes(1);
  });

  it("stops when the panel goes: nothing is read after the unmount, and the search is left to go on at the gateway", async () => {
    gateway.get.mockResolvedValue(view("RUNNING"));
    const { wrapper } = harness();
    const { unmount } = renderHook(() => useLatestStaffingSearch(YEAR), { wrapper });
    await advance(0);
    await advance(STAFFING_SEARCH_POLL_MS);
    expect(gateway.get).toHaveBeenCalledTimes(2);

    unmount();
    await advance(20 * STAFFING_SEARCH_POLL_MS);
    expect(gateway.get).toHaveBeenCalledTimes(2);
    // The only call to a run's state is the read: nothing cancelled it.
    expect(gateway.post).not.toHaveBeenCalled();
  });

  it("does not spin on a read that fails: it is tried again twice, a moment apart, and then the poll waits for the admin", async () => {
    gateway.get
      .mockResolvedValueOnce(view("RUNNING"))
      .mockRejectedValue(new ApiError(502, "Bad gateway"));
    const { wrapper } = harness();
    const { result } = renderHook(() => useLatestStaffingSearch(YEAR), { wrapper });
    await advance(0);
    expect(gateway.get).toHaveBeenCalledTimes(1);

    // The poll's own read, and its two tries after it (1.5 s apart): four reads in all.
    await advance(STAFFING_SEARCH_POLL_MS + 2 * 1_500);
    expect(gateway.get).toHaveBeenCalledTimes(4);
    expect(result.current.isError).toBe(true);
    // The run as it was last read is still what the panel has to show.
    expect(result.current.data?.status).toBe("RUNNING");

    await advance(100 * STAFFING_SEARCH_POLL_MS);
    expect(gateway.get).toHaveBeenCalledTimes(4);
  });

  it("takes the poll up again where it was when a read succeeds after a failure (the admin's Försök igen)", async () => {
    gateway.get
      .mockResolvedValueOnce(view("RUNNING"))
      .mockRejectedValueOnce(new ApiError(502, "Bad gateway"))
      .mockRejectedValueOnce(new ApiError(502, "Bad gateway"))
      .mockRejectedValueOnce(new ApiError(502, "Bad gateway"))
      .mockResolvedValue(view("RUNNING", { round: 9 }));
    const { wrapper } = harness();
    const { result } = renderHook(() => useLatestStaffingSearch(YEAR), { wrapper });
    await advance(0);
    await advance(STAFFING_SEARCH_POLL_MS + 2 * 1_500);
    expect(result.current.isError).toBe(true);
    expect(gateway.get).toHaveBeenCalledTimes(4);

    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.isError).toBe(false);
    expect(result.current.data?.round).toBe(9);
    expect(gateway.get).toHaveBeenCalledTimes(5);

    await advance(STAFFING_SEARCH_POLL_MS);
    expect(gateway.get).toHaveBeenCalledTimes(6);
  });

  it("does not try a refused read again: a 4xx is an answer", async () => {
    gateway.get.mockRejectedValue(new ApiError(404, "Academic year not found."));
    const { wrapper } = harness();
    const { result } = renderHook(() => useLatestStaffingSearch(YEAR), { wrapper });
    await advance(0);
    await advance(10_000);
    expect(result.current.isError).toBe(true);
    expect(gateway.get).toHaveBeenCalledTimes(1);
  });
});

describe("cancel", () => {
  it("posts to the run's cancel route and puts the answer (CANCELLING) where the poll reads it", async () => {
    const cancelling = view("CANCELLING");
    gateway.post.mockResolvedValue(cancelling);
    const { queryClient, wrapper } = harness();
    queryClient.setQueryData(latestSearchKey(YEAR), view("RUNNING"));
    const { result } = renderHook(() => useCancelStaffingSearch(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync("run-1");
    });
    expect(gateway.post).toHaveBeenCalledWith(`${BASE}/run-1/cancel`);
    expect(queryClient.getQueryData(latestSearchKey(YEAR))).toEqual(cancelling);
  });

  it("reads the runs again when the cancel fails (the run may be gone, or have ended meanwhile)", async () => {
    gateway.post.mockRejectedValue(new ApiError(404, "Sökningen finns inte längre.", "STAFFING_SEARCH_GONE"));
    const { wrapper, invalidated } = harness();
    const { result } = renderHook(() => useCancelStaffingSearch(), { wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync("run-1")).rejects.toBeInstanceOf(ApiError);
    });
    expect(invalidated).toHaveBeenCalled();
  });
});

describe("the proposal", () => {
  it("is read from the run's own route once the admin asks, and handed back whole", async () => {
    const answer = { proposal: { basisSha256: "a".repeat(64), assignments: [] }, figures: null };
    gateway.get.mockResolvedValue(answer);
    const { wrapper } = harness();
    const { result } = renderHook(() => useStaffingSearchProposal(), { wrapper });
    await act(async () => {
      expect(await result.current.mutateAsync("run-1")).toBe(answer);
    });
    expect(gateway.get).toHaveBeenCalledWith(`${BASE}/run-1/proposal`);
  });
});

describe("what a refusal is", () => {
  it.each([
    ["STAFFING_SEARCH_ALREADY_RUNNING", "ALREADY_RUNNING"],
    ["STAFFING_SEARCH_NO_QUALIFICATIONS", "NO_QUALIFICATIONS"],
    ["STAFFING_SEARCH_NOT_READY", "NOT_READY"],
    ["STAFFING_SEARCH_NO_POSTS", "NO_POSTS"],
  ])("a start refused with %s is %s", (code, kind) => {
    expect(classifyStartError(new ApiError(409, "…", code))).toEqual({ kind });
  });

  it("a throttled or an unavailable start has its own kind, and any other keeps the gateway's code and values for the engine catalogue", () => {
    expect(classifyStartError(new ApiError(429, "Too Many Requests"))).toEqual({ kind: "THROTTLED" });
    expect(classifyStartError(new ApiError(503, "Service Unavailable"))).toEqual({ kind: "UNAVAILABLE" });
    expect(classifyStartError(new ApiError(409, "Veckan nekas", "TEACHER_WORK_DAYS", { days: 4 }))).toEqual({
      kind: "OTHER",
      message: "Veckan nekas",
      code: "TEACHER_WORK_DAYS",
      params: { days: 4 },
    });
    expect(classifyStartError(new Error("offline"))).toEqual({ kind: "OTHER", message: "", code: null, params: null });
  });

  it.each([
    [409, "STAFF_PROPOSAL_STALE", "STALE"],
    [404, "STAFFING_SEARCH_GONE", "GONE"],
    [409, "STAFFING_SEARCH_NOT_DONE", "NOT_DONE"],
    [404, "STAFFING_SEARCH_NO_PROPOSAL", "NO_PROPOSAL"],
  ])("a proposal refused (%i %s) is %s", (status, code, kind) => {
    expect(classifyProposalError(new ApiError(status, "…", code))).toEqual({ kind });
  });

  it("any other failure of the proposal keeps the gateway's own words", () => {
    expect(classifyProposalError(new ApiError(500, "Internal"))).toEqual({ kind: "OTHER", message: "Internal" });
    expect(classifyProposalError("x")).toEqual({ kind: "OTHER", message: "" });
  });
});

describe("the statuses a run is polled in", () => {
  it.each<[StaffingSearchStatus | null | undefined, boolean]>([
    ["PENDING", true],
    ["RUNNING", true],
    ["CANCELLING", true],
    ["SUCCEEDED", false],
    ["CANCELLED", false],
    ["FAILED", false],
    [null, false],
    [undefined, false],
  ])("%s is active: %s", (status, active) => {
    expect(isActiveSearch(status)).toBe(active);
  });
});

describe("how a run that has ended is worded", () => {
  it("words a run the engine kept waiting too long as SEARCH_ENGINE_BUSY, by its code and by its stop, like one the engine kept failing", () => {
    expect(failedKey(view("FAILED", { errorCode: "SEARCH_ENGINE_BUSY", stopReason: "ENGINE_BUSY" }))).toBe("SEARCH_ENGINE_BUSY");
    // The code is what the gateway wrote; a run without one still says what stopped it.
    expect(failedKey(view("FAILED", { errorCode: null, stopReason: "ENGINE_BUSY" }))).toBe("SEARCH_ENGINE_BUSY");
    expect(failedKey(view("FAILED", { errorCode: "SEARCH_ENGINE_FAILING", stopReason: "ENGINE_FAILING" }))).toBe("SEARCH_ENGINE_FAILING");
    expect(failedKey(view("FAILED", { errorCode: "SEARCH_ENGINE_OLDER", stopReason: "ENGINE_OLDER" }))).toBe("SEARCH_ENGINE_OLDER");
    // A code from a newer gateway is a plain failure, whatever the stop.
    expect(failedKey(view("FAILED", { errorCode: "SOMETHING_NEWER", stopReason: null }))).toBe("SEARCH_FAILED");
  });

  it("gives a run that stopped on the engine without failing the plain 'done' sentence, with or without moves", () => {
    expect(endedKey(view("SUCCEEDED", { stopReason: "ENGINE_BUSY", acceptedMoves: 0 }))).toBe("DONE");
    expect(endedKey(view("SUCCEEDED", { stopReason: "ENGINE_BUSY", acceptedMoves: 3 }))).toBe("DONE");
    expect(endedKey(view("SUCCEEDED", { stopReason: "BUDGET", acceptedMoves: 3 }))).toBe("BUDGET");
    expect(endedKey(view("SUCCEEDED", { stopReason: "BUDGET", acceptedMoves: 0 }))).toBe("BUDGET_NONE");
  });
});

describe("what the search left out", () => {
  const leftOut = (over: Partial<StaffingSearchLeftOut> = {}): StaffingSearchLeftOut => ({ posts: [], years: [], ...over });

  it("is nothing to print when nothing was left out, when the run has no figures yet, and for a count of nothing", () => {
    expect(leftOutLines(null)).toEqual([]);
    expect(leftOutLines(undefined)).toEqual([]);
    expect(leftOutLines(leftOut())).toEqual([]);
    expect(leftOutLines(leftOut({ posts: [{ reason: "NOT_FREE", count: 0 }] }))).toEqual([]);
  });

  it("gives a line for each reason with posts, in the gateway's order, and then each year, the lowest first", () => {
    const lines = leftOutLines(
      leftOut({
        posts: [
          { reason: "NOT_FREE", count: 4 },
          { reason: "UNSTAFFED", count: 2 },
          { reason: "YEAR_LIMIT", count: 1 },
        ],
        years: [
          { year: 9, reason: "YEAR_NOT_COUNTED" },
          { year: 7, reason: "YEAR_LIMIT" },
        ],
      }),
    );
    expect(lines).toEqual([
      { kind: "posts", reason: "NOT_FREE", count: 4 },
      { kind: "posts", reason: "UNSTAFFED", count: 2 },
      { kind: "posts", reason: "YEAR_LIMIT", count: 1 },
      { kind: "year", reason: "YEAR_LIMIT", year: 7 },
      { kind: "year", reason: "YEAR_NOT_COUNTED", year: 9 },
    ]);
  });

  it("does not reorder or change what it is given", () => {
    const given = leftOut({ years: [{ year: 9, reason: "YEAR_LIMIT" }, { year: 7, reason: "YEAR_LIMIT" }] });
    leftOutLines(given);
    expect(given.years.map((entry) => entry.year)).toEqual([9, 7]);
  });
});

describe("the figures", () => {
  const week = (before: [number, number], after: [number, number], period: number | null = null): StaffingSearchWeekFigure => ({
    period,
    parity: null,
    from: null,
    to: null,
    before: { demandMinutes: before[0], capacityMinutes: before[1] },
    after: { demandMinutes: after[0], capacityMinutes: after[1] },
  });

  it("takes a year's tightest week as the largest share of its OWN supply, not the largest number of minutes", () => {
    const weeks = [week([2000, 2275], [1900, 2275], 0), week([1300, 1300], [1000, 1300], 1), week([2100, 2275], [2000, 2275], 2)];
    // Before: 87.9 %, 100 % and 92.3 %: the short week is the tight one though it asks for fewest minutes. After: 83.5 %, 76.9 % and 87.9 %.
    expect(tightestPercent(weeks, "before")).toBeCloseTo(100, 6);
    expect(tightestPercent(weeks, "after")).toBeCloseTo((2000 / 2275) * 100, 6);
  });

  it("leaves out a week without supply and says nothing for a year with none", () => {
    expect(tightestPercent([week([100, 0], [100, 0])], "before")).toBeNull();
    expect(tightestPercent([], "after")).toBeNull();
    expect(tightestPercent([week([100, 0], [90, 100])], "before")).toBeNull();
    expect(tightestPercent([week([100, 0], [90, 100])], "after")).toBeCloseTo(90, 6);
  });

  it("gives each judged year, the lowest first, with its tightest week before and now", () => {
    const figures: StaffingSearchFiguresDoc = {
      years: [
        { year: 9, weeks: [week([2280, 2275], [2193, 2275])] },
        { year: 7, weeks: [week([2000, 2275], [2000, 2275])] },
        { year: 8, weeks: [week([5, 0], [5, 0])] },
      ],
      leftOut: { posts: [], years: [] },
    };
    const lines = yearLines(figures);
    expect(lines.map((line) => line.year)).toEqual([7, 9]);
    expect(lines[1]!.before).toBeCloseTo(100.2198, 3);
    expect(lines[1]!.after).toBeCloseTo(96.4, 1);
    expect(yearLines(null)).toEqual([]);
  });

  it("splits a time into minutes and seconds, rounded to the second and never negative", () => {
    expect(splitDuration(0)).toEqual({ minutes: 0, seconds: 0 });
    expect(splitDuration(45_400)).toEqual({ minutes: 0, seconds: 45 });
    expect(splitDuration(80_000)).toEqual({ minutes: 1, seconds: 20 });
    expect(splitDuration(600_000)).toEqual({ minutes: 10, seconds: 0 });
    expect(splitDuration(-5)).toEqual({ minutes: 0, seconds: 0 });
  });
});
