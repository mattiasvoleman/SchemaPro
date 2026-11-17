import { describe, expect, it } from "vitest";
import fixture from "../../src/optimization/__fixtures__/placement-refusal-lines.json";
import { blockLinkFromAddress, lessonOfBlockLink } from "./placement-block-link";
import { blockCardId, blockKeyOf } from "./placement-block-rows";
import type { BoardBlock, BoardBlockRow } from "./placement-board";
import { placementLinkOfRefusal } from "./placement-link";

/**
 * "VISA I VECKAN" UNDER A BLOCK'S ROW LEADS TO THE BLOCK'S CARD (A3's LÅG-5, held by C2).
 *
 * A3's Generera builds the address of a refusal that names a block's lesson (placement-link.ts, from the ids the gateway puts in its params:
 * the post that is a member, the block, the day and the clock time of the lesson); the handbook says the link points at the block's card. A3's
 * own contract test pins the address and that A3's reader gives it back. This pins the other end, which is C2's: the week's block reader
 * (placement-block-link.ts) takes the SAME addresses, from the gateway's own lines (src/optimization/__fixtures__/placement-refusal-lines.json,
 * checked against the real code by src/optimization/placement-refusal-lines.spec.ts), finds the lesson on the block, and names the card the
 * week draws for it. Without it a change of either builder or reader would leave the link opening the week with nothing marked.
 */

interface Entry {
  name: string;
  postId: string | null;
  blockId: string | null;
  line: { category: string; params?: Record<string, string | number> };
}
const lines = (fixture as unknown as { lines: Entry[] }).lines;
const ofBlocks = lines.filter((entry) => entry.blockId !== null);

const lesson = (id: string, over: Partial<BoardBlockRow>): BoardBlockRow => ({
  id,
  dayOfWeek: 1,
  startTime: "08:00",
  endTime: "09:00",
  minutes: 60,
  recurrence: "ALL_WEEKS",
  rooms: [],
  changedAt: "2026-11-13T08:00:00.000Z",
  verdicts: [],
  ...over,
});

/** The block the line names, with a lesson where the line says it stands, and another that it does not. */
const blockOf = (entry: Entry): BoardBlock => {
  const params = entry.line.params!;
  const start = String(params["start"]);
  const end = String(params["end"]);
  return {
    id: entry.blockId!,
    name: "Språkval",
    memberIds: [entry.postId!],
    lengths: [60, 60],
    recurrence: "ALL_WEEKS",
    followsBlockId: null,
    cannotPlace: null,
    rows: [
      lesson("other", { dayOfWeek: 5, startTime: "15:00", endTime: "16:00" }),
      lesson("named", { dayOfWeek: Number(params["day"]), startTime: start, endTime: end }),
    ],
    rowsKey: "k",
  };
};

describe("a block's refusal link, from the gateway's own lines, read by the week's block reader", () => {
  it("has lines for a block's lesson in the fixture, so that these cases are not an empty set", () => {
    expect(ofBlocks.map((entry) => entry.name)).toEqual(expect.arrayContaining(["preflight-block", "engine-block-member"]));
  });

  it.each(ofBlocks.map((entry) => [entry.name, entry] as const))("%s: the link names the block, the day and the start the line is about", (_name, entry) => {
    const href = placementLinkOfRefusal(entry.line.params, "y2")!;
    expect(blockLinkFromAddress(href.slice(href.indexOf("?")))).toEqual({
      blockId: entry.blockId,
      dayOfWeek: entry.line.params!["day"],
      startTime: entry.line.params!["start"],
    });
  });

  it.each(ofBlocks.map((entry) => [entry.name, entry] as const))("%s: the lesson found is the one at that place, and its card is the block's card for it", (_name, entry) => {
    const href = placementLinkOfRefusal(entry.line.params, "y2")!;
    const link = blockLinkFromAddress(href.slice(href.indexOf("?")))!;
    const block = blockOf(entry);
    const found = lessonOfBlockLink([block], link);
    expect(found?.row.id).toBe("named");
    // `blockplacement:`, not a post's `placement:`: the card the week draws for a lesson of a block, named by the lesson.
    const params = entry.line.params!;
    expect(found?.card).toBe(blockCardId(blockKeyOf(block.id, { minutes: 60, dayOfWeek: Number(params["day"]), startTime: String(params["start"]), recurrence: "ALL_WEEKS" })));
    expect(found?.card.startsWith("blockplacement:")).toBe(true);
  });

  it.each(ofBlocks.map((entry) => [entry.name, entry] as const))("%s: a block that no longer has a lesson there is not found, which the page says in words", (_name, entry) => {
    const href = placementLinkOfRefusal(entry.line.params, "y2")!;
    const link = blockLinkFromAddress(href.slice(href.indexOf("?")))!;
    const block = { ...blockOf(entry), rows: blockOf(entry).rows.filter((row) => row.id !== "named") };
    expect(lessonOfBlockLink([block], link)).toBeNull();
  });
});
