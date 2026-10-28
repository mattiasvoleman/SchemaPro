import { describe, expect, it } from "vitest";
import {
  halvesRow,
  lengthsOf,
  periodsProblem,
  plannedRows,
  presetPeriods,
  proposedLessons,
  termHalfway,
} from "./half-class-periods";

/**
 * The läsår 2026/27: the autumn is 17 August to 3 January, twenty teaching
 * weeks with no lov entered; the spring 4 January to 11 June, twenty-three.
 */
const YEAR = { startDate: "2026-08-17", endDate: "2027-06-11" };
const SPRING = "2027-01-04";
const AUTUMN = { startDate: "2026-08-17", endDate: "2027-01-03" };
/** Höstlovet (week 44) and jullovet's two weeks. */
const LOV = [
  { startDate: "2026-10-26", endDate: "2026-10-30" },
  { startDate: "2026-12-21", endDate: "2027-01-01" },
];

describe("termHalfway", () => {
  it("splits a term's teaching weeks evenly: ten and ten in an autumn of twenty", () => {
    expect(termHalfway(AUTUMN, YEAR, [], null)).toBe("2026-10-26");
  });

  it("counts the weeks with lov off, so höstlovet and jullovet move the mark, the extra week to the second half", () => {
    // Seventeen teaching weeks: 8 before 12 October, 9 from it.
    expect(termHalfway(AUTUMN, YEAR, LOV, 7)).toBe("2026-10-12");
  });

  it("moves the mark later for lov in the first half: nine taught weeks on each side", () => {
    // Two studieveckor in September and October: 18 teaching weeks, the
    // second half starting 2 November rather than 26 October.
    const early = [
      { startDate: "2026-09-07", endDate: "2026-09-11" },
      { startDate: "2026-10-05", endDate: "2026-10-09" },
    ];
    expect(termHalfway(AUTUMN, YEAR, early, null)).toBe("2026-11-02");
  });

  it("reads a lov only for the grades it closes", () => {
    const lowerOnly = LOV.map((lov) => ({ ...lov, minGradeLevel: 1, maxGradeLevel: 3 }));
    expect(termHalfway(AUTUMN, YEAR, lowerOnly, 7)).toBe("2026-10-26");
  });

  it("has no mark for a term with no Monday after its first day", () => {
    expect(termHalfway({ startDate: "2026-08-17", endDate: "2026-08-21" }, YEAR, [], null)).toBeNull();
  });
});

describe("presetPeriods", () => {
  it("draws the two terms from the spring term's first day", () => {
    expect(presetPeriods("terms", SPRING, YEAR, [], null)).toEqual([
      { startDate: "2026-08-17", endDate: "2027-01-03" },
      { startDate: "2027-01-04", endDate: "2027-06-11" },
    ]);
  });

  it("draws the first and second half of the autumn", () => {
    expect(presetPeriods("autumnHalves", SPRING, YEAR, [], null)).toEqual([
      { startDate: "2026-08-17", endDate: "2026-10-25" },
      { startDate: "2026-10-26", endDate: "2027-01-03" },
    ]);
  });

  it("draws the first and second half of the spring, the odd week to the second", () => {
    expect(presetPeriods("springHalves", SPRING, YEAR, [], null)).toEqual([
      { startDate: "2027-01-04", endDate: "2027-03-21" },
      { startDate: "2027-03-22", endDate: "2027-06-11" },
    ]);
  });

  it("draws the first half of each term", () => {
    expect(presetPeriods("firstHalves", SPRING, YEAR, [], null)).toEqual([
      { startDate: "2026-08-17", endDate: "2026-10-25" },
      { startDate: "2027-01-04", endDate: "2027-03-21" },
    ]);
  });

  it("draws nothing from a spring start outside the year", () => {
    expect(presetPeriods("terms", "2026-08-17", YEAR, [], null)).toBeNull();
    expect(presetPeriods("autumnHalves", "", YEAR, [], null)).toBeNull();
  });
});

describe("periodsProblem", () => {
  const [first, second] = presetPeriods("autumnHalves", SPRING, YEAR, [], null)!;

  it("takes two of the year's stretches, the first ending before the second starts", () => {
    expect(periodsProblem([first, second], YEAR)).toBeNull();
    // Touching is not meeting: 25 October, then 26.
    expect(periodsProblem([first, { ...second, startDate: "2026-10-26" }], YEAR)).toBeNull();
  });

  it.each([
    ["a day not given", [first, { ...second, endDate: "" }], "MISSING"],
    ["a period that ends before it starts", [{ ...first, endDate: "2026-08-01" }, second], "BACKWARDS"],
    ["a period before the year", [{ ...first, startDate: "2026-08-10" }, second], "OUTSIDE_YEAR"],
    ["a period after the year", [first, { ...second, endDate: "2027-06-18" }], "OUTSIDE_YEAR"],
    ["periods that meet", [first, { ...second, startDate: "2026-10-25" }], "OVERLAP"],
    ["the second period first", [second, first], "OVERLAP"],
  ] as const)("refuses %s", (_, periods, problem) => {
    expect(periodsProblem(periods, YEAR)).toBe(problem);
  });
});

describe("proposedLessons", () => {
  const slojd = { lessonsPerWeek: 2, minutesPerLesson: 60, lessonLengths: [], recurrence: "ALL_WEEKS" as const };
  const hemkunskap = { lessonsPerWeek: 1, minutesPerLesson: 30, lessonLengths: [], recurrence: "ALL_WEEKS" as const };
  const terms = presetPeriods("terms", SPRING, YEAR, [], null)!;
  const autumnHalves = presetPeriods("autumnHalves", SPRING, YEAR, [], null)!;

  it("keeps the class's week for two subjects over the terms: each pupil reads one in each", () => {
    expect(proposedLessons(slojd, terms, 2, YEAR, [], null)).toBeNull();
  });

  it("doubles it for one subject over the terms, over the shorter one", () => {
    // 2 × 60 over 43 weeks is 5 160 minutes; over the autumn's 20, 258 a week.
    expect(proposedLessons(slojd, terms, 1, YEAR, [], null)).toEqual({ count: 4, minutes: 60 });
  });

  it("asks four times the pace of hemkunskap read in half the autumn, in the class's lesson length", () => {
    // 1 × 30 over 43 weeks is 1 290 minutes; over ten weeks, 129 a week.
    expect(proposedLessons(hemkunskap, autumnHalves, 1, YEAR, [], null)).toEqual({ count: 4, minutes: 30 });
  });

  it("doubles it for two subjects swapped within the autumn: each pupil reads the line half the year", () => {
    expect(proposedLessons(slojd, autumnHalves, 2, YEAR, [], null)).toEqual({ count: 4, minutes: 60 });
  });

  it("counts odd weeks as the class's post does", () => {
    const odd = { ...hemkunskap, recurrence: "ODD_WEEKS" as const };
    // Odd weeks over the year and over the period alike: the same four.
    expect(proposedLessons(odd, autumnHalves, 1, YEAR, [], null)).toEqual({ count: 4, minutes: 30 });
  });

  it("proposes nothing for a period without a teaching week", () => {
    const allLov = [{ startDate: "2026-08-17", endDate: "2026-10-25" }];
    expect(proposedLessons(hemkunskap, autumnHalves, 1, YEAR, allLov, null)).toBeNull();
  });
});

describe("the posts the split writes", () => {
  const periods = presetPeriods("autumnHalves", SPRING, YEAR, [], null)!;
  const week = halvesRow({ lessonsPerWeek: 1, minutesPerLesson: 30 }, { count: 4, minutes: 30 });

  it("writes one subject as a post per half in its own period", () => {
    expect(plannedRows(week, "ALL_WEEKS", periods, 1).map((row) => [row.half, row.subject, row.startDate, row.endDate])).toEqual([
      [0, 0, "2026-08-17", "2026-10-25"],
      [1, 0, "2026-10-26", "2027-01-03"],
    ]);
  });

  it("writes two subjects as four posts, the halves swapping them", () => {
    expect(plannedRows(week, "ALL_WEEKS", periods, 2).map((row) => [row.half, row.subject, row.startDate])).toEqual([
      [0, 0, "2026-08-17"],
      [0, 1, "2026-10-26"],
      [1, 1, "2026-08-17"],
      [1, 0, "2026-10-26"],
    ]);
  });

  it("sends a week of one length as one length per lesson, and keeps the class's when there is none", () => {
    expect(lengthsOf({ count: 4, minutes: 30 })).toEqual([30, 30, 30, 30]);
    expect(week).toEqual({ lessonsPerWeek: 4, minutesPerLesson: 30, lessonLengths: [] });
    const mixed = { lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40] };
    expect(halvesRow(mixed, null)).toBe(mixed);
  });
});
