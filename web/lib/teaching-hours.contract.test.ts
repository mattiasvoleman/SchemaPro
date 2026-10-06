import { describe, expect, it } from "vitest";
import fixture from "../../src/staffing/__fixtures__/teaching-weeks-cases.json";
import {
  teachingWeeks,
  weeksInPeriod,
  type ClosedRange,
  type TeachingPeriod,
  type YearBounds,
} from "@/lib/teaching-hours";

/**
 * The same week arithmetic, implemented twice, checked against one fixture.
 *
 * The gateway ported this module to src/staffing/teaching-weeks.ts for the
 * staffing report, in UTC and on the gateway's own ISO-week function. A
 * teacher's standardvecka there and a group's hours here are the same
 * requirement counted twice, so the two copies replay one list of cases —
 * src/staffing/__fixtures__/teaching-weeks-cases.json, asserted on the other
 * side by teaching-weeks.contract.spec.ts. Add a case for both at once.
 *
 * Imported across the package boundary on purpose: a copy of the fixture in
 * web/lib/__fixtures__ would be two files that have to be edited together,
 * which is exactly the drift this test exists to catch.
 */

interface FixtureCase {
  name: string;
  period: TeachingPeriod;
  closures: ClosedRange[];
  gradeLevel: number | null;
  weeksInPeriod: number;
  teachingWeeks: number;
}

const { year, cases } = fixture as { year: YearBounds; cases: FixtureCase[] };

describe("teaching weeks agree with the gateway's fixture", () => {
  it("has cases to replay", () => {
    expect(cases.length).toBeGreaterThan(15);
    expect(cases.some((entry) => entry.teachingWeeks !== entry.weeksInPeriod)).toBe(true);
  });

  it.each(cases.map((entry) => [entry.name, entry] as const))("%s", (_name, entry) => {
    expect(weeksInPeriod(entry.period, year)).toBe(entry.weeksInPeriod);
    expect(teachingWeeks(entry.period, year, entry.closures, entry.gradeLevel)).toBeCloseTo(
      entry.teachingWeeks,
      10,
    );
  });
});
