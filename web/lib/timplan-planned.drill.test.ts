import { describe, expect, it } from "vitest";
import fixture from "../../src/common/__fixtures__/timplan-planned-cases.json";
import {
  computePlannedCoverage,
  type PlannedCoverage,
  type PlannedCoverageInput,
  type PlannedPupil,
} from "@/lib/timplan-planned";

/**
 * The planned layer's drill-down (drillGroupId) in the browser's mirror, as
 * src/common/timplan-planned.drill.spec.ts has it on the gateway: every pupil
 * of one class with every line, where the overview lists only the pupils with
 * a finding of their own. The panel behind "Visa alla elever" shows what the
 * gateway sends; this keeps the mirror's answer the same one, so the two
 * cannot drift on the one option the fixture does not carry.
 */

interface FixtureCase {
  name: string;
  input: PlannedCoverageInput;
  coverage: PlannedCoverage;
}

const { cases } = fixture as unknown as { cases: FixtureCase[] };
const withPupils = cases.filter((entry) => entry.input.includePupils && entry.input.pupils.length > 0);

/** min / median / max / below of a line over the pupils, re-derived from the drilled lines alone. */
function figuresOf(pupils: PlannedPupil[], key: string, target: number | null) {
  const values = pupils
    .map((pupil) => pupil.lines.find((line) => line.key === key)?.plannedMinutesPerWeek ?? 0)
    .sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return {
    min: values[0]!,
    median: values.length % 2 === 1 ? values[middle]! : Math.round((values[middle - 1]! + values[middle]!) / 2),
    max: values[values.length - 1]!,
    below: target === null ? 0 : values.filter((value) => value < target).length,
  };
}

describe("the planned layer's drill-down agrees with the overview, in the mirror", () => {
  it("has cases with pupils to drill into", () => {
    expect(withPupils.length).toBeGreaterThanOrEqual(40);
  });

  it.each(withPupils.map((entry) => [entry.name, entry] as const))("figures every class of: %s", (_name, entry) => {
    const overview = computePlannedCoverage(entry.input);
    for (const summary of overview.groups) {
      const drilled = computePlannedCoverage({ ...entry.input, drillGroupId: summary.studentGroupId });
      const ofClass = (drilled.pupils ?? []).filter((pupil) => pupil.homeGroupId === summary.studentGroupId);
      expect(ofClass).toHaveLength(summary.pupilCount);
      for (const line of summary.lines) {
        if (line.pupils === undefined) continue;
        expect({ line: line.key, ...figuresOf(ofClass, line.key, line.targetMinutesPerWeek) }).toEqual({
          line: line.key,
          ...line.pupils,
        });
      }
      // Nothing but the pupil list moves, and the other classes are listed as before.
      expect({ ...drilled, pupils: null }).toEqual({ ...overview, pupils: null });
      const others = (list: PlannedPupil[] | null) =>
        (list ?? []).filter((pupil) => pupil.homeGroupId !== summary.studentGroupId);
      expect(others(drilled.pupils)).toEqual(others(overview.pupils));
    }
  });

  it.each(cases.filter((entry) => entry.input.pupils.length > 0).map((entry) => [entry.name, entry] as const))(
    "gives a teacher's read no pupil by being asked for a class: %s",
    (_name, entry) => {
      const teacher = { ...entry.input, includePupils: false };
      const classId = entry.input.groups.find((group) => group.kind === "CLASS")?.id ?? null;
      const asked = computePlannedCoverage({ ...teacher, drillGroupId: classId });
      expect(asked).toEqual(computePlannedCoverage(teacher));
      expect(asked.pupils).toBeNull();
    },
  );

  it("lists a pupil who is short because the class is short, whom the overview only counts", () => {
    // 8A plans Matematik 120 of 180: all three pupils are under, the class says so, none has a finding of their own.
    const MA = "00000000-0000-4000-8000-000000000101";
    const A8 = "00000000-0000-4000-8000-000000000301";
    const input: PlannedCoverageInput = {
      year: { startDate: "2026-08-17", endDate: "2027-06-11" },
      closures: [],
      plans: [
        {
          id: "00000000-0000-4000-8000-000000000201",
          name: "Grundskolan 2024",
          status: "DECIDED",
          entries: [{ subjectId: MA, gradeLevel: 8, minutesPerWeek: 180 }],
        },
      ],
      attachments: [{ gradeLevel: 8, localTimplanId: "00000000-0000-4000-8000-000000000201" }],
      subjects: [{ id: MA, name: "Matematik", nationalCode: "MA", countsTowardTimplan: true }],
      groups: [{ id: A8, name: "8A", kind: "CLASS", gradeLevel: 8 }],
      requirements: [
        { id: "r1", studentGroupId: A8, subjectId: MA, lessonsPerWeek: 2, minutesPerLesson: 60, recurrence: "ALL_WEEKS", startDate: null, endDate: null },
      ],
      pupils: [1, 2, 3].map((n) => ({ id: `00000000-0000-4000-8000-00000000040${n}`, homeGroupId: A8, groupIds: [] })),
      includePupils: true,
    };
    expect(computePlannedCoverage(input)).toMatchObject({ pupils: [], pupilsBelowTarget: 3 });
    const drilled = computePlannedCoverage({ ...input, drillGroupId: A8 });
    expect(drilled.pupils).toHaveLength(3);
    for (const pupil of drilled.pupils ?? []) {
      expect(pupil.lines).toEqual([
        expect.objectContaining({
          targetMinutesPerWeek: 180,
          plannedMinutesPerWeek: 120,
          status: "UNDER",
          sources: [{ studentGroupId: A8, subjectId: MA, minutesPerWeek: 120 }],
        }),
      ]);
    }
  });
});
