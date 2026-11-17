import { describe, expect, it } from "vitest";
import type { BoardBlock, BoardBlockRow, BoardKept, BoardMeal, BoardPlacement } from "./placement-board";
import { narrowToWeek, type WeekCards } from "./placement-week-view";

/**
 * One week picked narrows the CARDS to what runs that week. The week of 2026-08-17 is week 34 (even), 2026-08-24 week 35 (odd),
 * 2026-12-14 week 51 (odd), 2026-12-21 week 52 (even), 2027-01-11 week 2 (even).
 */

const row = (over: Partial<BoardPlacement>): BoardPlacement => ({
  id: "r",
  requirementId: "post-ma",
  dayOfWeek: 2,
  startTime: "10:00",
  endTime: "11:00",
  minutes: 60,
  roomId: "r-a12",
  roomName: "A12",
  recurrence: "ALL_WEEKS",
  teacherId: null,
  changedAt: "2026-11-13T08:00:00.000Z",
  verdict: { ok: true },
  ...over,
});
const kept = (over: Partial<BoardKept>): BoardKept => ({
  id: "k",
  dayOfWeek: 1,
  startTime: "08:00",
  endTime: "09:00",
  studentGroupId: "g-7a",
  extraGroupIds: [],
  subjectId: "s-sl",
  teacherId: "bo",
  coTeacherId: null,
  roomId: null,
  recurrence: "ALL_WEEKS",
  startDate: null,
  endDate: null,
  locked: true,
  generated: false,
  ...over,
});
const meal = (over: Partial<BoardMeal>): BoardMeal => ({ id: "m", studentGroupId: "g-7a", dayOfWeek: 2, startTime: "11:00", endTime: "11:30", startDate: null, endDate: null, ...over });
const blockRow = (over: Partial<BoardBlockRow>): BoardBlockRow => ({ id: "br", dayOfWeek: 3, startTime: "09:00", endTime: "10:00", minutes: 60, recurrence: "ALL_WEEKS", rooms: [], changedAt: "2026-11-13T08:00:00.000Z", verdicts: [], ...over });
const block = (rows: BoardBlockRow[]): BoardBlock => ({ id: "b1", name: "Språkval", memberIds: ["post-sv", "post-fr"], lengths: [60], recurrence: "ALL_WEEKS", followsBlockId: null, cannotPlace: null, rows, rowsKey: "k" });

// Whole posts, as the board holds them, with the weeks of their own: what a row runs is its own weeks and its post's DATES, never the post's weeks.
const posts = new Map([
  ["post-ma", { recurrence: "ALL_WEEKS", startDate: null, endDate: null }],
  ["post-ht", { recurrence: "ODD_WEEKS", startDate: null, endDate: "2026-12-18" }],
  ["post-vt", { recurrence: "EVEN_WEEKS", startDate: "2027-01-11", endDate: null }],
  ["post-sv", { recurrence: "ODD_WEEKS", startDate: null, endDate: "2026-12-18" }],
]);

const cards = (over: Partial<WeekCards> = {}): WeekCards => ({ placements: [], kept: [], meals: [], blocks: [], ...over });
const ids = (rows: readonly { id: string }[]) => rows.map((entry) => entry.id);

describe("a week picked", () => {
  it("shows a row of odd weeks in an odd week only, and an every-week row in every week", () => {
    const view = cards({ placements: [row({ id: "all" }), row({ id: "odd", recurrence: "ODD_WEEKS" }), row({ id: "even", recurrence: "EVEN_WEEKS" })] });
    expect(ids(narrowToWeek(view, posts, "2026-08-17").placements)).toEqual(["all", "even"]);
    expect(ids(narrowToWeek(view, posts, "2026-08-24").placements)).toEqual(["all", "odd"]);
  });

  it("reads a row's dates off its post, which a förläggning has none of its own: an HT post is not in January, a VT post not in December", () => {
    const view = cards({ placements: [row({ id: "ht", requirementId: "post-ht" }), row({ id: "vt", requirementId: "post-vt" })] });
    expect(ids(narrowToWeek(view, posts, "2026-12-14").placements)).toEqual(["ht"]);
    expect(ids(narrowToWeek(view, posts, "2027-01-11").placements)).toEqual(["vt"]);
  });

  it("holds a lesson to its own day: an HT post that ends on a Friday the 18th is in the week of the 14th on every day of it, and in none of the next", () => {
    const view = cards({ placements: [row({ id: "fri", requirementId: "post-ht", dayOfWeek: 5 }), row({ id: "mon", requirementId: "post-ht", dayOfWeek: 1 })] });
    expect(ids(narrowToWeek(view, posts, "2026-12-14").placements)).toEqual(["fri", "mon"]);
    expect(ids(narrowToWeek(view, posts, "2026-12-21").placements)).toEqual([]);
  });

  it("treats a row of a post the board does not hold as running the year", () => {
    expect(ids(narrowToWeek(cards({ placements: [row({ id: "x", requirementId: "gone" })] }), posts, "2027-01-11").placements)).toEqual(["x"]);
  });

  it("narrows the lessons Generera keeps by their own weeks and dates", () => {
    const view = cards({ kept: [kept({ id: "a" }), kept({ id: "odd", recurrence: "ODD_WEEKS" }), kept({ id: "autumn", endDate: "2026-10-30" })] });
    expect(ids(narrowToWeek(view, posts, "2026-08-17").kept)).toEqual(["a", "autumn"]);
    expect(ids(narrowToWeek(view, posts, "2026-12-14").kept)).toEqual(["a", "odd"]);
  });

  it("narrows a meal by its dates (it has no parity)", () => {
    const view = cards({ meals: [meal({ id: "year" }), meal({ id: "autumn", endDate: "2026-10-30" }), meal({ id: "spring", startDate: "2027-01-11" })] });
    expect(ids(narrowToWeek(view, posts, "2026-09-07").meals)).toEqual(["year", "autumn"]);
    expect(ids(narrowToWeek(view, posts, "2027-01-11").meals)).toEqual(["year", "spring"]);
  });

  it("narrows a block's lessons by the block's weeks and its first post's dates, and keeps the block", () => {
    const view = cards({ blocks: [block([blockRow({ id: "all" }), blockRow({ id: "odd", recurrence: "ODD_WEEKS" })])] });
    const week34 = narrowToWeek(view, posts, "2026-08-17").blocks[0]!;
    expect(ids(week34.rows)).toEqual(["all"]);
    expect(week34.name).toBe("Språkval");
    expect(ids(narrowToWeek(view, posts, "2026-08-24").blocks[0]!.rows)).toEqual(["all", "odd"]);
    // The first post ends on the 18th of December: the block's lessons are not in January.
    expect(ids(narrowToWeek(view, posts, "2027-01-11").blocks[0]!.rows)).toEqual([]);
  });

  it("leaves every other field of the view as it is, and the input untouched", () => {
    const view = { ...cards({ placements: [row({ id: "odd", recurrence: "ODD_WEEKS" })] }), posts: ["p"] };
    const narrowed = narrowToWeek(view, posts, "2026-08-17");
    expect(narrowed.posts).toBe(view.posts);
    expect(view.placements).toHaveLength(1);
  });
});

describe("a card's own day is asked of the dates, not the Monday of its week", () => {
  // A window that ends on a Tuesday (2026-12-15, in the week of 2026-12-14): Tuesday's card stands that week and Thursday's does not.
  const untilTuesday = new Map([["post-tue", { recurrence: "ALL_WEEKS", startDate: null, endDate: "2026-12-15" }]]);
  const WEEK = "2026-12-14";

  it("holds a placement of the post's window's last day and not one after it", () => {
    const view = cards({ placements: [row({ id: "tue", requirementId: "post-tue", dayOfWeek: 2 }), row({ id: "thu", requirementId: "post-tue", dayOfWeek: 4 })] });
    expect(ids(narrowToWeek(view, untilTuesday, WEEK).placements)).toEqual(["tue"]);
  });

  it("holds a kept lesson of its own last day and not one after it", () => {
    const view = cards({ kept: [kept({ id: "tue", dayOfWeek: 2, endDate: "2026-12-15" }), kept({ id: "thu", dayOfWeek: 4, endDate: "2026-12-15" })] });
    expect(ids(narrowToWeek(view, untilTuesday, WEEK).kept)).toEqual(["tue"]);
  });

  it("holds a meal of its own last day and not one after it", () => {
    const view = cards({ meals: [meal({ id: "tue", dayOfWeek: 2, endDate: "2026-12-15" }), meal({ id: "thu", dayOfWeek: 4, endDate: "2026-12-15" })] });
    expect(ids(narrowToWeek(view, untilTuesday, WEEK).meals)).toEqual(["tue"]);
  });

  it("holds a block's lesson of the first member's window's last day and not one after it", () => {
    const view = cards({ blocks: [{ ...block([blockRow({ id: "tue", dayOfWeek: 2 }), blockRow({ id: "thu", dayOfWeek: 4 })]), memberIds: ["post-tue", "post-other"] }] });
    expect(ids(narrowToWeek(view, untilTuesday, WEEK).blocks[0]!.rows)).toEqual(["tue"]);
  });
});
