import { describe, expect, it } from "vitest";
import { splitGroupsByKind } from "@/lib/group-sections";
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
