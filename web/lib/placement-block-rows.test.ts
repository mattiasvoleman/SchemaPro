import { describe, expect, it } from "vitest";
import type { PlacementsOfBlock } from "./block-placements";
import {
  baseKeyOfBlock,
  blockBrickKey,
  blockBricksOf,
  blockCardId,
  blockCards,
  blockInputOf,
  blockInputOfBrick,
  blockKeyByRowId,
  blockKeyOf,
  blockKeyOfCard,
  blockLessonsLeft,
  blockListAfter,
  blockMemberId,
  blockSummaryOf,
  keysOfBlockRows,
  patchBoardBlock,
  rowsOfBlock,
  summaryWithBlocks,
  verdictLines,
  verdictsOfAnswerRow,
  visibleBlocks,
  windowOfBlock,
} from "./placement-block-rows";
import { NO_FILTERS, type BoardBlock, type BoardBlockRow, type BoardPart, type BoardPost, type PlacementBoard } from "./placement-board";

/**
 * A lesson of a block is named by what it is, the PUT replaces the block's whole list, and what is left is the block's own count.
 * These hold the three things that go wrong at once if any is wrong: a card named by a row id points at nothing after the save that
 * moved it, a rebuilt list that drops a lesson's rooms gives the posts the engine's choice without a word, and a count made from
 * the posts' `left` gives a brick for every post of the block, or none.
 */

const part = (over: Partial<BoardPart> = {}): BoardPart => ({ teacherId: "t-ty", minutes: 60, count: 2, locked: 0, placed: 0, left: 2, cannotPlace: null, ...over });

const member = (id: string, over: Partial<BoardPost> = {}): BoardPost => ({
  id,
  studentGroupId: `g-${id}`,
  subjectId: `s-${id}`,
  teacherId: `t-${id}`,
  coTeacherId: null,
  recurrence: "ALL_WEEKS",
  startDate: null,
  endDate: null,
  cannotPlace: "BLOCK",
  parts: [part({ teacherId: `t-${id}` })],
  rowsKey: "e3b0c44298fc1c14",
  ...over,
});

let ids = 0;
const row = (over: Partial<BoardBlockRow> = {}): BoardBlockRow => ({
  id: `row-${++ids}`,
  dayOfWeek: 2,
  startTime: "10:00",
  endTime: "11:00",
  minutes: 60,
  recurrence: "ALL_WEEKS",
  rooms: [],
  changedAt: "2026-11-13T08:00:00.000Z",
  verdicts: [
    { requirementId: "ty", ok: true },
    { requirementId: "fr", ok: true },
    { requirementId: "sp", ok: true },
  ],
  ...over,
});

const block = (over: Partial<BoardBlock> = {}): BoardBlock => ({
  id: "b-sv",
  name: "Språkval åk 7",
  memberIds: ["fr", "sp", "ty"],
  lengths: [60, 60],
  recurrence: "ALL_WEEKS",
  followsBlockId: null,
  cannotPlace: null,
  rows: [],
  rowsKey: "k0",
  ...over,
});

const MEMBERS = [member("fr"), member("sp"), member("ty")];

const board = (over: Partial<PlacementBoard> = {}): PlacementBoard => ({
  academicYearId: "y1",
  placements: [],
  posts: MEMBERS,
  kept: [],
  meals: [],
  blocks: [block()],
  ...over,
});

describe("a lesson's key", () => {
  it("is the block, the length, the day, the start and the weeks, and no id", () => {
    expect(blockKeyOf("b-sv", row({ id: "x" }))).toBe("b-sv|60|2|10:00|ALL_WEEKS");
    expect(blockKeyOf("b-sv", row({ id: "x" }))).toBe(blockKeyOf("b-sv", row({ id: "y" })));
  });

  it.each<[string, Partial<BoardBlockRow>]>([
    ["the length", { minutes: 40 }],
    ["the day", { dayOfWeek: 3 }],
    ["the start", { startTime: "10:05" }],
    ["the weeks", { recurrence: "ODD_WEEKS" }],
  ])("changes with %s", (_what, over) => {
    expect(blockKeyOf("b-sv", row(over))).not.toBe(blockKeyOf("b-sv", row()));
  });

  it("changes with the block, and is not changed by the rooms the posts chose, which a lesson keeps as it changes rooms", () => {
    expect(blockKeyOf("b-no", row())).not.toBe(blockKeyOf("b-sv", row()));
    expect(blockKeyOf("b-sv", row({ rooms: [{ requirementId: "ty", roomId: "r-1", roomName: "A1" }] }))).toBe(blockKeyOf("b-sv", row()));
  });

  it("numbers two lessons that are the same one lesson twice, in the list's own order", () => {
    expect(keysOfBlockRows("b-sv", [row(), row(), row({ dayOfWeek: 3 }), row()])).toEqual([
      "b-sv|60|2|10:00|ALL_WEEKS",
      "b-sv|60|2|10:00|ALL_WEEKS#2",
      "b-sv|60|3|10:00|ALL_WEEKS",
      "b-sv|60|2|10:00|ALL_WEEKS#3",
    ]);
  });

  it("is the same after a save that gives every lesson a new id", () => {
    const before = [row({ id: "a" }), row({ id: "b", dayOfWeek: 4 })];
    const after = [row({ id: "c" }), row({ id: "d", dayOfWeek: 4 })];
    expect(keysOfBlockRows("b-sv", after)).toEqual(keysOfBlockRows("b-sv", before));
  });

  it("is made over every block of the board by row id, so that a filter changes none", () => {
    const keys = blockKeyByRowId([block({ rows: [row({ id: "r1" }), row({ id: "r2" })] }), block({ id: "b-no", rows: [row({ id: "r3" })] })]);
    expect([...keys]).toEqual([
      ["r1", "b-sv|60|2|10:00|ALL_WEEKS"],
      ["r2", "b-sv|60|2|10:00|ALL_WEEKS#2"],
      ["r3", "b-no|60|2|10:00|ALL_WEEKS"],
    ]);
  });

  it("names a card `blockplacement:` and a brick `block:`, which no other card or brick is named, and a card gives its key back", () => {
    expect(blockCardId("b-sv|60|2|10:00|ALL_WEEKS")).toBe("blockplacement:b-sv|60|2|10:00|ALL_WEEKS");
    expect(blockKeyOfCard("blockplacement:b-sv|60|2|10:00|ALL_WEEKS#2")).toBe("b-sv|60|2|10:00|ALL_WEEKS#2");
    expect(blockKeyOfCard("placement:x")).toBeNull();
    expect(blockKeyOfCard("kept:blockplacement:x")).toBeNull();
    expect(blockBrickKey("b-sv", 60, 2)).toBe("block:b-sv|60#2");
    expect(blockMemberId("b-sv|60|2|10:00|ALL_WEEKS", "ty")).toBe("blockplacement:b-sv|60|2|10:00|ALL_WEEKS:ty");
  });
});

describe("the bricks", () => {
  it("are the block's lengths less its lessons, one brick per lesson left of each length", () => {
    const bricks = blockBricksOf([block({ lengths: [80, 40, 40], rows: [row({ minutes: 40 })] })]);
    expect(bricks.map((brick) => [brick.key, brick.minutes])).toEqual([
      ["block:b-sv|80#1", 80],
      ["block:b-sv|40#1", 40],
    ]);
  });

  it("count a lesson of a length against that length only, so a lesson of 80 does not use up one of 40", () => {
    const bricks = blockBricksOf([block({ lengths: [80, 40], rows: [row({ minutes: 80 })] })]);
    expect(bricks.map((brick) => brick.key)).toEqual(["block:b-sv|40#1"]);
  });

  it("are none for a block whose lessons are all laid", () => {
    expect(blockBricksOf([block({ rows: [row(), row({ dayOfWeek: 3 })] })])).toEqual([]);
  });

  it("are none for a block that cannot be placed, whichever the reason", () => {
    for (const cannotPlace of ["FOLLOWER", "EMPTY", "SHARES"] as const) expect(blockBricksOf([block({ cannotPlace })])).toEqual([]);
  });

  it("are counted from the block's own lengths and not from its posts, which have `cannotPlace: BLOCK` and a left each", () => {
    // Three posts with two lessons left each: six rows' worth for Generera, two bricks for the reader.
    expect(blockBricksOf([block()])).toHaveLength(2);
    expect(blockLessonsLeft(block())).toBe(2);
  });

  it("are one group per block, each brick unique inside it", () => {
    const bricks = blockBricksOf([block(), block({ id: "b-ma", lengths: [60] })]);
    expect(new Set(bricks.map((brick) => brick.key)).size).toBe(bricks.length);
    expect(bricks.map((brick) => brick.blockId)).toEqual(["b-sv", "b-sv", "b-ma"]);
  });

  it("make the lesson the PUT takes, with the rooms the posts chose and the engine's choice for the rest", () => {
    const [brick] = blockBricksOf([block()]);
    expect(blockInputOfBrick(brick!, { dayOfWeek: 3, startMinutes: 9 * 60 + 5 }, [{ requirementId: "ty", roomId: "r-1" }])).toEqual({
      dayOfWeek: 3,
      startTime: "09:05",
      minutes: 60,
      rooms: [{ requirementId: "ty", roomId: "r-1" }],
    });
    expect(blockInputOfBrick(brick!, { dayOfWeek: 3, startMinutes: 540 }, []).rooms).toEqual([]);
  });
});

describe("the list after a change", () => {
  const rooms = [
    { requirementId: "fr", roomId: "r-fr", roomName: "Franska" },
    { requirementId: "ty", roomId: "r-ty", roomName: "Tyska" },
  ];
  const lessons = [row({ id: "a", dayOfWeek: 2, rooms }), row({ id: "b", dayOfWeek: 4, startTime: "13:00", endTime: "14:00" })];

  it("takes a stored lesson back as it is, with its rooms", () => {
    expect(blockInputOf(lessons[0]!)).toEqual({
      dayOfWeek: 2,
      startTime: "10:00",
      minutes: 60,
      rooms: [
        { requirementId: "fr", roomId: "r-fr" },
        { requirementId: "ty", roomId: "r-ty" },
      ],
    });
  });

  it("moves one lesson, and every other lesson goes back as it is, rooms and all", () => {
    const list = blockListAfter("b-sv", lessons, { kind: "move", key: keysOfBlockRows("b-sv", lessons)[1]!, to: { dayOfWeek: 5, startMinutes: 8 * 60 + 15 } })!;
    expect(list).toEqual([blockInputOf(lessons[0]!), { dayOfWeek: 5, startTime: "08:15", minutes: 60, rooms: [] }]);
  });

  it("keeps the rooms of the lesson that is moved unless it is given others (a room does not follow the week's filter, and is not lost by a drag)", () => {
    const key = keysOfBlockRows("b-sv", lessons)[0]!;
    const kept = blockListAfter("b-sv", lessons, { kind: "move", key, to: { dayOfWeek: 3, startMinutes: 600 } })!;
    expect(kept[0]!.rooms).toEqual([
      { requirementId: "fr", roomId: "r-fr" },
      { requirementId: "ty", roomId: "r-ty" },
    ]);
    const changed = blockListAfter("b-sv", lessons, { kind: "move", key, to: { dayOfWeek: 3, startMinutes: 600 }, rooms: [{ requirementId: "sp", roomId: "r-sp" }] })!;
    expect(changed[0]!.rooms).toEqual([{ requirementId: "sp", roomId: "r-sp" }]);
    const none = blockListAfter("b-sv", lessons, { kind: "move", key, to: { dayOfWeek: 3, startMinutes: 600 }, rooms: [] })!;
    expect(none[0]!.rooms).toEqual([]);
  });

  it("adds a lesson last, with the others as they are", () => {
    const input = { dayOfWeek: 1, startTime: "08:00", minutes: 60, rooms: [] };
    expect(blockListAfter("b-sv", lessons, { kind: "add", input })).toEqual([blockInputOf(lessons[0]!), blockInputOf(lessons[1]!), input]);
  });

  it("removes one lesson, and the other keeps its rooms", () => {
    const list = blockListAfter("b-sv", lessons, { kind: "remove", key: keysOfBlockRows("b-sv", lessons)[1]! })!;
    expect(list).toEqual([blockInputOf(lessons[0]!)]);
    expect(list[0]!.rooms).toHaveLength(2);
  });

  it("takes the one named lesson of two that are the same, and not the other", () => {
    const same = [row({ id: "a", rooms }), row({ id: "b" })];
    const keys = keysOfBlockRows("b-sv", same);
    expect(blockListAfter("b-sv", same, { kind: "remove", key: keys[0]! })).toEqual([blockInputOf(same[1]!)]);
    expect(blockListAfter("b-sv", same, { kind: "remove", key: keys[1]! })).toEqual([blockInputOf(same[0]!)]);
  });

  it("is null for a lesson the list no longer has: the week moved under the reader", () => {
    expect(blockListAfter("b-sv", lessons, { kind: "remove", key: "b-sv|60|1|08:00|ALL_WEEKS" })).toBeNull();
    expect(blockListAfter("b-sv", lessons, { kind: "move", key: "gone", to: { dayOfWeek: 1, startMinutes: 480 } })).toBeNull();
  });

  it("does not change the lists it was given", () => {
    const before = structuredClone(lessons);
    blockListAfter("b-sv", lessons, { kind: "move", key: keysOfBlockRows("b-sv", lessons)[0]!, to: { dayOfWeek: 5, startMinutes: 600 }, rooms: [] });
    expect(lessons).toEqual(before);
  });
});

describe("reading the board", () => {
  it("gives the block's lessons and key, and none for a block it does not know", () => {
    const lessons = [row()];
    const b = board({ blocks: [block({ rows: lessons, rowsKey: "key-9" })] });
    expect(rowsOfBlock(b, "b-sv")).toBe(lessons);
    expect(baseKeyOfBlock(b, "b-sv")).toBe("key-9");
    expect(rowsOfBlock(b, "nope")).toEqual([]);
    expect(baseKeyOfBlock(b, "nope")).toBeUndefined();
  });
});

describe("what an answer is read as (the indexes)", () => {
  // The gateway answers in (day, start, id) order. The list that was SENT had the Thursday lesson first.
  const answer: PlacementsOfBlock = {
    placements: [
      { id: "n1", blockId: "b-sv", dayOfWeek: 2, startTime: "08:00", endTime: "09:00", minutes: 60, recurrence: "ALL_WEEKS", rooms: [] },
      { id: "n2", blockId: "b-sv", dayOfWeek: 4, startTime: "10:00", endTime: "11:00", minutes: 60, recurrence: "ALL_WEEKS", rooms: [{ requirementId: "ty", roomId: "r-ty", roomName: "Tyska" }] },
    ],
    verdicts: [
      { index: 0, requirementId: "fr", ok: true },
      { index: 0, requirementId: "ty", ok: true },
      { index: 1, requirementId: "fr", ok: false, reason: "TEACHER", params: { day: 4 } },
      { index: 1, requirementId: "ty", ok: true },
    ],
    rowsKey: "key-2",
    lengths: [60, 60],
  };

  it("reads a verdict's index as a place in the answer's list", () => {
    expect(verdictsOfAnswerRow(answer, 1).map((verdict) => [verdict.requirementId, verdict.ok])).toEqual([
      ["fr", false],
      ["ty", true],
    ]);
    expect(verdictsOfAnswerRow(answer, 0).every((verdict) => verdict.ok)).toBe(true);
  });

  it("puts each verdict on the lesson of the same place in the answer, not on the lesson that was sent in that place, when the cache takes the answer", () => {
    const sent = [blockInputOf(row({ dayOfWeek: 4, startTime: "10:00" })), blockInputOf(row({ dayOfWeek: 2, startTime: "08:00" }))];
    expect(sent[0]!.dayOfWeek).toBe(4);
    const patched = patchBoardBlock(board(), "b-sv", answer, "2026-11-16T09:00:00.000Z");
    const rows = rowsOfBlock(patched, "b-sv");
    expect(rows.map((entry) => [entry.id, entry.dayOfWeek, entry.verdicts.every((verdict) => verdict.ok)])).toEqual([
      ["n1", 2, true],
      ["n2", 4, false],
    ]);
    expect(rows[1]!.verdicts.find((verdict) => !verdict.ok)).toEqual({ requirementId: "fr", ok: false, reason: "TEACHER", params: { day: 4 } });
  });
});

describe("the board after a write", () => {
  const answerOf = (days: number[], rowsKey: string, minutes = 60): PlacementsOfBlock => ({
    placements: days.map((dayOfWeek, index) => ({
      id: `n${index}`,
      blockId: "b-sv",
      dayOfWeek,
      startTime: "10:00",
      endTime: "11:00",
      minutes,
      recurrence: "ALL_WEEKS" as const,
      rooms: [],
    })),
    verdicts: days.flatMap((_, index) => ["fr", "sp", "ty"].map((requirementId) => ({ index, requirementId, ok: true }))),
    rowsKey,
    lengths: [60, 60],
  });

  it("has the block's lessons and key replaced by the answer's, and the lessons stamped when they were saved", () => {
    const patched = patchBoardBlock(board(), "b-sv", answerOf([2], "k1"), "2026-11-16T09:00:00.000Z");
    expect(patched.blocks[0]!.rowsKey).toBe("k1");
    expect(patched.blocks[0]!.rows.map((entry) => [entry.id, entry.changedAt])).toEqual([["n0", "2026-11-16T09:00:00.000Z"]]);
  });

  it("moves every member's placed and left by the lessons it laid, so that the brick is gone at once", () => {
    const patched = patchBoardBlock(board(), "b-sv", answerOf([2], "k1"), "2026-11-16T09:00:00.000Z");
    for (const post of patched.posts) expect(post.parts.map((entry) => [entry.placed, entry.left])).toEqual([[1, 1]]);
    expect(blockBricksOf(patched.blocks)).toHaveLength(1);
  });

  it("gives the lessons back as the lessons are taken away, and never goes below nothing", () => {
    const placed = patchBoardBlock(board(), "b-sv", answerOf([2, 3], "k1"), "2026-11-16T09:00:00.000Z");
    const removed = patchBoardBlock(placed, "b-sv", answerOf([2], "k2"), "2026-11-16T09:01:00.000Z");
    expect(removed.posts[0]!.parts.map((entry) => [entry.placed, entry.left])).toEqual([[1, 1]]);
    const gone = patchBoardBlock(removed, "b-sv", answerOf([], "k3"), "2026-11-16T09:02:00.000Z");
    expect(gone.posts[0]!.parts.map((entry) => [entry.placed, entry.left])).toEqual([[0, 2]]);
    const below = patchBoardBlock(gone, "b-sv", answerOf([], "k4"), "2026-11-16T09:03:00.000Z");
    expect(below.posts[0]!.parts[0]!.placed).toBe(0);
  });

  it("moves the part of the lesson's own length only", () => {
    const mixed = board({ posts: MEMBERS.map((post) => ({ ...post, parts: [part({ minutes: 80, count: 1, left: 1, teacherId: post.teacherId }), part({ minutes: 40, count: 2, left: 2, teacherId: post.teacherId })] })), blocks: [block({ lengths: [80, 40, 40] })] });
    const patched = patchBoardBlock(mixed, "b-sv", { ...answerOf([2], "k1", 40), lengths: [80, 40, 40] }, "2026-11-16T09:00:00.000Z");
    expect(patched.posts[0]!.parts.map((entry) => [entry.minutes, entry.placed, entry.left])).toEqual([
      [80, 0, 1],
      [40, 1, 1],
    ]);
  });

  it("leaves the posts that are not in the block, and the other blocks, as they were", () => {
    const other = member("ma", { cannotPlace: null });
    const b = board({ posts: [...MEMBERS, other], blocks: [block(), block({ id: "b-no", memberIds: ["ma"], rowsKey: "k-no" })] });
    const patched = patchBoardBlock(b, "b-sv", answerOf([2], "k1"), "2026-11-16T09:00:00.000Z");
    expect(patched.posts.find((post) => post.id === "ma")).toBe(other);
    expect(patched.blocks[1]).toBe(b.blocks[1]);
  });

  it("is the board itself when the block is not in it", () => {
    const b = board();
    expect(patchBoardBlock(b, "nope", answerOf([2], "k1"), "now")).toBe(b);
  });
});

describe("the filters", () => {
  const withRooms = (roomIds: string[]) => row({ rooms: roomIds.map((roomId) => ({ requirementId: "ty", roomId, roomName: roomId })) });
  const b = board({
    posts: [member("fr"), member("sp", { teacherId: "t-sp-main", coTeacherId: "t-co" }), member("ty")],
    blocks: [block({ rows: [withRooms(["r-1"]), withRooms([]), withRooms(["r-2"])] })],
  });

  it("shows every block when nothing is picked", () => {
    expect(visibleBlocks(b, NO_FILTERS).map((entry) => entry.id)).toEqual(["b-sv"]);
  });

  it("shows a block for the class of ANY of its posts, and for none that is not one of them", () => {
    expect(visibleBlocks(b, { ...NO_FILTERS, groups: ["g-sp"] })).toHaveLength(1);
    expect(visibleBlocks(b, { ...NO_FILTERS, groups: ["g-ma"] })).toHaveLength(0);
  });

  it("shows a block for the teacher, the part's teacher or the medlärare of any of its posts", () => {
    expect(visibleBlocks(b, { ...NO_FILTERS, teachers: ["t-ty"] })).toHaveLength(1);
    expect(visibleBlocks(b, { ...NO_FILTERS, teachers: ["t-co"] })).toHaveLength(1);
    expect(visibleBlocks(b, { ...NO_FILTERS, teachers: ["t-nobody"] })).toHaveLength(0);
  });

  it("shows the lessons that stand in a picked room, none for a block that has none there, and none for a lesson with no room", () => {
    const shown = visibleBlocks(b, { ...NO_FILTERS, rooms: ["r-1"] });
    expect(shown).toHaveLength(1);
    expect(shown[0]!.rows).toHaveLength(1);
    expect(shown[0]!.rows[0]!.rooms[0]!.roomId).toBe("r-1");
    expect(visibleBlocks(b, { ...NO_FILTERS, rooms: ["r-9"] })).toEqual([]);
  });

  it("asks both the class and the teacher", () => {
    expect(visibleBlocks(b, { ...NO_FILTERS, groups: ["g-fr"], teachers: ["t-nobody"] })).toEqual([]);
    expect(visibleBlocks(b, { ...NO_FILTERS, groups: ["g-fr"], teachers: ["t-ty"] })).toHaveLength(1);
  });

  it("does not change the board it was given", () => {
    const before = structuredClone(b);
    visibleBlocks(b, { ...NO_FILTERS, rooms: ["r-1"] });
    expect(b).toEqual(before);
  });
});

describe("the figures", () => {
  const failing = (over: Partial<BoardBlockRow> = {}) =>
    row({
      verdicts: [
        { requirementId: "fr", ok: false, reason: "ROOM" },
        { requirementId: "sp", ok: false, reason: "ROOM" },
        { requirementId: "ty", ok: true },
      ],
      ...over,
    });

  it("counts a lesson that fails for two posts once", () => {
    expect(blockSummaryOf([block({ rows: [failing(), row()] })])).toEqual({ rows: 2, failing: 1, left: 0 });
  });

  it("counts the lessons left once for the block, whatever the number of its posts, and none for a block that follows another", () => {
    expect(blockSummaryOf([block({ rows: [row()] })]).left).toBe(1);
    expect(blockSummaryOf([block({ cannotPlace: "FOLLOWER", rows: [] })]).left).toBe(0);
    // A block that cannot be placed for another reason still has lessons for Generera to lay.
    expect(blockSummaryOf([block({ cannotPlace: "SHARES", rows: [] })]).left).toBe(2);
  });

  it("is the other posts' figures plus the blocks', and leaves out the posts of a block, whose left counts every lesson once each", () => {
    const own = member("ma", { cannotPlace: null, parts: [part({ left: 3 })] });
    const summary = summaryWithBlocks(board({ posts: [...MEMBERS, own], blocks: [block({ rows: [failing()] })] }));
    // 3 for the ordinary post, 1 for the block's second lesson; the three members' 2 + 2 + 2 are not added.
    expect(summary).toEqual({ rows: 1, failing: 1, left: 4 });
  });

  it("counts a board of an older gateway with no block as before", () => {
    expect(summaryWithBlocks(board({ posts: [member("ma", { cannotPlace: null, parts: [part({ left: 2 })] })], blocks: [] }))).toEqual({ rows: 0, failing: 0, left: 2 });
  });
});

describe("the sentences of a lesson", () => {
  const sentence = (verdict: { reason?: string }) => `sentence ${verdict.reason}`;

  it("says the posts that fail for one sentence together, in the block's order, and a different sentence on its own line", () => {
    const lines = verdictLines(
      [
        { requirementId: "ty", ok: false, reason: "ROOM" },
        { requirementId: "fr", ok: false, reason: "ROOM" },
        { requirementId: "sp", ok: false, reason: "TEACHER" },
      ],
      ["fr", "sp", "ty"],
      sentence,
    );
    expect(lines).toEqual([
      { requirementIds: ["fr", "ty"], text: "sentence ROOM" },
      { requirementIds: ["sp"], text: "sentence TEACHER" },
    ]);
  });

  it("leaves out the posts that hold and puts a post that is not in the block last", () => {
    const lines = verdictLines(
      [
        { requirementId: "gone", ok: false, reason: "GROUP" },
        { requirementId: "fr", ok: true },
        { requirementId: "ty", ok: false, reason: "GROUP" },
      ],
      ["fr", "ty"],
      sentence,
    );
    expect(lines).toEqual([{ requirementIds: ["ty", "gone"], text: "sentence GROUP" }]);
  });

  it("is none for a lesson that holds", () => {
    expect(verdictLines([{ requirementId: "fr", ok: true }], ["fr"], sentence)).toEqual([]);
  });
});

describe("the cards", () => {
  const names = {
    subject: (id: string) => ({ name: id.replace("s-", "").toUpperCase(), color: null }),
    weeks: (lesson: { recurrence: string; startDate: string | null; endDate: string | null }) => (lesson.recurrence === "ODD_WEEKS" ? "udda" : lesson.startDate ? "period" : null),
    color: (id: string) => `color:${id}`,
  };
  const text = { rooms: (chosen: number, total: number) => (chosen === 0 ? "Motorn väljer sal" : `Sal på ${chosen} av ${total}`) };
  const posts = new Map(MEMBERS.map((post) => [post.id, post]));

  it("is one card per lesson, named by the lesson, with the block's name, the posts' subjects, the rooms as a count and a colour of the block's own", () => {
    const rows = [row({ id: "r1", rooms: [{ requirementId: "ty", roomId: "r-1", roomName: "A1" }] }), row({ id: "r2", dayOfWeek: 4 })];
    const b = block({ rows });
    const cards = blockCards([b], posts, names, text, blockKeyByRowId([b]));
    expect(cards.map((card) => card.id)).toEqual(["blockplacement:b-sv|60|2|10:00|ALL_WEEKS", "blockplacement:b-sv|60|4|10:00|ALL_WEEKS"]);
    expect(cards[0]).toMatchObject({ title: "Språkval åk 7", subtitle: "FR · SP · TY", room: "Sal på 1 av 3", color: "color:b-sv", dayOfWeek: 2, startMinutes: 600, endMinutes: 660, conflicted: false });
    expect(cards[1]!.room).toBe("Motorn väljer sal");
  });

  it("rings a lesson that does not hold for any of its posts, and says the weeks the lesson runs", () => {
    const b = block({ rows: [row({ id: "r1", recurrence: "ODD_WEEKS", verdicts: [{ requirementId: "fr", ok: false, reason: "ROOM" }] })] });
    const [card] = blockCards([b], posts, names, text, blockKeyByRowId([b]));
    expect(card).toMatchObject({ conflicted: true, recurrenceNote: "udda" });
  });

  it("is named by the key over all the block's lessons, so that a lesson keeps its card when a filter hides another", () => {
    const all = block({ rows: [row({ id: "r1" }), row({ id: "r2" })] });
    const keys = blockKeyByRowId([all]);
    const shown = { ...all, rows: [all.rows[1]!] };
    expect(blockCards([shown], posts, names, text, keys)[0]!.id).toBe("blockplacement:b-sv|60|2|10:00|ALL_WEEKS#2");
  });

  it("says the window the posts share and none when they differ", () => {
    expect(windowOfBlock([{ startDate: "2026-08-17", endDate: "2026-12-18" }, { startDate: "2026-08-17", endDate: "2026-12-18" }])).toEqual({ startDate: "2026-08-17", endDate: "2026-12-18" });
    expect(windowOfBlock([{ startDate: "2026-08-17", endDate: null }, { startDate: null, endDate: null }])).toEqual({ startDate: null, endDate: null });
    expect(windowOfBlock([])).toEqual({ startDate: null, endDate: null });
    const term = MEMBERS.map((post) => ({ ...post, startDate: "2026-08-17", endDate: "2026-12-18" }));
    const b = block({ rows: [row({ id: "r1" })] });
    const [card] = blockCards([b], new Map(term.map((post) => [post.id, post])), names, text, blockKeyByRowId([b]));
    expect(card!.recurrenceNote).toBe("period");
  });

  it("draws a card for a post the board no longer has with the subjects that remain", () => {
    const b = block({ rows: [row({ id: "r1" })] });
    const [card] = blockCards([b], new Map([["fr", MEMBERS[0]!]]), names, text, blockKeyByRowId([b]));
    expect(card!.subtitle).toBe("FR");
  });
});
