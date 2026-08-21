import { describe, expect, it } from "vitest";
import { gradeRangeLabel, SCHOOL_STAGES, stageOf } from "@/lib/school-stages";

const stageName = (key: string) => `stage.${key}`;

describe("stageOf", () => {
  it("recognises the Swedish stages", () => {
    expect(stageOf(0, 3)?.key).toBe("lower");
    expect(stageOf(4, 6)?.key).toBe("middle");
    expect(stageOf(7, 9)?.key).toBe("upper");
  });

  it("returns nothing for a range that is not a stage", () => {
    expect(stageOf(5, 8)).toBeNull();
  });

  it("returns nothing when either end is open", () => {
    // A half-open range is a limit, but not a stage — naming it one would be
    // a lie on screen.
    expect(stageOf(4, null)).toBeNull();
    expect(stageOf(null, 6)).toBeNull();
  });
});

describe("gradeRangeLabel", () => {
  it("says nothing when the room takes every year", () => {
    expect(gradeRangeLabel(null, null, stageName)).toBeNull();
  });

  it("names the stage when the range is one", () => {
    expect(gradeRangeLabel(4, 6, stageName)).toBe("stage.middle");
  });

  it("writes a custom range out", () => {
    expect(gradeRangeLabel(5, 8, stageName)).toBe("5–8");
  });

  it("collapses a single year to one number", () => {
    expect(gradeRangeLabel(0, 0, stageName)).toBe("0");
  });

  it("marks an open end rather than pretending it is closed", () => {
    expect(gradeRangeLabel(7, null, stageName)).toBe("7–");
    expect(gradeRangeLabel(null, 3, stageName)).toBe("–3");
  });

  it("keeps year 0 — förskoleklass is a year, not a missing value", () => {
    expect(gradeRangeLabel(0, 3, stageName)).toBe("stage.lower");
    expect(SCHOOL_STAGES[0]?.minGradeLevel).toBe(0);
  });
});
