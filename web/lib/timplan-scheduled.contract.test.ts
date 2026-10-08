import { describe, expect, it } from "vitest";
import fixture from "../../src/common/__fixtures__/timplan-scheduled-cases.json";
import {
  computeScheduledCoverage,
  lessonMinutes,
  type ScheduledCoverage,
  type ScheduledCoverageInput,
} from "@/lib/timplan-scheduled";
import { isMixed } from "@/lib/lesson-lengths";

/**
 * Schemalagt mot planerat, implemented twice, checked against one list of
 * cases.
 *
 * The gateway answers GET /timplan-coverage?layer=scheduled from
 * src/common/timplan-scheduled.ts; the timetable's Lektionstid panel repaints
 * from this mirror. If the two drift, the board says "stämmer" while
 * Täckning says short for the same rows. The fixture was generated from the
 * GATEWAY copy, so this test proves the browser arrives at the same whole
 * minutes per standardvecka — odd and even weeks, a dated window across ISO
 * week 53, a grade-scoped lov, parked lessons, extra groups, named pupils, a
 * 55-minute lesson and a split post — the same statuses, statistics,
 * verdicts and order. `toEqual`, not `toBeCloseTo`: every figure is rounded
 * by the arithmetic itself, so a mismatch is a different answer.
 *
 * Imported across the package boundary on purpose, as the planned layer's
 * contract does: one fixture, never two files edited together.
 */

interface FixtureCase {
  name: string;
  input: ScheduledCoverageInput;
  coverage: ScheduledCoverage;
}

const { cases } = fixture as unknown as { cases: FixtureCase[] };

describe("schemalagt mot planerat agrees with the gateway's fixture", () => {
  it("has cases to replay, reaching every verdict code and every line status", () => {
    expect(cases.length).toBeGreaterThanOrEqual(9);
    const codes = new Set(cases.flatMap((entry) => entry.coverage.verdicts.map((v) => v.code)));
    expect(codes.size).toBe(7);
    const statuses = new Set(
      cases.flatMap((entry) => entry.coverage.groups.flatMap((g) => g.lines.map((l) => l.status))),
    );
    expect([...statuses].sort()).toEqual(["EXTRA", "MATCH", "SHORT", "UNPLANNED", "UNSCHEDULED"]);
  });

  it("reaches what the panel must agree on: parity, week 53, parking, extras, names, a split post", () => {
    const lessons = cases.flatMap((c) => c.input.lessons);
    const rows = cases.flatMap((c) => c.input.requirements);
    expect(lessons.some((l) => l.recurrence === "ODD_WEEKS")).toBe(true);
    expect(lessons.some((l) => l.startDate && l.endDate && l.startDate < "2026-12-28" && l.endDate > "2027-01-04")).toBe(true);
    expect(lessons.some((l) => l.isParked)).toBe(true);
    expect(lessons.some((l) => l.extraGroupIds.length > 0)).toBe(true);
    expect(lessons.some((l) => l.studentIds.length > 0)).toBe(true);
    expect(lessons.some((l) => lessonMinutes(l) === 55)).toBe(true);
    expect(rows.some((r) => isMixed(r))).toBe(true);
  });

  it("gives the board, with no pupils, exactly the group lines the server gives with them", () => {
    // The panel passes pupils: [] and includePupils: false (R18). Group lines
    // read no roster, so the board equals the server's group lines for the
    // same rows; only the pupil counts differ.
    const read = cases.find((c) => c.name.includes("read by a teacher"))!;
    const board = cases.find((c) => c.name.includes("on the board"))!;
    const strip = (c: FixtureCase) => c.coverage.groups.map((g) => ({ ...g, pupilCount: 0 }));
    expect(strip(board)).toEqual(strip(read));
    expect(strip({ ...board, coverage: computeScheduledCoverage(board.input) })).toEqual(strip(read));
  });

  it.each(cases.map((entry) => [entry.name, entry] as const))("%s", (_name, entry) => {
    expect(computeScheduledCoverage(entry.input)).toEqual(entry.coverage);
  });
});
