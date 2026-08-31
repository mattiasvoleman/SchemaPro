import { describe, expect, it } from "vitest";
import { buildGradeSpans, spanMeetsRule } from "./grade-span";

/*
 * A year rule written as "åk 4" has to reach the groups those pupils sit in,
 * and a teaching group carries no year of its own — 4sl1 is a slöjd half of a
 * class, and its `gradeLevel` is null. Getting this wrong in one direction lets
 * a rule through that should have bitten; in the other it forbids lessons for a
 * group nobody meant to name.
 */

const spans = (
  groups: Array<{ id: string; gradeLevel: number | null }>,
  members: Record<string, string[]> = {},
  home: Record<string, string | null> = {},
) =>
  buildGradeSpans({
    groups,
    membersByGroup: new Map(Object.entries(members)),
    homeClassOf: new Map(Object.entries(home)),
  });

describe("buildGradeSpans", () => {
  it("takes a class's year from the class itself", () => {
    expect(spans([{ id: "4a", gradeLevel: 4 }]).get("4a")).toEqual({ min: 4, max: 4 });
  });

  it("derives a teaching group's year from its members' home classes", () => {
    // The case the server already handled and this side did not: 4sl1 has no
    // year, and every one of its pupils is in åk 4.
    const result = spans(
      [
        { id: "4a", gradeLevel: 4 },
        { id: "4sl1", gradeLevel: null },
      ],
      { "4sl1": ["s1", "s2"] },
      { s1: "4a", s2: "4a" },
    );

    expect(result.get("4sl1")).toEqual({ min: 4, max: 4 });
  });

  it("spans every year its members come from", () => {
    // A språkval drawn from two years is in both, and a rule for either reaches
    // it — the pupils cannot be in two places.
    const result = spans(
      [
        { id: "5a", gradeLevel: 5 },
        { id: "6a", gradeLevel: 6 },
        { id: "sp1", gradeLevel: null },
      ],
      { sp1: ["s1", "s2"] },
      { s1: "5a", s2: "6a" },
    );

    expect(result.get("sp1")).toEqual({ min: 5, max: 6 });
  });

  it("falls back to the group's own year when no member has one", () => {
    // A class created before its pupils are enrolled still carries its year.
    const result = spans([{ id: "7b", gradeLevel: 7 }], { "7b": [] });

    expect(result.get("7b")).toEqual({ min: 7, max: 7 });
  });

  it("prefers the members over the group's own year where they differ", () => {
    // The people in the room decide. A class whose roll has drifted is the case
    // this ordering is for.
    const result = spans(
      [
        { id: "8a", gradeLevel: 8 },
        { id: "9a", gradeLevel: 9 },
      ],
      { "8a": ["s1"] },
      { s1: "9a" },
    );

    expect(result.get("8a")).toEqual({ min: 9, max: 9 });
  });

  it("leaves out a group whose year nobody knows", () => {
    /*
     * Not defaulted to anything. A year rule that reached a group whose year is
     * unknown would be a guess, and the guess would silently forbid lessons.
     * Absent, the rule does not reach it — the lesson is placed and somebody
     * can see that it should not have been.
     */
    const result = spans([{ id: "kör", gradeLevel: null }], { "kör": ["s1"] }, { s1: null });

    expect(result.has("kör")).toBe(false);
  });
});

describe("spanMeetsRule", () => {
  it.each([
    ["a rule inside the span", { min: 4, max: 6 }, 5, 5, true],
    ["a rule overlapping one end", { min: 6, max: 7 }, 4, 6, true],
    ["a rule meeting exactly at the low bound", { min: 4, max: 4 }, 4, 6, true],
    ["a rule meeting exactly at the high bound", { min: 6, max: 6 }, 4, 6, true],
    ["a rule just below", { min: 5, max: 6 }, 3, 4, false],
    ["a rule just above", { min: 5, max: 6 }, 7, 9, false],
  ])("%s", (_label, span, min, max, expected) => {
    expect(spanMeetsRule(span, { minGradeLevel: min, maxGradeLevel: max })).toBe(expected);
  });

  it("treats a null bound as open at that end", () => {
    expect(spanMeetsRule({ min: 9, max: 9 }, { minGradeLevel: 7, maxGradeLevel: null })).toBe(true);
    expect(spanMeetsRule({ min: 1, max: 1 }, { minGradeLevel: null, maxGradeLevel: 3 })).toBe(true);
  });

  it("reaches nothing when the span is unknown", () => {
    expect(spanMeetsRule(undefined, { minGradeLevel: null, maxGradeLevel: null })).toBe(false);
  });
});
