import { describe, expect, it } from "vitest";
import fixture from "../../src/common/__fixtures__/timplan-planned-cases.json";
import {
  computePlannedCoverage,
  type PlannedCoverage,
  type PlannedCoverageInput,
} from "@/lib/timplan-planned";

/**
 * Planerat mot timplan, implemented twice, checked against one list of cases.
 *
 * The gateway answers GET /timplan-coverage?layer=planned from
 * src/common/timplan-planned.ts; the Timplansposter matrix's Mål mode repaints
 * from this mirror. The fixture was generated from the GATEWAY copy, so this
 * test proves the browser arrives at the same whole minutes per standardvecka,
 * the same hours to the tenth (lov and a grade-spanned studiedag included),
 * the same statuses, coverage counts, pupil statistics, verdicts and order —
 * for cases reaching every verdict code and every class status, the teacher's
 * group-only read among them. `toEqual`, not `toBeCloseTo`: every figure is
 * rounded by the arithmetic itself, so a mismatch is a different answer.
 *
 * Imported across the package boundary on purpose, as the timplan-coverage
 * contract does: one fixture, never two files edited together.
 */

interface FixtureCase {
  name: string;
  input: PlannedCoverageInput;
  coverage: PlannedCoverage;
}

const { cases } = fixture as unknown as { cases: FixtureCase[] };

describe("planerat mot timplan agrees with the gateway's fixture", () => {
  it("has cases to replay, reaching every verdict code", () => {
    expect(cases.length).toBeGreaterThanOrEqual(9);
    const seen = new Set(cases.flatMap((entry) => entry.coverage.verdicts.map((v) => v.code)));
    expect(seen.size).toBe(8);
  });

  it.each(cases.map((entry) => [entry.name, entry] as const))("%s", (_name, entry) => {
    expect(computePlannedCoverage(entry.input)).toEqual(entry.coverage);
  });
});
