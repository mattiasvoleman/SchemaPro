import { describe, expect, it } from "vitest";
import { AFTER_ACTIVATION, AFTER_ROLLOVER } from "./year-keys";
import { STAFFING_KEYS } from "./staffing-keys";
import { TIMPLAN_COVERAGE_KEYS, YEAR_TIMPLAN_KEYS } from "./year-timplan-keys";

/**
 * A rollover writes the new year's timplan per årskurs (carried by cohort),
 * and both it and an activation change what the coverage page measures: the
 * classes it creates, the pupils it moves. Both prefixes must be refetched
 * after either, or the year dialog and Täckning show the year before.
 */
describe("the läsår invalidation lists", () => {
  it.each([
    ["rollover", AFTER_ROLLOVER],
    ["activation", AFTER_ACTIVATION],
  ])("refetch timplan per årskurs and the coverage after a %s", (_name, keys) => {
    expect(keys).toContainEqual(YEAR_TIMPLAN_KEYS.all);
    expect(keys).toContainEqual(TIMPLAN_COVERAGE_KEYS.all);
  });
});

describe("after a rollover with tjänster och uppdrag", () => {
  it("refetches the new year's posts, uppdrag, load and every cached suggestion", () => {
    // The new year's posts and uppdrag are written by the rollover itself,
    // and suggest-teachers reads the predecessor link the rollover just set.
    for (const key of [STAFFING_KEYS.employments, STAFFING_KEYS.duties, STAFFING_KEYS.load, STAFFING_KEYS.suggestions]) {
      expect(AFTER_ROLLOVER).toContainEqual(key);
    }
  });
});
