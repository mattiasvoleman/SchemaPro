import type { GradeSpan } from "@/lib/grade-span";
import type { RoomPreference } from "@/lib/queries";

/**
 * Which rooms a subject's lessons may use, for one stage.
 *
 * Mirrors resolve_room_locks in optimization-engine/app/solver/scheduler_solver.py.
 * A second implementation of one rule is a cost paid deliberately, the same way
 * lib/frame-times.ts and lib/lunch-servings.ts pay it: the grid has to say the
 * same thing the solver will, and a warning computed by a different rule than
 * the one that refuses the week is worse than no warning at all.
 *
 * THE NARROWEST SPAN WINS, AND EQUALLY NARROW RULES ARE ALTERNATIVES. Among the
 * locks that reach a lesson, only those of the smallest width survive, and
 * their rooms union. A rule with no span counts as the widest thing there is,
 * so a school's one general rule never overrides the exceptions it wrote.
 *
 * Not intersection: "matte åk 4-6 → Bryggan 3" plus "matte åk 4 → Optimisten 4"
 * would intersect to nothing and make a whole subject × stage impossible from
 * two sentences a school would reasonably write.
 *
 * MATCHING IS CONTAINMENT — the group's whole span inside the rule's. Overlap
 * would let an åk 7-9 rule seize a group spanning 6-7 and send its year-6
 * pupils to a högstadie room.
 */
export function allowedRooms(
  locks: RoomPreference[],
  subjectId: string,
  span: GradeSpan | undefined,
): Set<string> | null {
  const reaching = locks.filter(
    (lock) =>
      lock.kind === "LOCK" &&
      lock.subjectId === subjectId &&
      ruleReaches(lock, span),
  );
  if (reaching.length === 0) return null;

  const narrowest = Math.min(...reaching.map(spanWidth));
  const allowed = new Set<string>();
  for (const lock of reaching) {
    if (spanWidth(lock) !== narrowest) continue;
    for (const entry of lock.rooms) allowed.add(entry.roomId);
  }
  return allowed;
}

function ruleReaches(
  lock: Pick<RoomPreference, "minGradeLevel" | "maxGradeLevel">,
  span: GradeSpan | undefined,
): boolean {
  // No span reaches everything, which is what every rule written before the
  // column existed means.
  if (lock.minGradeLevel === null || lock.maxGradeLevel === null) return true;
  // A group whose years are unknown is reached by no rule that names years:
  // there is nothing to contain, and guessing would sweep every unlabelled
  // group into a rule meant for one stage.
  if (!span) return false;
  return span.min >= lock.minGradeLevel && span.max <= lock.maxGradeLevel;
}

/** How many years a rule covers. No span is the widest thing there is. */
function spanWidth(lock: Pick<RoomPreference, "minGradeLevel" | "maxGradeLevel">): number {
  if (lock.minGradeLevel === null || lock.maxGradeLevel === null) return 14;
  return lock.maxGradeLevel - lock.minGradeLevel + 1;
}

/**
 * Whether a placement sits in a room its locks forbid.
 *
 * A lesson with NO room is not a violation: it has not been put anywhere yet,
 * and reporting it would flag every lesson a school has not finished placing.
 *
 * A lock that resolves to NO rooms — every room it named has since been deleted
 * — is not reported either. The rule is broken rather than the lesson, and
 * saying so on every lesson of the subject would bury the one message that
 * matters. The API refuses to delete a lock's last room for that reason; this
 * is the belt to that pair of braces.
 */
export function breaksRoomLock(
  locks: RoomPreference[],
  subjectId: string,
  span: GradeSpan | undefined,
  roomId: string | null,
): boolean {
  if (roomId === null) return false;
  const allowed = allowedRooms(locks, subjectId, span);
  if (allowed === null || allowed.size === 0) return false;
  return !allowed.has(roomId);
}
