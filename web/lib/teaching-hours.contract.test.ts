import { describe, expect, it } from "vitest";
import fixture from "../../src/staffing/__fixtures__/teaching-weeks-cases.json";
import byDaysFixture from "../../src/staffing/__fixtures__/teaching-weeks-by-days-cases.json";
import {
  teachingWeeks,
  teachingWeeksByDays,
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

/**
 * Weeks counted in school days (teachingWeeksByDays), replayed against the hand-worked cases the gateway replays too
 * (src/staffing/__fixtures__/teaching-weeks-by-days-cases.json, teaching-weeks.contract.spec.ts, which also checks it day by day
 * against the gateway's runsOn). The annual figures of the load report are counted with it on both sides, so a läsår that starts
 * on a Saturday is the same hours in the browser as in the gateway.
 */
describe("teachingWeeksByDays agrees with the shared fixture", () => {
  interface ByDaysCase {
    name: string;
    year: YearBounds;
    period: TeachingPeriod;
    closures: ClosedRange[];
    gradeLevel: number | null;
    teachingWeeksByDays: number;
    teachingWeeks: number;
  }
  const cases = (byDaysFixture as unknown as { cases: ByDaysCase[] }).cases;

  it("has cases that differ from teachingWeeks and cases that agree with it", () => {
    expect(cases.some((entry) => entry.teachingWeeksByDays !== entry.teachingWeeks)).toBe(true);
    expect(cases.some((entry) => entry.teachingWeeksByDays === entry.teachingWeeks)).toBe(true);
  });

  it.each(cases.map((entry) => [entry.name, entry] as const))("%s", (_name, entry) => {
    expect(teachingWeeksByDays(entry.period, entry.year, entry.closures, entry.gradeLevel)).toBeCloseTo(entry.teachingWeeksByDays, 10);
    expect(teachingWeeks(entry.period, entry.year, entry.closures, entry.gradeLevel)).toBeCloseTo(entry.teachingWeeks, 10);
  });
});
