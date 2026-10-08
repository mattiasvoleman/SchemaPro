import { describe, expect, it } from "vitest";
import fixture from "../../src/common/__fixtures__/year-rollover-cases.json";
import {
  crossesIsoWeek53,
  dateShiftDays,
  easterSunday,
  mapPeriod,
  nameCollisions,
  promoteName,
  proposeBreak,
  resolveGroups,
  type DayBounds,
  type GroupChoice,
  type RolloverGroupInput,
  averageWeeklyMinutes,
  volumeFindings,
  type VolumeRow,
} from "@/lib/year-rollover";

/**
 * One rollover document, implemented twice, checked against one list of
 * cases — the web half of src/common/year-rollover.contract.spec.ts.
 *
 * The wizard on /admin/years/rollover names next year's groups and marks a
 * collision from this mirror while the admin types; the gateway writes from
 * its own copy. If the two drift, the wizard shows "8A" and the server writes
 * "8A" twice and answers ROLLOVER_NAME_COLLISION — or, worse, the wizard marks
 * a collision the server would have accepted, and the admin renames a class
 * for nothing. The fixture was generated from the GATEWAY copy, so this proves
 * the web arrives at the same names, outcomes, intake twins, collisions
 * (case-only ones included), period statuses and lov proposals, `toEqual` —
 * every value is a string or a small integer, so a mismatch is a different
 * answer.
 *
 * Imported across the package boundary on purpose, as the timplan-coverage
 * and teacher-load contracts are: a copy under web/ would be two files that
 * have to be edited together, which is the drift this test exists to catch.
 */

const source = fixture.source as DayBounds;

describe("the rollover mirror agrees with the gateway's fixture", () => {
  it("covers week 53, jul, påsk, a missing week, INTAKE and bound anchoring", () => {
    // The same guard as the gateway's: a regenerated fixture that lost a
    // case would otherwise pass both sides by proving less.
    expect(fixture.shift.crossesIsoWeek53).toBe(true);
    const anchors = new Set(fixture.breaks.map((row) => row.expected.anchor));
    expect([...anchors].sort()).toEqual(["CHRISTMAS", "EASTER", "ISO_WEEK", "NONE"]);
    const statuses = new Set(fixture.periods.map((row) => row.expected.status));
    expect([...statuses].sort()).toEqual(["BOUND_ANCHORED", "DROPPED", "SHIFTED", "UNCHANGED"]);
    const outcomes = new Set(
      fixture.groups.cases.flatMap((c) => c.resolved.map((row) => row.outcome)),
    );
    expect([...outcomes].sort()).toEqual(["CARRY", "GRADUATE", "INTAKE", "PROMOTE", "SKIP"]);
    expect(new Set(fixture.names.map((row) => row.expected.status)).size).toBe(5);
  });

  it("shifts by the same whole weeks and sees the same week 53", () => {
    expect(dateShiftDays(fixture.shift.sourceStart, fixture.shift.targetStart)).toBe(
      fixture.shift.dateShiftDays,
    );
    expect(crossesIsoWeek53(fixture.shift.sourceStart, fixture.shift.targetStart)).toBe(
      fixture.shift.crossesIsoWeek53,
    );
  });

  it.each(fixture.names.map((row) => [row.name, row.gradeLevel, row] as const))(
    "names %s in åk %s the same way",
    (_name, _grade, row) => {
      expect(promoteName(row.name, row.gradeLevel)).toEqual(row.expected);
    },
  );

  it.each(fixture.groups.cases.map((c) => [c.name, c] as const))(
    "resolves the groups for %s, collisions included",
    (_name, c) => {
      const choices = new Map(Object.entries(c.choices) as [string, GroupChoice][]);
      const resolved = resolveGroups(
        fixture.groups.input as RolloverGroupInput[],
        c.graduatingGradeLevel,
        { carryTeachingGroups: c.carryTeachingGroups },
        choices,
      );
      expect(resolved).toEqual(c.resolved);
      expect(nameCollisions(resolved)).toEqual(c.collisions);
    },
  );

  it.each(fixture.periods.map((row) => [row.startDate, row.endDate, row] as const))(
    "maps the period %s – %s the same way",
    (_start, _end, row) => {
      expect(
        mapPeriod(
          row.startDate,
          row.endDate,
          source,
          row.target,
          dateShiftDays(source.startDate, row.target.startDate),
        ),
      ).toEqual(row.expected);
    },
  );

  it.each(fixture.breaks.map((row) => [row.lov.startDate, row] as const))(
    "proposes the same dates for the lov starting %s",
    (_start, row) => {
      expect(proposeBreak(row.lov, source, row.target)).toEqual(row.expected);
    },
  );

  it("dates Easter the same way", () => {
    for (const row of fixture.easter) expect(easterSunday(row.year)).toBe(row.sunday);
  });

  // The volume check against the plan: a split row's week is its lessons'
  // minutes (1 × 80 + 1 × 40 is 120), every week, odd weeks and one term.
  it.each(fixture.volume.rows.map((row) => [row.name, row] as const))(
    "averages the week of %s the same way",
    (_name, row) => {
      expect(averageWeeklyMinutes(row as VolumeRow, fixture.volume.year)).toBe(
        row.averageWeeklyMinutes,
      );
    },
  );

  it("finds the same volume differences, split rows counted by their lengths", () => {
    expect(fixture.volume.rows.some((row) => row.lessonLengths.length > 0)).toBe(true);
    expect(
      volumeFindings(
        fixture.volume.rows as VolumeRow[],
        new Map(Object.entries(fixture.volume.planned)),
        fixture.volume.year,
      ),
    ).toEqual(fixture.volume.findings);
  });
});
