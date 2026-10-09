import { describe, expect, it } from "vitest";
import fixture from "../../src/staffing/__fixtures__/teacher-load-cases.json";
import {
  buildTeacherLoadReport,
  loadStatus,
  type LoadInput,
  type TeacherLoadReport,
} from "@/lib/teacher-load";
import { isMixed } from "@/lib/lesson-lengths";

/**
 * The same load report, implemented twice, checked against one fixture.
 *
 * The gateway computes GET /staffing/load in src/staffing/teacher-load.ts;
 * this module is its mirror, for the figures the browser states before a
 * round trip. The fixture was generated from the GATEWAY copy, so what this
 * test proves is that the web arrives at the same whole minutes, the same
 * one-decimal percentages, the same four-decimal shares and the same sort
 * order for twenty inputs that between them reach every branch: odd/even
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
    // Fas 2: a row charged off 100 %, an uppdrag, and a short subject.
    expect(cases.some((entry) => entry.input.requirements.some((r) => r.coTeacherLoadPercent !== 100))).toBe(true);
    expect(cases.some((entry) => entry.input.duties.length > 0)).toBe(true);
    expect(cases.some((entry) => entry.report.subjectBottlenecks.some((b) => b.short))).toBe(true);
  });

  it("reaches a split row, every week, odd weeks, co-taught and unstaffed", () => {
    // Lektionslängder: 1 × 80 + 1 × 40 charges 120, on both sides.
    const split = cases.flatMap((c) => c.input.requirements).filter((r) => isMixed(r));
    expect(split.some((r) => r.recurrence === "ALL_WEEKS" && r.teacherId !== null)).toBe(true);
    expect(split.some((r) => r.recurrence !== "ALL_WEEKS")).toBe(true);
    expect(split.some((r) => r.coTeacherId !== null && r.coTeacherLoadPercent !== 100)).toBe(true);
    expect(split.some((r) => r.teacherId === null)).toBe(true);
  });

  it("reaches the Fas 3 factor and årsarbetstid branches", () => {
    // Skola24's Faktor model: a weight off 1 under FACTOR, never on lesson minutes.
    expect(cases.some((entry) => entry.report.loadModel === "FACTOR")).toBe(true);
    expect(cases.some((entry) => entry.input.requirements.some((r) => (r.loadWeight ?? 1) !== 1))).toBe(true);
    const teachers = cases.flatMap((entry) => entry.report.teachers);
    expect(teachers.some((t) => t.assignments.some((a) => a.minutesPerWeek !== a.timeMinutesPerWeek))).toBe(true);
    expect(new Set(teachers.map((t) => t.annual.contractKind))).toEqual(new Set(["FERIE", "SEMESTER", null]));
  });

  it.each(cases.map((entry) => [entry.name, entry] as const))("%s", (_name, entry) => {
    expect(buildTeacherLoadReport(entry.input)).toEqual(entry.report);
  });
});

describe("loadStatus", () => {
  it("judges the whole minutes the report prints, as the gateway does", () => {
    // The gateway's teacher-load.spec pins the same four edges; the fixture
    // has no fractional case on a band edge, so the mirror is pinned here.
    expect(loadStatus(990.15, 900, 10)).toBe("OK");
    expect(loadStatus(990.5, 900, 10)).toBe("OVER");
    expect(loadStatus(809.6, 900, 10)).toBe("OK");
    expect(loadStatus(809.4, 900, 10)).toBe("UNDER");
  });
});
