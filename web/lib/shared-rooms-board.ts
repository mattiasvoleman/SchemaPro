// DELADE SALAR on the board (Placeringsregel 3): the check's answer, built from
// what the page holds.
//
// lib/shared-rooms.ts says when two lessons in one room are no clash; this
// file hands that answer to validatePlacement (lib/conflicts.ts), which asks it
// through the relation it already takes (GroupConflictMap.shared), so the
// board draws a timetable the generator laid with two classes in a shared hall
// without a red ring, and lets a lesson be dragged in time while it stands there.
//
// LOADED ON DEMAND, and that is the point of it being its own file: the page
// fetches it (import()) only when the school's Skolregler hold the rule on, so
// the schools that never do pay no byte for it, and /admin/timetable, which
// sits a few hundred bytes under the bundle gate, does not grow by its code.
// Until it has arrived every room is exclusive, which is the safe reading.

import { overlaps, weeksCanOverlap, type GroupConflictMap, type Placement } from "@/lib/conflicts";
import { attendeesOf, type RosterIndex } from "@/lib/lesson-audience";
import {
  crowdedWith,
  sharedSeatsByRoom,
  type SharedRoomFacts,
  type SharedRoomMode,
} from "@/lib/shared-rooms";

/**
 * The relation with the shared-rooms check laid on it: a copy, so a change of
 * rooms, rule or class lists gives the page's memos a new relation to react to.
 * Returned as it came when no room qualifies (not marked, no capacity, rule off).
 *
 * `index` is the page's roster index (buildRosterIndex): who sits in a lesson is
 * its groups' pupils and the pupils named on it, once each, less those a
 * replacing group takes off. A lesson with none known (class lists still on
 * their way, a class nobody has imported) keeps the room exclusive.
 */
export function withSharedRooms(
  relation: GroupConflictMap,
  rooms: Iterable<SharedRoomFacts>,
  mode: SharedRoomMode | null | undefined,
  index: RosterIndex,
): GroupConflictMap {
  const seats = sharedSeatsByRoom(mode, rooms);
  if (seats.size === 0) return relation;

  const occupant = (placement: Placement) => ({
    start: placement.startMinutes,
    end: placement.endMinutes,
    recurrence: placement.recurrence,
    pupils: attendeesOf(
      {
        studentGroupId: placement.studentGroupId,
        extraGroupIds: placement.extraGroupIds ?? [],
        studentIds: placement.studentIds ?? [],
        subjectId: placement.subjectId,
      },
      index,
    ),
  });

  const shared: NonNullable<GroupConflictMap["shared"]> = (candidate, others) => {
    const room = candidate.roomId === null ? undefined : seats.get(candidate.roomId);
    if (room === undefined) return undefined;
    // The lessons in the candidate's room at the same time, in weeks that meet:
    // asked of all of them at once, never pair by pair, because two classes can
    // fit a hall that three do not.
    const mates = others.filter(
      (mate) =>
        !(candidate.id !== null && mate.id === candidate.id) &&
        mate.dayOfWeek === candidate.dayOfWeek &&
        mate.roomId === candidate.roomId &&
        overlaps(candidate.startMinutes, candidate.endMinutes, mate.startMinutes, mate.endMinutes) &&
        weeksCanOverlap(candidate, mate),
    );
    const crowded = crowdedWith(room, occupant(candidate), mates.map(occupant));
    return new Set(mates.filter((_, position) => !crowded.has(position)));
  };

  return Object.assign(new Map(relation), { replacing: relation.replacing, shared });
}
