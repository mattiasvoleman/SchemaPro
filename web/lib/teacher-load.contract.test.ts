import { describe, expect, it } from "vitest";
import fixture from "../../src/staffing/__fixtures__/teacher-load-cases.json";
import {
  buildTeacherLoadReport,
  type LoadInput,
  type TeacherLoadReport,
} from "@/lib/teacher-load";

/**
 * The same load report, implemented twice, checked against one fixture.
 *
 * The gateway computes GET /staffing/load in src/staffing/teacher-load.ts;
 * this module is its mirror, for the figures the browser states before a
 * round trip. The fixture was generated from the GATEWAY copy, so what this
 * test proves is that the web arrives at the same whole minutes, the same
 * one-decimal percentages, the same four-decimal shares and the same sort
 * order for fourteen inputs that between them reach every branch: odd/even
 * halves, a term course under jullov, the tolerance edge, a null policy, the
 * teacher's own target, unstaffed rows, behörighet by span and validity, and a
 * grade-spanned studiedag. `toEqual` and not `toBeCloseTo`, because every
 * number in the report is rounded by the arithmetic itself — a mismatch here
 * is a different answer, not a different ulp.
 *
 * Imported across the package boundary on purpose, as teaching-hours.contract
 * does: a copy of the fixture in web/lib/__fixtures__ would be two files that
 * have to be edited together, which is the drift this test exists to catch.
 */

interface FixtureCase {
  name: string;
  input: LoadInput;
  report: TeacherLoadReport;
}

const { cases } = fixture as unknown as { cases: FixtureCase[] };

describe("the load report agrees with the gateway's fixture", () => {
  it("has cases to replay", () => {
    expect(cases.length).toBeGreaterThan(10);
    expect(cases.some((entry) => entry.report.unqualifiedAssignments.length > 0)).toBe(true);
  });

  it.each(cases.map((entry) => [entry.name, entry] as const))("%s", (_name, entry) => {
    expect(buildTeacherLoadReport(entry.input)).toEqual(entry.report);
  });
});
