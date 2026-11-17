import { describe, expect, it } from "vitest";
import { placedCountOf, type PlacedCountBoard } from "./placed-count";

const post = (...placed: number[]) => ({ parts: placed.map((n) => ({ placed: n })) });
const row = (ok: boolean) => ({ verdict: { ok } });
const blockRow = (...ok: boolean[]) => ({ verdicts: ok.map((value) => ({ ok: value })) });

describe("placedCountOf", () => {
  it("is nothing for a week with nothing placed", () => {
    expect(placedCountOf({ posts: [post(0), post(0, 0)], placements: [] })).toEqual({ fixed: 0, failing: 0 });
    expect(placedCountOf({ posts: [], placements: [] })).toEqual({ fixed: 0, failing: 0 });
  });

  it("sums every part of every post, as the week's own summary does (a block's lesson is counted for each member through its posts)", () => {
    expect(placedCountOf({ posts: [post(2), post(1, 3), post(0)], placements: [row(true)] })).toEqual({ fixed: 6, failing: 0 });
  });

  it("counts the rows the judge says no to, and not the ones it says yes to", () => {
    expect(placedCountOf({ posts: [post(3)], placements: [row(true), row(false), row(true), row(false)] }).failing).toBe(2);
  });

  it("counts a block's lesson once when any member's verdict fails, and not when every member holds", () => {
    const board: PlacedCountBoard = {
      posts: [post(2)],
      placements: [],
      blocks: [{ rows: [blockRow(true, true), blockRow(true, false), blockRow(false, false)] }, { rows: [blockRow(true)] }],
    };
    expect(placedCountOf(board).failing).toBe(2);
  });

  it("adds the posts' rows and the blocks' rows that fail", () => {
    expect(placedCountOf({ posts: [post(1)], placements: [row(false)], blocks: [{ rows: [blockRow(false)] }] }).failing).toBe(2);
  });

  it("reads a board with no blocks (a gateway before them, or a week that has none) as having none", () => {
    expect(placedCountOf({ posts: [post(1)], placements: [row(false)] })).toEqual({ fixed: 1, failing: 1 });
    expect(placedCountOf({ posts: [post(1)], placements: [], blocks: [] })).toEqual({ fixed: 1, failing: 0 });
  });
});
