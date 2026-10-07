import { describe, expect, it } from "vitest";
import { dialogGrades, yearTimplansBody, yearTimplansChanged } from "./year-timplan-view";

describe("dialogGrades", () => {
  it("lists förskoleklass to åk 9 for a year with nothing", () => {
    expect(dialogGrades([], [])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("adds a grade the year attaches or has a class in, never one outside 0..10", () => {
    expect(dialogGrades([10], [null, 7, 12])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

describe("yearTimplansBody", () => {
  it("sends every listed grade, a plan's id or null, so nothing is emptied by omission", () => {
    expect(yearTimplansBody([0, 1, 7], new Map([[1, "p-a"], [7, ""]]))).toEqual([
      { gradeLevel: 0, localTimplanId: null },
      { gradeLevel: 1, localTimplanId: "p-a" },
      { gradeLevel: 7, localTimplanId: null },
    ]);
  });
});

describe("yearTimplansChanged", () => {
  const saved = [{ gradeLevel: 1, localTimplanId: "p-a" }];
  it("is false for the saved mapping", () => {
    expect(yearTimplansChanged([0, 1], new Map([[1, "p-a"]]), saved)).toBe(false);
    expect(yearTimplansChanged([0, 1], new Map([[0, ""], [1, "p-a"]]), saved)).toBe(false);
  });

  it("sees a plan chosen, changed or cleared", () => {
    expect(yearTimplansChanged([0, 1], new Map([[0, "p-a"], [1, "p-a"]]), saved)).toBe(true);
    expect(yearTimplansChanged([0, 1], new Map([[1, "p-b"]]), saved)).toBe(true);
    expect(yearTimplansChanged([0, 1], new Map([[1, ""]]), saved)).toBe(true);
  });
});
