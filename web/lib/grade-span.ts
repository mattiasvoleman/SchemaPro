/**
 * Which school years a group actually holds.
 *
 * A rule written as "åk 4" has to reach the groups those pupils sit in, and a
 * teaching group carries no year of its own: `4sl1` is a slöjd half of a class,
 * and `StudentGroup.gradeLevel` on it is null. Its year is a property of its
 * MEMBERS, so it has to be derived rather than read.
 *
 * The same derivation already exists on the server, inside
 * OptimizationProxyService, which is how the engine can say "years 4-4" about a
 * group the database calls year-less. It was never written on this side, which
 * is why `conflicts.ts` and `gaps.ts` silently ignored every GRADE_LEVEL rule:
 * they match a constraint by `userId`, `roomId` or `studentGroupId`, and a year
 * rule names none of them. The solver refused to place åk 4 at 16:00 while the
 * timetable let you drag a lesson there by hand and the gap search called the
 * slot free.
 *
 * Kept separate from both so the two cannot drift, and written to give the same
 * answers as the server's copy — including the order of the fallbacks, which is
 * the part that decides what happens to a group with no members yet.
 */

export interface GradeSpan {
  min: number;
  max: number;
}

export interface GradeSpanInput {
  /** Every group that can appear on a lesson, with its own year where it has one. */
  groups: Array<{ id: string; gradeLevel: number | null }>;
  /** groupId → the ids of its members. */
  membersByGroup: Map<string, readonly string[]>;
  /** studentId → their home class, which is where a year actually lives. */
  homeClassOf: Map<string, string | null>;
}

/**
 * A span per group, or no entry where no year can be established.
 *
 * MEMBERS FIRST, THEN THE GROUP'S OWN YEAR. A class carries its year directly
 * and usually has members of exactly that year, so the two agree. A teaching
 * group has no year and its members decide. The order matters for the case
 * where they disagree — a class whose roll has drifted — and the members are
 * the ones sitting in the room.
 *
 * A group with neither is left OUT rather than given a default. The server does
 * the same, with the same reasoning: a year rule that reached a group whose
 * year nobody knows would be a guess, and the guess would silently forbid
 * lessons. Absent, the group is simply not reached by year rules, which is
 * visible — the lesson is placed and somebody notices it should not have been.
 */
export function buildGradeSpans({
  groups,
  membersByGroup,
  homeClassOf,
}: GradeSpanInput): Map<string, GradeSpan> {
  const ownGrade = new Map(groups.map((group) => [group.id, group.gradeLevel]));
  const spans = new Map<string, GradeSpan>();

  for (const group of groups) {
    const grades: number[] = [];
    for (const studentId of membersByGroup.get(group.id) ?? []) {
      const homeClass = homeClassOf.get(studentId);
      const grade = homeClass ? ownGrade.get(homeClass) : null;
      if (typeof grade === "number") grades.push(grade);
    }
    if (grades.length === 0 && typeof group.gradeLevel === "number") {
      grades.push(group.gradeLevel);
    }
    if (grades.length > 0) {
      spans.set(group.id, { min: Math.min(...grades), max: Math.max(...grades) });
    }
  }

  return spans;
}

/**
 * Does a year rule reach a group?
 *
 * OVERLAP, not containment: a rule for åk 4-6 reaches a group spanning 6-7,
 * because some of its pupils are in it and they cannot be in two places. The
 * engine reads it the same way. A null bound is open at that end.
 */
export function spanMeetsRule(
  span: GradeSpan | undefined,
  rule: { minGradeLevel: number | null; maxGradeLevel: number | null },
): boolean {
  if (!span) return false;
  if (rule.minGradeLevel !== null && span.max < rule.minGradeLevel) return false;
  if (rule.maxGradeLevel !== null && span.min > rule.maxGradeLevel) return false;
  return true;
}
