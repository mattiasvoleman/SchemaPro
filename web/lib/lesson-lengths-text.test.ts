import { describe, expect, it } from "vitest";
import { draftPartsOf, formatLengths, formatParts, shapeFromDraft } from "@/lib/lesson-lengths-text";

describe("formatLengths", () => {
  it("writes a split row longest first, and a uniform row as it always read", () => {
    expect(formatLengths({ lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40] })).toBe(
      "1 × 80 + 1 × 40",
    );
    expect(formatLengths({ lessonsPerWeek: 3, minutesPerLesson: 60, lessonLengths: [60, 60, 55] })).toBe(
      "2 × 60 + 1 × 55",
    );
    expect(formatLengths({ lessonsPerWeek: 3, minutesPerLesson: 60 })).toBe("3 × 60");
    expect(formatLengths({ lessonsPerWeek: 3, minutesPerLesson: 60, lessonLengths: [] })).toBe("3 × 60");
  });

  it("drops the spaces around × in the matrix cell's compact form, not around +", () => {
    expect(formatLengths({ lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40] }, true)).toBe(
      "1×80 + 1×40",
    );
    expect(formatParts([{ count: 3, minutes: 60 }], true)).toBe("3×60");
  });
});

describe("shapeFromDraft", () => {
  const part = (lessons: string, minutes: string) => ({ lessons, minutes });

  it("stores two lengths as the canonical list, whatever order they were typed in", () => {
    expect(shapeFromDraft([part("1", "40"), part("1", "80")])).toEqual({
      shape: { lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40] },
      problem: null,
    });
  });

  it("merges parts of one length into a uniform row with an empty list", () => {
    expect(shapeFromDraft([part("2", "60"), part("1", "60")]).shape).toEqual({
      lessonsPerWeek: 3,
      minutesPerLesson: 60,
      lessonLengths: [],
    });
  });

  it("judges one part as the dialog always did: no grid check, the gateway names the nearest", () => {
    expect(shapeFromDraft([part("3", "42")]).shape).toEqual({
      lessonsPerWeek: 3,
      minutesPerLesson: 42,
      lessonLengths: [],
    });
    expect(shapeFromDraft([part("3", "10")]).problem).toBe("OUT_OF_RANGE");
  });

  it("refuses a split the CHECK would refuse, naming why", () => {
    expect(shapeFromDraft([part("1", "80"), part("1", "")]).problem).toBe("INCOMPLETE");
    expect(shapeFromDraft([part("1", "80"), part("0", "40")]).problem).toBe("INCOMPLETE");
    expect(shapeFromDraft([part("1", "80"), part("1", "42")]).problem).toBe("OFF_GRID");
    expect(shapeFromDraft([part("1", "80"), part("1", "250")]).problem).toBe("OUT_OF_RANGE");
    expect(shapeFromDraft([part("1", "80"), part("1", "40.5")]).problem).toBe("NOT_INTEGER");
    expect(shapeFromDraft([part("30", "40"), part("11", "45")]).problem).toBe("TOO_MANY_LESSONS");
    expect(
      shapeFromDraft([part("1", "80"), part("1", "60"), part("1", "40"), part("1", "20")]).problem,
    ).toBe("TOO_MANY_KINDS");
  });
});

describe("draftPartsOf", () => {
  it("opens a split row as its parts and a uniform one as one part", () => {
    expect(draftPartsOf({ lessonsPerWeek: 3, minutesPerLesson: 60, lessonLengths: [60, 60, 55] })).toEqual([
      { lessons: "2", minutes: "60" },
      { lessons: "1", minutes: "55" },
    ]);
    expect(draftPartsOf({ lessonsPerWeek: 2, minutesPerLesson: 60, lessonLengths: [] })).toEqual([
      { lessons: "2", minutes: "60" },
    ]);
  });
});
