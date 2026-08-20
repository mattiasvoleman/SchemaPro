import type { StudentGroup, StudentGroupKind } from "@/lib/types";

export interface GroupSection {
  kind: StudentGroupKind;
  groups: StudentGroup[];
}

export interface GroupSectionsResult {
  sections: GroupSection[];
  /** Cross-class members per group id; a teaching group with 0 cannot be scheduled. */
  memberCounts: Map<string, number>;
}

/**
 * Splits a year's groups into classes and teaching groups, with the member
 * count each teaching group carries.
 *
 * The timplan used to render one alphabetical list, where "7A" sat next to
 * "Ma71" with nothing to tell them apart — and a teaching group whose members
 * were never added looked exactly like one ready to schedule. Classes come
 * first because that is the order a school fills the timplan in.
 *
 * An empty section is dropped rather than rendered as a heading with nothing
 * under it.
 */
export function splitGroupsByKind(
  groups: StudentGroup[],
  memberships: { studentGroupId: string }[],
): GroupSectionsResult {
  const memberCounts = new Map<string, number>();
  for (const row of memberships) {
    memberCounts.set(
      row.studentGroupId,
      (memberCounts.get(row.studentGroupId) ?? 0) + 1,
    );
  }

  const sections: GroupSection[] = [];
  for (const kind of ["CLASS", "TEACHING_GROUP"] as const) {
    const matching = groups.filter((group) => group.kind === kind);
    if (matching.length > 0) sections.push({ kind, groups: matching });
  }

  return { sections, memberCounts };
}

/**
 * How many students a group holds, counted from the right place for its kind.
 *
 * The two live apart: a home class is what `Users.studentGroupId` points at,
 * while a teaching group's students are rows in StudentGroupMembers. Counting
 * only the first is why every imported teaching group read "0 students" and
 * looked empty even with 5400 memberships behind it.
 */
export function countGroupMembers(
  people: { studentGroupId: string | null }[],
  memberships: { studentGroupId: string }[],
): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (groupId: string) =>
    counts.set(groupId, (counts.get(groupId) ?? 0) + 1);

  for (const person of people) {
    if (person.studentGroupId) add(person.studentGroupId);
  }
  for (const row of memberships) add(row.studentGroupId);

  return counts;
}
