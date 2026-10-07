// Which läsår's groups a picker offers.
//
// useGroups() returns every year's groups, and a group is listed by name. That
// was harmless while a school had one year. From the day a läsår is rolled
// until the day the next is activated, it has two, and every class name is
// there twice — next year's 8A (this year's 7A, promoted) beside this year's
// 8A. A home-class picker that offers both lets an admin put a pupil into the
// wrong cohort with a click that looks right, and activation then counts that
// pupil as already moved. So pickers filter to a year; the name lookups
// (groupName(id) and the like) need nothing, because an id is unique.

import type { AcademicYear, StudentGroup } from "@/lib/types";

/** A läsår's groups, in the order given (useGroups sorts by Swedish name). */
export function groupsOfYear<T extends Pick<StudentGroup, "academicYearId">>(
  groups: readonly T[] | undefined,
  yearId: string | null,
): T[] {
  if (!groups || yearId === null) return [];
  return groups.filter((group) => group.academicYearId === yearId);
}

export interface GroupOption {
  id: string;
  label: string;
}

/**
 * The home classes a pupil can be put in: the active year's CLASS groups.
 *
 * A pupil whose class is elsewhere — in last year's 7A while the activation
 * is still to come, or in a teaching group an old import made their home —
 * keeps that class in the list, so opening their form does not silently
 * change it. It is labelled with its year when the year is not the active
 * one ("8A (2026/27)"), which is the only thing telling it apart from the
 * active year's 8A.
 */
export function homeClassOptions(
  groups: readonly StudentGroup[] | undefined,
  years: readonly Pick<AcademicYear, "id" | "name">[] | undefined,
  activeYearId: string | null,
  currentGroupId: string | null,
): GroupOption[] {
  const options = groupsOfYear(groups, activeYearId)
    .filter((group) => group.kind === "CLASS")
    .map((group) => ({ id: group.id, label: group.name }));
  if (currentGroupId !== null && !options.some((option) => option.id === currentGroupId)) {
    const current = groups?.find((group) => group.id === currentGroupId);
    if (current) {
      const year = years?.find((candidate) => candidate.id === current.academicYearId);
      const label =
        current.academicYearId !== activeYearId && year ? `${current.name} (${year.name})` : current.name;
      options.unshift({ id: current.id, label });
    }
  }
  return options;
}
