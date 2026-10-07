import { describe, expect, it } from "vitest";
import {
  isProjectable,
  planningChoices,
  withProjectedHomes,
  YEAR_ROSTERS_KEY,
} from "@/lib/projected-rosters";
import type { AcademicYear, YearRosters } from "@/lib/types";

const year = (id: string, overrides: Partial<AcademicYear> = {}): AcademicYear =>
  ({
    id,
    name: id,
    startDate: "2026-08-17",
    endDate: "2027-06-11",
    isActive: false,
    predecessorId: null,
    graduatingGradeLevel: null,
    ...overrides,
  }) as AcademicYear;

const A = year("A", { isActive: true });
const B = year("B", { predecessorId: "A", startDate: "2027-08-16" });
/** Inserted after B through PostgREST: two steps ahead, refused until B is active (R6). */
const C = year("C", { predecessorId: "B", startDate: "2028-08-14" });
const OLD = year("OLD", { startDate: "2025-08-18" });

const person = (id: string, studentGroupId: string | null, role = "STUDENT", isActive = true) => ({
  id,
  role,
  isActive,
  studentGroupId,
});

const rosters = (homeClasses: YearRosters["homeClasses"], basis: YearRosters["basis"] = "PROJECTED") =>
  ({
    academicYearId: "B",
    basis,
    homeClasses,
    counts: { moved: 0, graduates: 0, unplaced: 0 },
    membershipsOutOfDate: { missing: 0, stale: 0 },
  }) satisfies YearRosters;

describe("withProjectedHomes", () => {
  const people = [
    person("t-1", null, "TEACHER"),
    person("p-moves", "a-7a"),
    person("p-graduates", "a-9a"),
    person("p-already", "b-8a"),
    person("p-inactive", "a-7a", "STUDENT", false),
  ];

  it("gives each pupil in the list the class the server sent, and null to one who leaves", () => {
    const overlaid = withProjectedHomes(
      people,
      rosters([
        { studentId: "p-graduates", studentGroupId: null },
        { studentId: "p-moves", studentGroupId: "b-8a" },
      ]),
    )!;

    expect(Object.fromEntries(overlaid.map((p) => [p.id, p.studentGroupId]))).toEqual({
      "t-1": null,
      "p-moves": "b-8a",
      "p-graduates": null,
      // Not in the list: kept as they are, exactly as the activation keeps them.
      "p-already": "b-8a",
      "p-inactive": "a-7a",
    });
  });

  it("changes nothing but the home class, and leaves the rows it does not touch as they were", () => {
    const overlaid = withProjectedHomes(people, rosters([{ studentId: "p-moves", studentGroupId: "b-8a" }]))!;

    expect(overlaid[1]).toEqual({ ...people[1], studentGroupId: "b-8a" });
    expect(overlaid[0]).toBe(people[0]);
    expect(people[1].studentGroupId).toBe("a-7a");
  });

  it("returns the very same array when there is nothing to lay over", () => {
    expect(withProjectedHomes(people, null)).toBe(people);
    expect(withProjectedHomes(people, undefined)).toBe(people);
    expect(withProjectedHomes(people, rosters([], "CURRENT"))).toBe(people);
    expect(withProjectedHomes(people, rosters([]))).toBe(people);
    expect(withProjectedHomes(undefined, rosters([{ studentId: "p-moves", studentGroupId: "b-8a" }]))).toBe(
      undefined,
    );
  });

  it("lays nothing over from a CURRENT answer, whatever it carries", () => {
    const current = rosters([{ studentId: "p-moves", studentGroupId: "b-8a" }], "CURRENT");
    expect(withProjectedHomes(people, current)).toBe(people);
  });
});

describe("which years a planning page offers", () => {
  it("is the active year and the year rolled from it, while that one is not active", () => {
    expect(planningChoices([OLD, A, B])).toEqual({ active: A, successor: B });
  });

  it("offers no year two steps ahead: the gateway refuses it until its predecessor is active", () => {
    expect(planningChoices([A, B, C]).successor).toBe(B);
    expect(planningChoices([A, C]).successor).toBeNull();
  });

  it("offers nothing to plan ahead of a school with no active year", () => {
    expect(planningChoices([B, C])).toEqual({ active: null, successor: null });
    expect(planningChoices(undefined)).toEqual({ active: null, successor: null });
  });

  it("asks the gateway for rosters only for the year it projects", () => {
    expect(isProjectable(B, A)).toBe(true);
    expect(isProjectable(A, A)).toBe(false);
    expect(isProjectable(C, A)).toBe(false);
    expect(isProjectable(OLD, A)).toBe(false);
    expect(isProjectable(B, null)).toBe(false);
    expect(isProjectable(null, A)).toBe(false);
  });

  it("keys the rosters under the people list, so every write that stales it stales them", () => {
    expect(YEAR_ROSTERS_KEY.slice(0, 1)).toEqual(["people"]);
  });
});
