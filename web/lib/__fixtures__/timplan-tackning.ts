import fixture from "../../../src/common/__fixtures__/timplan-planned-cases.json";
import type { PlannedCoverage, PlannedCoverageInput } from "@/lib/timplan-planned";
import type { TimplanCoverageResponse } from "@/lib/timplan-tackning";

/**
 * GET /timplan-coverage answers, made from the gateway's own layer-1 fixture
 * (src/common/__fixtures__/timplan-planned-cases.json) rather than written by
 * hand: the coverage page's tests then read documents the gateway really
 * produces, and a change to the module's shape reaches them.
 */
interface FixtureCase {
  name: string;
  input: PlannedCoverageInput;
  coverage: PlannedCoverage;
}

const { cases } = fixture as unknown as { cases: FixtureCase[] };

export function coverageCase(prefix: string): { input: PlannedCoverageInput; response: TimplanCoverageResponse } {
  const found = cases.find((entry) => entry.name.startsWith(prefix));
  if (!found) throw new Error(`no fixture case starts with "${prefix}"`);
  return {
    input: found.input,
    response: {
      ...found.coverage,
      academicYearId: "y-1",
      layer: "planned",
      verdicts: found.coverage.verdicts.map((verdict) => ({ ...verdict, message: verdict.code })),
    },
  };
}

/** Språkval and SvA in teaching groups: one class, three pupils listed. */
export const LANGUAGES = "språkval and SvA in teaching groups";
/** An årskurs without a plan, and a draft attached to åk 9. */
export const UNATTACHED_AND_DRAFT = "an årskurs with classes and no plan";
/** Åk 3 attached to a plan with no minutes for it, and an åk 11 class. */
export const EMPTY_PLAN = "åk 3 attached to a plan that gives it no minutes";
/** A pupil on two språkval rosters (8B). */
export const TWO_ALTERNATIVES = "a pupil on two språkval rosters";
/** Unplanned, under and over in one class (7B). */
export const MIXED = "unplanned, underplanned and overplanned";
