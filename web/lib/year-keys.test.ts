import { describe, expect, it } from "vitest";
import { AFTER_ACTIVATION, AFTER_ROLLOVER } from "./year-keys";
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
