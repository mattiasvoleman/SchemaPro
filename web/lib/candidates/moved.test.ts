import { describe, expect, it } from "vitest";
import { movedCount, movedLessons, type SlotLesson } from "./moved";

const at = (
  dayOfWeek: number,
  startTime: string,
  endTime: string,
  overrides: Partial<SlotLesson> = {},
): SlotLesson => ({
  studentGroupId: "g-7a",
  subjectId: "s-ma",
  dayOfWeek,
  startTime,
  endTime,
  roomId: "r-1",
  ...overrides,
});

describe("movedLessons — the gateway's multiset match, listed", () => {
  it("lists nothing for a candidate that keeps every lesson where it is", () => {
    const draft = [at(1, "08:00:00", "09:00:00"), at(3, "10:00:00", "11:00:00")];
    // The draft's rows carry seconds, the candidate's do not: still the same slot.
    const candidate = [at(3, "10:00", "11:00"), at(1, "08:00", "09:00")];
    expect(movedLessons(draft, candidate)).toEqual([]);
  });

  it("pairs what moved within its class and subject, in clock order", () => {
    const draft = [at(1, "08:00", "09:00"), at(3, "08:00", "09:00"), at(5, "08:00", "09:00")];
    const candidate = [at(5, "08:00", "09:00"), at(4, "13:00", "14:00"), at(2, "10:00", "11:00")];
    const moves = movedLessons(draft, candidate);

    expect(moves).toEqual([
      {
        kind: "MOVED",
        studentGroupId: "g-7a",
        subjectId: "s-ma",
        from: { dayOfWeek: 1, startTime: "08:00", endTime: "09:00", roomId: "r-1" },
        to: { dayOfWeek: 2, startTime: "10:00", endTime: "11:00", roomId: "r-1" },
      },
      {
        kind: "MOVED",
        studentGroupId: "g-7a",
        subjectId: "s-ma",
        from: { dayOfWeek: 3, startTime: "08:00", endTime: "09:00", roomId: "r-1" },
        to: { dayOfWeek: 4, startTime: "13:00", endTime: "14:00", roomId: "r-1" },
      },
    ]);
    expect(movedCount(moves)).toBe(2);
  });

  it("calls a kept slot in another room a room change, not a move", () => {
    const moves = movedLessons([at(1, "08:00", "09:00")], [at(1, "08:00", "09:00", { roomId: "r-9" })]);
    expect(moves).toEqual([
      expect.objectContaining({ kind: "ROOM", from: expect.objectContaining({ roomId: "r-1" }), to: expect.objectContaining({ roomId: "r-9" }) }),
    ]);
    // Kept, as far as `moved` is concerned: the gateway counts it in roomChanges.
    expect(movedCount(moves)).toBe(0);
  });

  it("pairs equal rooms first within a slot, so swapped rooms are no change at all", () => {
    const draft = [at(1, "08:00", "09:00", { roomId: "A" }), at(1, "08:00", "09:00", { roomId: "B" })];
    const candidate = [at(1, "08:00", "09:00", { roomId: "B" }), at(1, "08:00", "09:00", { roomId: "A" })];
    expect(movedLessons(draft, candidate)).toEqual([]);
  });

  it("names a lesson the candidate drops and one it adds", () => {
    const moves = movedLessons(
      [at(1, "08:00", "09:00"), at(2, "08:00", "09:00", { subjectId: "s-sv" })],
      [at(1, "08:00", "09:00"), at(4, "09:00", "10:00", { subjectId: "s-en" })],
    );
    expect(moves.map((move) => [move.kind, move.subjectId])).toEqual([
      ["REMOVED", "s-sv"],
      ["ADDED", "s-en"],
    ]);
    // A dropped draft lesson is not kept: the gateway's moved = movedOf − kept counts it.
    expect(movedCount(moves)).toBe(1);
  });

  it("never pairs across classes or subjects", () => {
    const moves = movedLessons([at(1, "08:00", "09:00")], [at(1, "08:00", "09:00", { studentGroupId: "g-7b" })]);
    expect(moves.map((move) => move.kind)).toEqual(["REMOVED", "ADDED"]);
  });

  it("keeps a whole multiset straight when one slot holds the same lesson twice", () => {
    const draft = [at(1, "08:00", "09:00"), at(1, "08:00", "09:00")];
    const candidate = [at(1, "08:00", "09:00"), at(2, "08:00", "09:00")];
    const moves = movedLessons(draft, candidate);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ kind: "MOVED", from: { dayOfWeek: 1 }, to: { dayOfWeek: 2 } });
  });
});
