import { describe, expect, it } from "vitest";
import type { BoardPart, BoardPlacement, BoardPost } from "./placement-board";
import {
  baseKeyOf,
  bricksOf,
  inputOf,
  inputOfBrick,
  keyByRowId,
  keysOfRows,
  listAfter,
  placementKeyOf,
  removalOf,
  rowsOfPost,
  sharesLessons,
} from "./placement-rows";

/**
 * A lesson on the week is named by what it is, and the PUT replaces the post's whole list: these hold the two
 * things that go wrong at once if either is wrong. A card named by a row id points at nothing after the save that
 * moved it, and a rebuilt list that drops a row's teacher gives a shared post NO_TEACHER.
 */

const part = (over: Partial<BoardPart> = {}): BoardPart => ({ teacherId: "anna", minutes: 60, count: 2, locked: 0, placed: 0, left: 2, cannotPlace: null, ...over });

const post = (over: Partial<BoardPost> = {}): BoardPost => ({
  id: "post-1",
  studentGroupId: "g-7a",
  subjectId: "s-ma",
  teacherId: "anna",
  coTeacherId: null,
  recurrence: "ALL_WEEKS",
  startDate: null,
  endDate: null,
  cannotPlace: null,
  parts: [part()],
  rowsKey: "e3b0c44298fc1c14",
  ...over,
});

let ids = 0;
const row = (over: Partial<BoardPlacement> = {}): BoardPlacement => ({
  id: `row-${++ids}`,
  requirementId: "post-1",
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

describe("a lesson's key", () => {
  it("is the post, the teacher, the length, the day, the start and the weeks, and no id", () => {
    expect(placementKeyOf(row({ id: "x" }))).toBe("post-1||60|2|10:00|ALL_WEEKS");
    expect(placementKeyOf(row({ id: "y", teacherId: "bo" }))).toBe("post-1|bo|60|2|10:00|ALL_WEEKS");
    expect(placementKeyOf(row({ id: "x" }))).toBe(placementKeyOf(row({ id: "y" })));
  });

  it.each<[string, Partial<BoardPlacement>]>([
    ["the post", { requirementId: "post-2" }],
    ["the teacher", { teacherId: "bo" }],
    ["the length", { minutes: 40 }],
    ["the day", { dayOfWeek: 3 }],
    ["the start", { startTime: "10:05" }],
    ["the weeks", { recurrence: "ODD_WEEKS" }],
  ])("differs when %s differs", (_name, over) => {
    expect(placementKeyOf(row(over))).not.toBe(placementKeyOf(row()));
  });

  it("does not move with the room, which a lesson can have changed without being another lesson", () => {
    expect(placementKeyOf(row({ roomId: "r-b3" }))).toBe(placementKeyOf(row()));
  });

  it("numbers rows that are the same lesson twice, and only those, so that each key is unique in a list", () => {
    const rows = [row(), row({ dayOfWeek: 4 }), row(), row()];
    expect(keysOfRows(rows)).toEqual(["post-1||60|2|10:00|ALL_WEEKS", "post-1||60|4|10:00|ALL_WEEKS", "post-1||60|2|10:00|ALL_WEEKS#2", "post-1||60|2|10:00|ALL_WEEKS#3"]);
    expect(new Set(keysOfRows(rows)).size).toBe(4);
  });

  it("gives the same rows saved again, with new ids, the same keys", () => {
    const before = [row({ id: "a" }), row({ id: "b", dayOfWeek: 4 })];
    const after = [row({ id: "c" }), row({ id: "d", dayOfWeek: 4 })];
    expect(keysOfRows(after)).toEqual(keysOfRows(before));
    expect([...keyByRowId(before).values()]).toEqual([...keyByRowId(after).values()]);
  });
});

describe("a row as the PUT takes it", () => {
  it("keeps its room, its weeks and its minutes, and its teacher where it has one", () => {
    expect(inputOf(row({ roomId: "r-b3", recurrence: "ODD_WEEKS", minutes: 45, teacherId: "bo" }))).toEqual({
      dayOfWeek: 2,
      startTime: "10:00",
      minutes: 45,
      roomId: "r-b3",
      recurrence: "ODD_WEEKS",
      teacherId: "bo",
    });
  });

  it("leaves the teacher out for a post that shares nothing, where the stored row has none, and keeps no room as null", () => {
    const input = inputOf(row({ roomId: null, roomName: null }));
    expect(input).toEqual({ dayOfWeek: 2, startTime: "10:00", minutes: 60, roomId: null, recurrence: "ALL_WEEKS" });
    expect("teacherId" in input).toBe(false);
  });
});

describe("the post's whole list with one change", () => {
  const anna = row({ id: "r1", teacherId: "anna", dayOfWeek: 1 });
  const bo = row({ id: "r2", teacherId: "bo", dayOfWeek: 3, startTime: "13:00", endTime: "14:00", roomId: null, roomName: null });
  const odd = row({ id: "r3", teacherId: "anna", dayOfWeek: 5, recurrence: "ODD_WEEKS", minutes: 40 });
  const list = [anna, bo, odd];

  it("moves one row and sends every other as it is: teacher, room and weeks unchanged (a dropped teacher is NO_TEACHER)", () => {
    const after = listAfter(list, { kind: "move", key: keysOfRows(list)[0]!, to: { dayOfWeek: 2, startMinutes: 9 * 60 + 15 } })!;
    expect(after).toEqual([
      { dayOfWeek: 2, startTime: "09:15", minutes: 60, roomId: "r-a12", recurrence: "ALL_WEEKS", teacherId: "anna" },
      { dayOfWeek: 3, startTime: "13:00", minutes: 60, roomId: null, recurrence: "ALL_WEEKS", teacherId: "bo" },
      { dayOfWeek: 5, startTime: "10:00", minutes: 40, roomId: "r-a12", recurrence: "ODD_WEEKS", teacherId: "anna" },
    ]);
  });

  it("moves a row on a post with odd weeks without changing its weeks", () => {
    const after = listAfter(list, { kind: "move", key: keysOfRows(list)[2]!, to: { dayOfWeek: 4, startMinutes: 8 * 60 } })!;
    expect(after[2]).toMatchObject({ dayOfWeek: 4, startTime: "08:00", recurrence: "ODD_WEEKS", minutes: 40 });
    expect(after.slice(0, 2)).toEqual(list.slice(0, 2).map(inputOf));
  });

  it("changes the room with the move when one is given, and none (the engine chooses) when it is null; left out, it stays", () => {
    const key = keysOfRows(list)[0]!;
    const to = { dayOfWeek: 1, startMinutes: 600 };
    expect(listAfter(list, { kind: "move", key, to })![0]!.roomId).toBe("r-a12");
    expect(listAfter(list, { kind: "move", key, to, roomId: "r-b3" })![0]!.roomId).toBe("r-b3");
    expect(listAfter(list, { kind: "move", key, to, roomId: null })![0]!.roomId).toBeNull();
  });

  it("adds a row at the end and removes the rows named", () => {
    const input = { dayOfWeek: 4, startTime: "08:00", minutes: 60, roomId: null, recurrence: "ALL_WEEKS" as const };
    expect(listAfter(list, { kind: "add", input })!.at(-1)).toEqual(input);
    expect(listAfter(list, { kind: "add", input })).toHaveLength(4);
    const keys = keysOfRows(list);
    expect(listAfter(list, { kind: "remove", keys: [keys[0]!, keys[2]!] })).toEqual([inputOf(bo)]);
  });

  it("takes the right one of two rows that are the same lesson", () => {
    const twins = [row({ id: "t1" }), row({ id: "t2" })];
    const keys = keysOfRows(twins);
    const after = listAfter(twins, { kind: "move", key: keys[1]!, to: { dayOfWeek: 4, startMinutes: 600 } })!;
    expect(after.map((entry) => entry.dayOfWeek)).toEqual([2, 4]);
  });

  it("answers null for a lesson the list no longer has (the week moved under the reader), and changes nothing", () => {
    expect(listAfter(list, { kind: "move", key: "post-1||60|5|09:00|ALL_WEEKS", to: { dayOfWeek: 1, startMinutes: 600 } })).toBeNull();
    expect(listAfter(list, { kind: "remove", keys: ["nope"] })).toBeNull();
  });
});

describe("removing a half of a pair", () => {
  const oddHalf = row({ recurrence: "ODD_WEEKS", dayOfWeek: 1 });
  const evenHalf = row({ recurrence: "EVEN_WEEKS", dayOfWeek: 3 });
  const other = row({ dayOfWeek: 5 });
  const rows = [oddHalf, evenHalf, other];
  const keys = keysOfRows(rows);

  it("takes the other half too, because the database refuses a lone half", () => {
    expect(removalOf(rows, post(), keys[0]!)).toEqual([keys[0], keys[1]]);
    expect(removalOf(rows, post(), keys[1]!)).toEqual([keys[1], keys[0]]);
  });

  it("takes a whole row alone, and a row of a post that runs odd weeks alone", () => {
    expect(removalOf(rows, post(), keys[2]!)).toEqual([keys[2]]);
    expect(removalOf([oddHalf, row({ recurrence: "ODD_WEEKS", dayOfWeek: 4 })], post({ recurrence: "ODD_WEEKS" }), keysOfRows([oddHalf, row({ recurrence: "ODD_WEEKS", dayOfWeek: 4 })])[0]!)).toHaveLength(1);
  });

  it("pairs by teacher and length: a half of Anna's 60 is not paired with Bo's 60 or Anna's 40", () => {
    const mixed = [
      row({ recurrence: "ODD_WEEKS", teacherId: "anna" }),
      row({ recurrence: "EVEN_WEEKS", teacherId: "bo", dayOfWeek: 3 }),
      row({ recurrence: "EVEN_WEEKS", teacherId: "anna", minutes: 40, dayOfWeek: 4 }),
      row({ recurrence: "EVEN_WEEKS", teacherId: "anna", dayOfWeek: 5 }),
    ];
    const mixedKeys = keysOfRows(mixed);
    expect(removalOf(mixed, post(), mixedKeys[0]!)).toEqual([mixedKeys[0], mixedKeys[3]]);
  });

  it("takes a half with no partner alone (a list another writer stored)", () => {
    expect(removalOf([oddHalf], post(), keysOfRows([oddHalf])[0]!)).toHaveLength(1);
  });
});

describe("the bricks: what is left to lay", () => {
  it("is one brick per lesson left, of every part that can be laid, numbered per part", () => {
    const posts = [
      post({ id: "p1", parts: [part({ left: 2 })] }),
      post({ id: "p2", parts: [part({ teacherId: "bo", minutes: 40, left: 1 }), part({ teacherId: "anna", minutes: 40, left: 0 })] }),
    ];
    expect(bricksOf(posts)).toEqual([
      { key: "p1|anna|60#1", postId: "p1", teacherId: "anna", minutes: 60 },
      { key: "p1|anna|60#2", postId: "p1", teacherId: "anna", minutes: 60 },
      { key: "p2|bo|40#1", postId: "p2", teacherId: "bo", minutes: 40 },
    ]);
  });

  it("lays none of a post in a block, nor of a part nobody teaches", () => {
    expect(bricksOf([post({ cannotPlace: "BLOCK", parts: [part({ left: 3 })] })])).toEqual([]);
    expect(bricksOf([post({ parts: [part({ teacherId: null, left: 1, cannotPlace: "NO_TEACHER" }), part({ left: 1 })] })])).toHaveLength(1);
  });

  it("keeps a brick's key while the post still has it: the first of three gone leaves #1 and #2", () => {
    const three = bricksOf([post({ parts: [part({ left: 3 })] })]).map((brick) => brick.key);
    const two = bricksOf([post({ parts: [part({ left: 2 })] })]).map((brick) => brick.key);
    expect(three).toEqual(["post-1|anna|60#1", "post-1|anna|60#2", "post-1|anna|60#3"]);
    expect(two).toEqual(three.slice(0, 2));
  });
});

describe("a brick as a row", () => {
  const brick = { key: "post-1|anna|60#1", postId: "post-1", teacherId: "anna", minutes: 60 };

  it("takes the post's weeks and its own length, and the room given", () => {
    expect(inputOfBrick(brick, post(), { dayOfWeek: 2, startMinutes: 605 }, "r-a12")).toEqual({
      dayOfWeek: 2,
      startTime: "10:05",
      minutes: 60,
      roomId: "r-a12",
      recurrence: "ALL_WEEKS",
    });
    expect(inputOfBrick(brick, post({ recurrence: "EVEN_WEEKS" }), { dayOfWeek: 1, startMinutes: 480 }, null)).toMatchObject({ recurrence: "EVEN_WEEKS", roomId: null });
  });

  it("names the lesson's teacher on a post that shares its lessons, and only there", () => {
    const shared = post({ parts: [part(), part({ teacherId: "bo", count: 1 })] });
    expect(sharesLessons(shared)).toBe(true);
    expect(inputOfBrick({ ...brick, teacherId: "bo" }, shared, { dayOfWeek: 2, startMinutes: 600 }, null)).toMatchObject({ teacherId: "bo" });
    expect(sharesLessons(post())).toBe(false);
    expect("teacherId" in inputOfBrick(brick, post(), { dayOfWeek: 2, startMinutes: 600 }, null)).toBe(false);
  });

  it("knows a shared post whose huvudlärare has none left of it", () => {
    expect(sharesLessons(post({ parts: [part({ teacherId: "bo", count: 2 })] }))).toBe(true);
  });
});

describe("the post's rows and its key", () => {
  const board = {
    placements: [row({ requirementId: "post-1" }), row({ requirementId: "post-2" }), row({ requirementId: "post-1", dayOfWeek: 4 })],
    posts: [post({ rowsKey: "aaaaaaaaaaaaaaaa" }), post({ id: "post-2", rowsKey: "bbbbbbbbbbbbbbbb" })],
  };

  it("reads a post's rows in the board's order, and the key the next write is made on top of", () => {
    expect(rowsOfPost(board, "post-1").map((entry) => entry.dayOfWeek)).toEqual([2, 4]);
    expect(baseKeyOf(board, "post-2")).toBe("bbbbbbbbbbbbbbbb");
    expect(baseKeyOf(board, "post-9")).toBeUndefined();
  });
});
