import { describe, expect, it } from "vitest";
import {
  buildGroupMemberNames,
  countGroupMembers,
  splitGroupsByKind,
} from "@/lib/group-sections";
import type { StudentGroup } from "@/lib/types";

const group = (
  name: string,
  kind: StudentGroup["kind"],
  gradeLevel: number | null = null,
): StudentGroup => ({
  id: `id-${name}`,
  academicYearId: "year-1",
  name,
  kind,
  gradeLevel,
});

describe("splitGroupsByKind", () => {
  it("puts classes first, then teaching groups", () => {
    const { sections } = splitGroupsByKind(
      [
        group("Ma71", "TEACHING_GROUP"),
        group("7A", "CLASS", 7),
        group("En74", "TEACHING_GROUP", 7),
        group("7B", "CLASS", 7),
      ],
      [],
    );

    expect(sections.map((section) => section.kind)).toEqual([
      "CLASS",
      "TEACHING_GROUP",
    ]);
    expect(sections[0]?.groups.map((g) => g.name)).toEqual(["7A", "7B"]);
    expect(sections[1]?.groups.map((g) => g.name)).toEqual(["Ma71", "En74"]);
  });

  it("classifies by kind, not by whether a grade level happens to be set", () => {
    // En74 is a level group for year 7 and carries a gradeLevel. The old
    // heuristic — "no gradeLevel, so it is a teaching group" — filed it as a
    // class, which is exactly the case this replaces.
    const { sections } = splitGroupsByKind([group("En74", "TEACHING_GROUP", 7)], []);

    expect(sections).toHaveLength(1);
    expect(sections[0]?.kind).toBe("TEACHING_GROUP");
  });

  it("counts members per group", () => {
    const { memberCounts } = splitGroupsByKind(
      [group("Ma71", "TEACHING_GROUP")],
      [
        { studentGroupId: "id-Ma71" },
        { studentGroupId: "id-Ma71" },
        { studentGroupId: "id-other" },
      ],
    );

    expect(memberCounts.get("id-Ma71")).toBe(2);
  });

  it("reports zero for a teaching group nobody has been added to", () => {
    // Worth surfacing rather than hiding: a timplan row for an empty group
    // produces lessons with no students in them.
    const { memberCounts } = splitGroupsByKind(
      [group("Sv73", "TEACHING_GROUP")],
      [],
    );

    expect(memberCounts.get("id-Sv73") ?? 0).toBe(0);
  });

  it("drops a section with nothing in it instead of rendering an empty heading", () => {
    const { sections } = splitGroupsByKind([group("7A", "CLASS", 7)], []);

    expect(sections).toHaveLength(1);
    expect(sections[0]?.kind).toBe("CLASS");
  });

  it("returns nothing at all for a year with no groups", () => {
    expect(splitGroupsByKind([], []).sections).toEqual([]);
  });
});

describe("countGroupMembers", () => {
  it("counts a home class from the students who belong to it", () => {
    const counts = countGroupMembers(
      [{ studentGroupId: "7A" }, { studentGroupId: "7A" }, { studentGroupId: "7B" }],
      [],
    );

    expect(counts.get("7A")).toBe(2);
    expect(counts.get("7B")).toBe(1);
  });

  it("counts a teaching group from its membership rows", () => {
    // The regression this guards: teaching-group members are not home-class
    // members, so counting only the latter showed every imported group as 0.
    const counts = countGroupMembers(
      [],
      [{ studentGroupId: "Ma71" }, { studentGroupId: "Ma71" }],
    );

    expect(counts.get("Ma71")).toBe(2);
  });

  it("counts both kinds in one pass", () => {
    const counts = countGroupMembers(
      [{ studentGroupId: "7A" }],
      [{ studentGroupId: "Ma71" }],
    );

    expect([...counts.entries()].sort()).toEqual([
      ["7A", 1],
      ["Ma71", 1],
    ]);
  });

  it("ignores people with no group at all", () => {
    expect(countGroupMembers([{ studentGroupId: null }], []).size).toBe(0);
  });

  it("reports nothing for a group nobody is in", () => {
    expect(countGroupMembers([], []).get("Sv73")).toBeUndefined();
  });
});

describe("buildGroupMemberNames", () => {
  const alma = {
    id: "st-1",
    firstName: "Alma",
    lastName: "Berg",
    studentGroupId: "7A",
  };
  const nils = {
    id: "st-2",
    firstName: "Nils",
    lastName: "Ek",
    studentGroupId: "7B",
  };

  it("lists a home class's students", () => {
    const names = buildGroupMemberNames([alma, nils], []);

    expect(names.get("7A")).toEqual([{ id: "st-1", name: "Alma Berg" }]);
  });

  it("lists a teaching group's students, so a search can find the group by person", () => {
    const names = buildGroupMemberNames(
      [alma, nils],
      [
        { studentId: "st-1", studentGroupId: "Ma71" },
        { studentId: "st-2", studentGroupId: "Ma71" },
      ],
    );

    expect(names.get("Ma71")?.map((entry) => entry.name)).toEqual([
      "Alma Berg",
      "Nils Ek",
    ]);
  });

  it("puts one student in every group they belong to", () => {
    const names = buildGroupMemberNames(
      [alma],
      [
        { studentId: "st-1", studentGroupId: "Ma71" },
        { studentId: "st-1", studentGroupId: "En74" },
      ],
    );

    expect(names.get("7A")).toHaveLength(1);
    expect(names.get("Ma71")).toHaveLength(1);
    expect(names.get("En74")).toHaveLength(1);
  });

  it("skips a membership whose student is not in the loaded list", () => {
    // Otherwise the group would advertise an "undefined undefined" member,
    // which is both wrong and searchable.
    const names = buildGroupMemberNames([], [
      { studentId: "gone", studentGroupId: "Ma71" },
    ]);

    expect(names.get("Ma71")).toBeUndefined();
  });

  it("leaves a group nobody belongs to out of the index entirely", () => {
    expect(buildGroupMemberNames([], []).size).toBe(0);
  });
});
