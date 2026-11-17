import { describe, expect, it } from "vitest";
import type { BoardPart, BoardPlacement, BoardPost } from "./placement-board";
import {
  canBePair,
  heldHalfCard,
  heldHalfCardId,
  heldHalfPlacement,
  pairInputs,
  partKeyOfBrick,
  weeksBeingLaid,
  type HeldHalf,
} from "./placement-pair";
import { bricksOf, keysOfRows, listAfter, removalOf } from "./placement-rows";
import { otherHalf } from "./placement-pair-key";

/**
 * A pair is one lesson in two places, laid half by half. The database refuses a lone half and a half with no room, so the first is
 * held in the page; what is decided about it is here. The posts that share their lessons between teachers are where a pair goes
 * wrong unnoticed: a pair is ONE TEACHER'S (TEACHER_PAIRS), so its two rows must name the same teacher, and a pair of Anna's must
 * not be taken for the other half of Bo's.
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
/** Two teachers share the post: Anna has two lessons of 60 minutes, Bo has two too. */
const shared = (): BoardPost => post({ parts: [part({ teacherId: "anna" }), part({ teacherId: "bo" })] });

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

const held = (over: Partial<HeldHalf> = {}): HeldHalf => ({
  partKey: "post-1|anna|60",
  postId: "post-1",
  teacherId: null,
  minutes: 60,
  recurrence: "ODD_WEEKS",
  dayOfWeek: 2,
  startMinutes: 10 * 60,
  roomId: "r-a12",
  ...over,
});

describe("what a pair is made from", () => {
  it("names the part of a post by its brick's key without the count, so that a brick re-counted after a write is the same part", () => {
    const [first, second] = bricksOf([post()]);
    expect(first!.key).toBe("post-1|anna|60#1");
    expect(second!.key).toBe("post-1|anna|60#2");
    expect(partKeyOfBrick(first!)).toBe("post-1|anna|60");
    expect(partKeyOfBrick(second!)).toBe("post-1|anna|60");
  });

  it("is possible for a post of every week and for no other: an odd post or an even post has no other half", () => {
    expect(canBePair({ recurrence: "ALL_WEEKS", cannotPlace: null })).toBe(true);
    expect(canBePair({ recurrence: "ODD_WEEKS", cannotPlace: null })).toBe(false);
    expect(canBePair({ recurrence: "EVEN_WEEKS", cannotPlace: null })).toBe(false);
    // A post in a block is laid with its block: no pair of its own.
    expect(canBePair({ recurrence: "ALL_WEEKS", cannotPlace: "BLOCK" })).toBe(false);
  });

  it("runs the held half's weeks first, and the other weeks for the lesson that completes it", () => {
    expect(weeksBeingLaid(null, "EVEN_WEEKS")).toBe("EVEN_WEEKS");
    expect(weeksBeingLaid(held({ recurrence: "ODD_WEEKS" }), "EVEN_WEEKS")).toBe("EVEN_WEEKS");
    expect(weeksBeingLaid(held({ recurrence: "EVEN_WEEKS" }), "ODD_WEEKS")).toBe("ODD_WEEKS");
    expect(otherHalf("ODD_WEEKS")).toBe("EVEN_WEEKS");
  });
});

describe("the two rows of a pair", () => {
  const [brick] = bricksOf([post()]);

  it("is the held half and the second, each with its own weeks, place and room, in one list with every other row as it stands", () => {
    const rows = pairInputs(brick!, post(), held(), { spot: { dayOfWeek: 4, startMinutes: 13 * 60 + 15 }, roomId: "r-b3" });
    expect(rows).toEqual([
      { dayOfWeek: 2, startTime: "10:00", minutes: 60, roomId: "r-a12", recurrence: "ODD_WEEKS" },
      { dayOfWeek: 4, startTime: "13:15", minutes: 60, roomId: "r-b3", recurrence: "EVEN_WEEKS" },
    ]);
    const existing = [row({ dayOfWeek: 1, startTime: "08:00", endTime: "09:00" })];
    expect(listAfter(existing, { kind: "addPair", inputs: rows })).toEqual([
      { dayOfWeek: 1, startTime: "08:00", minutes: 60, roomId: "r-a12", recurrence: "ALL_WEEKS" },
      ...rows,
    ]);
  });

  it("starts with the even weeks when the even half was held", () => {
    const rows = pairInputs(brick!, post(), held({ recurrence: "EVEN_WEEKS" }), { spot: { dayOfWeek: 3, startMinutes: 9 * 60 }, roomId: "r-a12" });
    expect(rows.map((entry) => entry.recurrence)).toEqual(["EVEN_WEEKS", "ODD_WEEKS"]);
  });

  it("names nobody on a post that shares nothing, and the same teacher on both halves of a shared post's lesson", () => {
    expect(pairInputs(brick!, post(), held(), { spot: { dayOfWeek: 4, startMinutes: 600 }, roomId: "r-a12" }).map((entry) => "teacherId" in entry)).toEqual([false, false]);
    const boBrick = bricksOf([shared()]).find((entry) => entry.teacherId === "bo")!;
    const rows = pairInputs(boBrick, shared(), held({ partKey: "post-1|bo|60", teacherId: "bo" }), { spot: { dayOfWeek: 4, startMinutes: 600 }, roomId: "r-a12" });
    expect(rows.map((entry) => entry.teacherId)).toEqual(["bo", "bo"]);
  });

  it("keeps a pair of Anna's apart from a pair of Bo's on a shared post: each removal takes only its own teacher's other half", () => {
    // Anna's pair on Tuesday (odd) and Thursday (even); Bo's, of the same length, on the same days.
    const rows = [
      row({ id: "a-odd", teacherId: "anna", recurrence: "ODD_WEEKS", dayOfWeek: 2 }),
      row({ id: "b-odd", teacherId: "bo", recurrence: "ODD_WEEKS", dayOfWeek: 2, startTime: "13:00", endTime: "14:00" }),
      row({ id: "a-even", teacherId: "anna", recurrence: "EVEN_WEEKS", dayOfWeek: 4 }),
      row({ id: "b-even", teacherId: "bo", recurrence: "EVEN_WEEKS", dayOfWeek: 4, startTime: "13:00", endTime: "14:00" }),
    ];
    const keys = keysOfRows(rows);
    const post1 = shared();
    expect(removalOf(rows, post1, keys[0]!)).toEqual([keys[0], keys[2]]);
    expect(removalOf(rows, post1, keys[1]!)).toEqual([keys[1], keys[3]]);
    expect(removalOf(rows, post1, keys[3]!)).toEqual([keys[3], keys[1]]);
  });

  it("is not the pair of another length: a half of 60 minutes is not completed by a half of 40", () => {
    const rows = [row({ recurrence: "ODD_WEEKS" }), row({ recurrence: "EVEN_WEEKS", minutes: 40, dayOfWeek: 4, startTime: "13:00", endTime: "13:40" })];
    const keys = keysOfRows(rows);
    expect(removalOf(rows, post(), keys[0]!)).toEqual([keys[0]]);
  });
});

describe("the held half on the week", () => {
  const names = { subject: "Matematik", subtitle: "7A · A. Ek", room: "A12", color: "#2563eb", note: "heldNote(udda veckor)" };

  it("is a card of its own, dashed, and says that it is not saved", () => {
    const card = heldHalfCard(held(), names);
    expect(card).toMatchObject({
      id: "pairhalf:post-1|anna|60",
      dayOfWeek: 2,
      startMinutes: 600,
      endMinutes: 660,
      title: "Matematik",
      subtitle: "7A · A. Ek",
      room: "A12",
      relieved: true,
      recurrenceNote: "heldNote(udda veckor)",
    });
    expect(card.id).toBe(heldHalfCardId("post-1|anna|60"));
    expect(card.locked).toBeUndefined();
  });

  it("takes its length from the half, not from an hour: a half of 40 minutes ends 40 minutes after it starts, as a card and as the clash rule's lesson", () => {
    const forty = held({ minutes: 40, startMinutes: 9 * 60 + 15 });
    expect(heldHalfCard(forty, names)).toMatchObject({ startMinutes: 555, endMinutes: 595 });
    expect(heldHalfPlacement(forty, post())).toMatchObject({ startMinutes: 555, endMinutes: 595 });
    // And one of an hour and a half, which crosses a full hour.
    const long = held({ minutes: 90, startMinutes: 10 * 60 });
    expect(heldHalfCard(long, names).endMinutes).toBe(690);
    expect(heldHalfPlacement(long, post()).endMinutes).toBe(690);
  });

  it("leaves the room out when the room is not known, not a blank", () => {
    expect("room" in heldHalfCard(held(), { ...names, room: undefined })).toBe(false);
  });

  it("is a lesson in the clash rule's own terms: the post's class, subject and window, its weeks, its room, and its teacher (the post's when nobody is named)", () => {
    const placement = heldHalfPlacement(held({ recurrence: "EVEN_WEEKS" }), post({ startDate: "2026-08-24", endDate: "2026-12-18", coTeacherId: "co" }));
    expect(placement).toMatchObject({
      id: "pairhalf:post-1|anna|60",
      dayOfWeek: 2,
      startMinutes: 600,
      endMinutes: 660,
      teacherId: "anna",
      coTeacherId: "co",
      roomId: "r-a12",
      studentGroupId: "g-7a",
      subjectId: "s-ma",
      recurrence: "EVEN_WEEKS",
      startDate: "2026-08-24",
      endDate: "2026-12-18",
    });
    // A shared post's half is its own teacher's lesson.
    expect(heldHalfPlacement(held({ teacherId: "bo" }), shared()).teacherId).toBe("bo");
  });

  it("carries the pupils' minutes around an idrott lesson, as every lesson of the week does", () => {
    const buffers = new Map([["g-7a:s-ma", { minutesBefore: 15, minutesAfter: 10 }]]);
    expect(heldHalfPlacement(held(), post(), buffers)).toMatchObject({ minutesBefore: 15, minutesAfter: 10 });
    expect("minutesBefore" in heldHalfPlacement(held(), post())).toBe(false);
  });
});
