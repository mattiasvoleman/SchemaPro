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

  it("says nothing of a lesson read without the column", () => {
    expect(motorOwner(lesson({ isGenerated: undefined }))).toBeNull();
  });
});
