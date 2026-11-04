// Täckning → Planerat, "Visa alla elever" — the gateway's per-class pupil read
// laid out for the panel that shows it.
//
// GET /timplan-coverage/planned/pupils is computed on the gateway from
// src/common/timplan-planned.ts, the arithmetic the overview's table is made
// of; nothing here computes a minute. What is here is how the pupils are
// ordered, found by name, and how a group a pupil's minutes come from is told
// apart (class, half, teaching group, replacing group) — and it imports types
// only, so none of it is in the route's own bundle until the panel is chosen.

import { filterByQuery } from "@/lib/search";
import { compareSwedish } from "@/lib/sorting";
import type { NamedPupil, PlannedClassPupil, PlannedPupilFigure } from "@/lib/timplan-tackning";
import type { StudentGroup } from "@/lib/types";

/** What a group a pupil's minutes come from is. */
export type SourceKind = "class" | "half" | "teaching" | "replacing";

/**
 * A class is a class; a group that is a half of one (Dela klassen) is a half
 * before it is anything else; a group that replaces a subject (SvA7) is a
 * replacing group; every other teaching group is a teaching group. Null for a
 * group the page does not hold (a past year's, or deleted since).
 */
export function sourceKindOf(
  group: Pick<StudentGroup, "kind" | "halfOfId" | "replacesSubjectId"> | undefined,
): SourceKind | null {
  if (!group) return null;
  if (group.kind === "CLASS") return "class";
  if (group.halfOfId) return "half";
  if (group.replacesSubjectId) return "replacing";
  return "teaching";
}

/** The lines the pupil is under target on. */
export function linesUnderTarget(pupil: PlannedClassPupil): PlannedPupilFigure[] {
  return pupil.lines.filter((line) => line.status === "UNDER");
}

/**
 * The pupils of the class the name filter leaves, in the order the overview's
 * own list keeps: surname, then given name, in Swedish order, and a pupil the
 * roster does not hold last. The filter is the admin lists' (lib/search.ts):
 * every term somewhere in the name, in any order.
 */
export function shownPupils(
  pupils: readonly PlannedClassPupil[],
  people: readonly NamedPupil[],
  query: string,
): PlannedClassPupil[] {
  const person = new Map(people.map((entry) => [entry.id, entry]));
  const fullName = (id: string) => {
    const entry = person.get(id);
    return entry ? `${entry.firstName} ${entry.lastName}` : null;
  };
  const sortKey = (id: string) => {
    const entry = person.get(id);
    return entry ? `${entry.lastName} ${entry.firstName}` : "\uffff";
  };
  return filterByQuery([...pupils], query, (pupil) => [fullName(pupil.pupilId)]).sort((a, b) =>
    compareSwedish(sortKey(a.pupilId), sortKey(b.pupilId)),
  );
}
