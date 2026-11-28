import type { RoomFact } from '../calendar/possible-times';
import type { RoomNeeds } from '../optimization/room-eligibility';

/*
 * ANNAN LEDIG SAL AND THE SCHOOL'S ROOM LOCKS (RoomPreference of kind LOCK).
 *
 * "The rooms the generator would put this lesson in" is two rules, not one: `roomAllowed` (the seats, the type the subject needs, the years the
 * room is fenced to: calendar/possible-times.ts) AND the school's LOCK rules, which say that a subject's lessons, in some years, may be in these
 * rooms and no others ("åk 4:s matte är i Optimisten 4"; scheduler_solver.py `resolve_room_locks`, folded into `_room_allowed` by `_lock_aware`).
 * The room optimisation keeps to both ("a lesson may only MOVE into a room the generator itself would have placed it in"). A room chosen for a
 * lesson by roomAllowed alone can be a room the generator would never use for it, and `apply` writes it and locks the lesson there.
 *
 * This is the engine's own resolution, written once more here for the swap search: the locks that reach a lesson are those of its subject whose
 * years CONTAIN the lesson's whole span (a rule with no years reaches every year; a rule with years does not reach a group whose years are
 * unknown); the NARROWEST span wins; equally narrow rules are alternatives and their rooms UNION; a rule names either a room type (every room of
 * it) or rooms. No rule reaches: null, the lesson is not locked to any rooms.
 */

/** One RoomPreference of kind LOCK. */
export interface RoomLockRule {
  subjectId: string;
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
  roomTypeId: string | null;
  roomIds: readonly string[];
}

/** One more than the widest span there is (0-12), so that a rule without years loses every tie to a rule with some. */
const NO_SPAN = 14;

const widthOf = (rule: RoomLockRule): number => (rule.minGradeLevel === null || rule.maxGradeLevel === null ? NO_SPAN : rule.maxGradeLevel - rule.minGradeLevel + 1);

function reaches(rule: RoomLockRule, needs: Pick<RoomNeeds, 'minGradeLevel' | 'maxGradeLevel'>): boolean {
  if (rule.minGradeLevel === null || rule.maxGradeLevel === null) return true;
  if (needs.minGradeLevel === null || needs.maxGradeLevel === null) return false;
  return needs.minGradeLevel >= rule.minGradeLevel && needs.maxGradeLevel <= rule.maxGradeLevel;
}

/** The only rooms the school's LOCK rules let a lesson of this subject and these years stand in, or null when none reaches it. */
export function lockedRoomsOf(
  rules: readonly RoomLockRule[],
  rooms: readonly Pick<RoomFact, 'id' | 'roomTypeId'>[],
  subjectId: string,
  needs: Pick<RoomNeeds, 'minGradeLevel' | 'maxGradeLevel'>,
): ReadonlySet<string> | null {
  const reaching = rules.filter((rule) => rule.subjectId === subjectId && reaches(rule, needs));
  if (reaching.length === 0) return null;
  const narrowest = Math.min(...reaching.map(widthOf));
  const allowed = new Set<string>();
  for (const rule of reaching) {
    if (widthOf(rule) !== narrowest) continue;
    if (rule.roomTypeId !== null) {
      for (const room of rooms) if (room.roomTypeId === rule.roomTypeId) allowed.add(room.id);
    } else {
      for (const id of rule.roomIds) allowed.add(id);
    }
  }
  return allowed;
}
