import { describe, expect, it } from "vitest";
import { groupsOfYear, homeClassOptions } from "@/lib/year-scope";
import type { StudentGroup } from "@/lib/types";

const years = [
  { id: "y26", name: "2026/27" },
  { id: "y27", name: "2027/28" },
];

/** The two years between a rollover and the activation: "8A" twice. */
const groups: StudentGroup[] = [
  { id: "g26-7a", academicYearId: "y26", name: "7A", kind: "CLASS", gradeLevel: 7 },
  { id: "g26-8a", academicYearId: "y26", name: "8A", kind: "CLASS", gradeLevel: 8 },
  { id: "g26-ma7", academicYearId: "y26", name: "Ma7", kind: "TEACHING_GROUP", gradeLevel: 7 },
  { id: "g27-8a", academicYearId: "y27", name: "8A", kind: "CLASS", gradeLevel: 8 },
  { id: "g27-9a", academicYearId: "y27", name: "9A", kind: "CLASS", gradeLevel: 9 },
];

describe("groupsOfYear", () => {
  it("keeps one year's groups and nothing while the year is unknown", () => {
    expect(groupsOfYear(groups, "y27").map((group) => group.id)).toEqual(["g27-8a", "g27-9a"]);
    expect(groupsOfYear(groups, null)).toEqual([]);
    expect(groupsOfYear(undefined, "y27")).toEqual([]);
  });
});

describe("homeClassOptions", () => {
  it("offers the active year's classes only — one 8A, and no teaching group", () => {
    expect(homeClassOptions(groups, years, "y26", null)).toEqual([
      { id: "g26-7a", label: "7A" },
      { id: "g26-8a", label: "8A" },
    ]);
  });

  it("keeps a pupil's class from another year, named with its year", () => {
    // After activation of 2027/28, a pupil the move missed still sits in
    // 2026/27's 8A: shown, and told apart from 2027/28's 8A.
    expect(homeClassOptions(groups, years, "y27", "g26-8a")).toEqual([
      { id: "g26-8a", label: "8A (2026/27)" },
      { id: "g27-8a", label: "8A" },
      { id: "g27-9a", label: "9A" },
    ]);
  });

  it("keeps a teaching group someone made a pupil's home, without a year label in its own year", () => {
    expect(homeClassOptions(groups, years, "y26", "g26-ma7")[0]).toEqual({ id: "g26-ma7", label: "Ma7" });
  });

  it("does not invent an option for a class it cannot see", () => {
    expect(homeClassOptions(groups, years, "y26", "gone")).toHaveLength(2);
  });
});
