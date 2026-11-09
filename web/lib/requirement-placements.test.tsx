import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import {
  REQUIREMENT_PLACEMENTS_KEY,
  placementsByRequirement,
  placementsRefusal,
  useRequirementPlacements,
  type RequirementPlacement,
} from "./requirement-placements";

/**
 * Förlagda poster, as the timplan page reads them. What the gateway judges,
 * stores and refuses is its own specs'; here the year's request is recorded and
 * answered, and the module is held to the path it asks, the grouping it makes
 * and how it reads the two 409s that tell a row from a set. The dialog's reads
 * and write are requirement-placements-api.test.ts.
 */

const calls = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: { get: calls.get },
}));

const row = (extra: Partial<RequirementPlacement> = {}): RequirementPlacement => ({
  id: "p1",
  requirementId: "r1",
  dayOfWeek: 2,
  startTime: "10:00",
  endTime: "11:00",
  minutes: 60,
  roomId: "room-1",
  roomName: "Simhallen",
  recurrence: "ALL_WEEKS",
  teacherId: null,
  ...extra,
});

beforeEach(() => {
  calls.get.mockReset();
});

describe("the year's placed lessons", () => {
  const wrap = (client: QueryClient) =>
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    };

  it("asks the gateway for the picked year, and for nothing before there is one", async () => {
    calls.get.mockResolvedValue([row()]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result, rerender } = renderHook(({ year }: { year: string | null }) => useRequirementPlacements(year), {
      wrapper: wrap(client),
      initialProps: { year: null as string | null },
    });
    expect(calls.get).not.toHaveBeenCalled();

    rerender({ year: "y 1" });
    await waitFor(() => expect(result.current.data).toEqual([row()]));
    // The id is encoded: it is a query string.
    expect(calls.get).toHaveBeenCalledWith("/api/v1/teaching-requirements/placements?academicYearId=y%201");
    expect(client.getQueryState([...REQUIREMENT_PLACEMENTS_KEY, "y 1"])?.status).toBe("success");
  });
});

describe("the posts' placed lessons", () => {
  it("are grouped by post, in the order they came", () => {
    const grouped = placementsByRequirement([
      row({ id: "a", requirementId: "r1" }),
      row({ id: "b", requirementId: "r2" }),
      row({ id: "c", requirementId: "r1", dayOfWeek: 4 }),
    ]);

    expect([...grouped.keys()]).toEqual(["r1", "r2"]);
    expect(grouped.get("r1")!.map((placement) => placement.id)).toEqual(["a", "c"]);
  });

  it("are none while the read has not answered", () => {
    expect(placementsByRequirement(undefined).size).toBe(0);
  });
});

describe("a refused write", () => {
  it("is a post the rows do not fit, with the rule", () => {
    const error = new ApiError(409, "x", "REQUIREMENT_PLACEMENTS_DO_NOT_FIT", { reason: "PAIRS" });
    expect(placementsRefusal(error)).toEqual({ kind: "FIT", reason: "PAIRS", params: { reason: "PAIRS" } });
  });

  it("is a post the rows do not fit, with the row a per-teacher rule names when the rows were sent", () => {
    const error = new ApiError(409, "x", "REQUIREMENT_PLACEMENTS_DO_NOT_FIT", { reason: "TEACHER_COUNT", index: 2 });
    expect(placementsRefusal(error)).toEqual({
      kind: "FIT",
      reason: "TEACHER_COUNT",
      params: { reason: "TEACHER_COUNT", index: 2 },
    });
  });

  it("is a post whose change of teacher the placed lessons do not follow, with the placement to change first", () => {
    const params = { reason: "TEACHER", day: 2, start: "10:00", end: "11:00", weeks: "ODD_WEEKS" };
    const error = new ApiError(409, "x", "REQUIREMENT_PLACEMENTS_DO_NOT_FIT", params);
    expect(placementsRefusal(error)).toEqual({ kind: "FIT", reason: "TEACHER", params });
  });

  it("reads a placement nobody teaches (its teacher removed) as UNSTAFFED, which can only be removed", () => {
    const params = { reason: "TEACHER_COUNT", day: 2, start: "10:00", end: "11:00", weeks: "ALL_WEEKS", unstaffed: 1 };
    const error = new ApiError(409, "x", "REQUIREMENT_PLACEMENTS_DO_NOT_FIT", params);
    expect(placementsRefusal(error)).toEqual({ kind: "FIT", reason: "UNSTAFFED", params });
  });

  it("is the first row the judge refuses, with its place in the list and what the sentence needs", () => {
    const error = new ApiError(409, "x", "REQUIREMENT_PLACEMENT_REFUSED", {
      index: 1,
      reason: "TEACHER",
      otherKind: "LESSON",
      className: "7B",
      subjectName: "Matematik",
      day: 2,
      start: "10:00",
      end: "11:00",
    });

    expect(placementsRefusal(error)).toEqual({
      kind: "ROW",
      index: 1,
      reason: "TEACHER",
      params: { otherKind: "LESSON", className: "7B", subjectName: "Matematik", day: 2, start: "10:00", end: "11:00" },
    });
  });

  it.each([
    ["another 409", new ApiError(409, "x", "SCHEDULE_BUSY")],
    ["a 409 with no rule", new ApiError(409, "x", "REQUIREMENT_PLACEMENTS_DO_NOT_FIT")],
    ["a row refusal with no index", new ApiError(409, "x", "REQUIREMENT_PLACEMENT_REFUSED", { reason: "ROOM" })],
    ["a row refusal with no reason", new ApiError(409, "x", "REQUIREMENT_PLACEMENT_REFUSED", { index: 0 })],
    ["the right code under another status", new ApiError(400, "x", "REQUIREMENT_PLACEMENTS_DO_NOT_FIT", { reason: "LENGTH" })],
    ["a plain error", new Error("boom")],
    ["nothing", undefined],
  ])("is not read from %s", (_what, error) => {
    expect(placementsRefusal(error)).toBeNull();
  });
});
