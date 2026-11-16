import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { MessageLookup } from "@/lib/engine-message";
import {
  blockCannotPlace,
  blockFitSentence,
  blockPlacementsKey,
  blockPlacementsRefusal,
  fetchPlacementsOfBlock,
  partsOfLengths,
  saveBlockPlacements,
} from "./block-placements";

const calls = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: { get: calls.get, put: calls.put },
}));

/** Förlägg blocket's reads, its write and the way a 409 is read: the dialog's own tests hold what it does with them. */

describe("the block's reads and write", () => {
  it("reads and replaces one block's lessons on the block's own route, with the key the lessons were read with", async () => {
    calls.get.mockResolvedValue({ placements: [] });
    calls.put.mockResolvedValue({ placements: [] });

    await fetchPlacementsOfBlock("b/1");
    await saveBlockPlacements("b/1", [{ dayOfWeek: 2, startTime: "10:00", minutes: 60, rooms: [] }], "key");

    expect(calls.get).toHaveBeenCalledWith("/api/v1/teaching-blocks/b%2F1/placements");
    expect(calls.put).toHaveBeenCalledWith("/api/v1/teaching-blocks/b%2F1/placements", {
      placements: [{ dayOfWeek: 2, startTime: "10:00", minutes: 60, rooms: [] }],
      baseKey: "key",
    });
  });

  it("keeps a block's read under the prefix every write of placed lessons invalidates, which the week's board and the marks share", () => {
    expect(blockPlacementsKey("b1")).toEqual(["requirementPlacements", "block", "b1"]);
  });
});

describe("partsOfLengths", () => {
  it("counts the block's lessons by length, longest first, whatever order they come in", () => {
    expect(partsOfLengths([80, 40, 40])).toEqual([
      { minutes: 80, count: 1 },
      { minutes: 40, count: 2 },
    ]);
    expect(partsOfLengths([40, 80, 40])).toEqual([
      { minutes: 80, count: 1 },
      { minutes: 40, count: 2 },
    ]);
    expect(partsOfLengths([60, 60])).toEqual([{ minutes: 60, count: 2 }]);
    expect(partsOfLengths([])).toEqual([]);
  });
});

describe("blockCannotPlace", () => {
  const post = (shares?: unknown[] | null) => ({ shares });

  it("is a block that follows another first, then one with no post, then one with a post that shares its lessons", () => {
    expect(blockCannotPlace({ sameTimesAsBlockId: "other" }, [])).toBe("FOLLOWER");
    expect(blockCannotPlace({ sameTimesAsBlockId: "other" }, [post([{}])])).toBe("FOLLOWER");
    expect(blockCannotPlace({ sameTimesAsBlockId: null }, [])).toBe("EMPTY");
    expect(blockCannotPlace({}, [post(), post([{}])])).toBe("SHARES");
  });

  it("is nothing for a block whose posts share nothing, whether the shares are an empty list, null or left out", () => {
    expect(blockCannotPlace({ sameTimesAsBlockId: null }, [post([]), post(null), post()])).toBeNull();
  });
});

describe("blockPlacementsRefusal", () => {
  const refusal = (status: number, code: string | undefined, params?: Record<string, string | number>) =>
    blockPlacementsRefusal(new ApiError(status, "x", code, params));

  it("reads a rule the lessons break, with the lesson when the rule is about one", () => {
    expect(refusal(409, "BLOCK_PLACEMENTS_DO_NOT_FIT", { reason: "LENGTH", index: 1 })).toEqual({ kind: "FIT", reason: "LENGTH", index: 1 });
    expect(refusal(409, "BLOCK_PLACEMENTS_DO_NOT_FIT", { reason: "SHARES", blockId: "b" })).toEqual({ kind: "FIT", reason: "SHARES", index: null });
    expect(refusal(409, "BLOCK_PLACEMENTS_DO_NOT_FIT", { index: 1 })).toBeNull();
  });

  it("reads the first lesson the week does not hold, by the post it is said of, and keeps the rest for the sentence", () => {
    expect(
      refusal(409, "BLOCK_PLACEMENT_REFUSED", { index: 1, requirementId: "r1", reason: "TEACHER", className: "7B", day: 2 }),
    ).toEqual({ kind: "ROW", index: 1, requirementId: "r1", reason: "TEACHER", params: { className: "7B", day: 2 } });
    expect(refusal(409, "BLOCK_PLACEMENT_REFUSED", { index: 1, reason: "TEACHER" })).toBeNull();
    expect(refusal(409, "BLOCK_PLACEMENT_REFUSED", { requirementId: "r1", reason: "TEACHER" })).toBeNull();
    expect(refusal(409, "BLOCK_PLACEMENT_REFUSED", { index: 1, requirementId: "r1" })).toBeNull();
  });

  it("reads a save made on a read that is no longer the stored one", () => {
    expect(refusal(409, "BLOCK_PLACEMENTS_STALE")).toEqual({ kind: "STALE" });
  });

  it("reads nothing of any other error: another code, another status, or something that is no ApiError", () => {
    expect(refusal(409, "SCHEDULE_BUSY")).toBeNull();
    expect(refusal(409, undefined)).toBeNull();
    expect(refusal(400, "BLOCK_PLACEMENTS_STALE")).toBeNull();
    expect(blockPlacementsRefusal(new Error("boom"))).toBeNull();
    expect(blockPlacementsRefusal(undefined)).toBeNull();
  });
});

describe("blockFitSentence", () => {
  const t = Object.assign(
    (key: string, values?: Record<string, string | number>) => (values ? `${key}(${Object.values(values).join("|")})` : key),
    { has: (key: string) => key !== "fit.SOMETHING_NEW" },
  ) as MessageLookup;

  it("says the sentence of the rule, with the block it points at", () => {
    expect(blockFitSentence(t, "FOLLOWER", "Elevens val åk 7")).toBe("fit.FOLLOWER(Elevens val åk 7)");
    expect(blockFitSentence(t, "LENGTH")).toBe("fit.LENGTH()");
  });

  it("says the general sentence for a rule a newer gateway sends", () => {
    expect(blockFitSentence(t, "SOMETHING_NEW")).toBe("fit.UNKNOWN");
  });
});
