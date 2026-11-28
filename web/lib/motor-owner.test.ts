import { describe, expect, it } from "vitest";
import { keptByMotor, motorOwner } from "./motor-owner";

const lesson = (over: Record<string, unknown> = {}) => ({ isLocked: false, isGenerated: true, fromPlacement: false, extraGroupIds: [] as string[], studentIds: [] as string[], ...over });

describe("what the next Generera does with a lesson, as the gateway's rule says it", () => {
  it("lays a lesson it laid and nobody has locked again", () => {
    expect(motorOwner(lesson())).toBe("FREE");
    expect(keptByMotor("FREE")).toBe(false);
  });

  it("keeps a lesson that is locked, and a lesson that was made by hand whether or not it is locked", () => {
    expect(motorOwner(lesson({ isLocked: true }))).toBe("LOCKED");
    expect(motorOwner(lesson({ isGenerated: false }))).toBe("HANDMADE");
    expect(motorOwner(lesson({ isGenerated: false, isLocked: true }))).toBe("HANDMADE");
    expect(keptByMotor("LOCKED") && keptByMotor("HANDMADE")).toBe(true);
  });

  it("keeps a lesson with an extra class or named pupils", () => {
    expect(motorOwner(lesson({ extraGroupIds: ["g2"] }))).toBe("PUPILS");
    expect(motorOwner(lesson({ studentIds: ["s1"] }))).toBe("PUPILS");
    expect(keptByMotor("PUPILS")).toBe(true);
  });

  it("writes a lesson that came from a förläggning again from its row, locked or not, and does not keep it", () => {
    expect(motorOwner(lesson({ fromPlacement: true }))).toBe("PLACED");
    expect(motorOwner(lesson({ fromPlacement: true, isLocked: true }))).toBe("PLACED");
    expect(keptByMotor("PLACED")).toBe(false);
  });

  // L-3 (granskaren g511): the sentence read the lesson as stored. A save that writes other weeks hands a generated lesson to the school, and a
  // save that moves an unlocked one locks it, so "Fri" under either was wrong.
  it("keeps a generated lesson whose weeks the save writes, and a lesson the save moves", () => {
    expect(motorOwner(lesson(), { weeks: true })).toBe("WEEKS");
    expect(motorOwner(lesson({ isLocked: true }), { weeks: true })).toBe("WEEKS");
    expect(motorOwner(lesson(), { moves: true })).toBe("MOVED");
    expect(keptByMotor("WEEKS") && keptByMotor("MOVED")).toBe(true);
    // Neither is said of a save that writes neither, and the weeks come before the move.
    expect(motorOwner(lesson(), { weeks: false, moves: false })).toBe("FREE");
    expect(motorOwner(lesson(), { weeks: true, moves: true })).toBe("WEEKS");
  });

  it("says what was already true: a lesson made by hand is handmade, and a locked one is locked, whatever the save moves", () => {
    expect(motorOwner(lesson({ isGenerated: false }), { weeks: true, moves: true })).toBe("HANDMADE");
    expect(motorOwner(lesson({ isLocked: true }), { moves: true })).toBe("LOCKED");
    expect(motorOwner(lesson({ extraGroupIds: ["g2"] }), { moves: true })).toBe("PUPILS");
  });

  it("leaves a lesson from a förläggning to be written again: the gateway refuses to move it or give it weeks", () => {
    expect(motorOwner(lesson({ fromPlacement: true }), { weeks: true, moves: true })).toBe("PLACED");
  });

  it("says nothing of a lesson read without the column", () => {
    expect(motorOwner(lesson({ isGenerated: undefined }))).toBeNull();
  });
});
