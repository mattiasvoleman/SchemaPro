import { roomsByFit, type PossibleWorld } from '../calendar/possible-times';
import type { RoomNeeds } from '../optimization/room-eligibility';
import type { Landing } from './swap-context';
import type { MakeRoomWay, MakeRoomWorld, Placement } from './swap-make-room';
import type { SwapLesson, SwapSlot, SwapUnit } from './swap-types';

/*
 * E5a, ANNAN LEDIG SAL: THE ROOM A LESSON TAKES WHEN ITS OWN IS HELD.
 *
 * Gör plats (swap-make-room.ts) asks the school one thing of every landing: what stands in its way. A lesson that moves to another time
 * leaves its room behind and asks for the same room at the new time, and when another lesson holds that room then, the search had one
 * answer: that lesson has to go too. Often it need not. The school has other rooms, and one of them fits (the generator's own rule for what
 * fits, room-eligibility: the seats, the type the subject needs, the years) and is free at that time. This is the world's answer to the
 * search: the SAME landing, in that room, with the holders of the own room no longer in the way.
 *
 * THE RULE, said once, which swap-rooms.spec.ts holds against a plain reading of the school and swap-make-room.rooms.spec.ts against an
 * exhaustive check of what the search does with it:
 *
 *   1. It is offered to a unit of ONE lesson that stands in a room. A block's lessons keep the rooms the school gave them: they move as
 *      one and a room for each is not a choice to make for them (E3 draws the same line: possible-times.ts, `single`).
 *   2. It is offered only when the room is the trouble: the lesson's teachers, its classes and every weekly row and board rule that does
 *      not name the room leave the stretch alone, and the own room is held there by a lesson (that is not already in the way for its
 *      teacher or class) or shut by a row or by another school. Where something else shuts the stretch another room does not help.
 *   3. The room is the BEST that fits and is free, in the generator's order (its own kind, the smallest that is big enough, its own building), and one
 *      the school's LOCK rules for the lesson's subject and years allow (swap-room-locks.ts):
 *      one room per landing and not every room that would do, so that a landing is two ways at most, and the list a person reads is not
 *      the same times over again in every room of the school. Free is as the school stood: no lesson of the school is in it then, no row
 *      or hold shuts it. A room the school lets several lessons share is not called held by the prune, and the judge counts its pupils.
 *   4. It is a second way to the landing and not a replacement for the first, so a lesson whose room is held only by a lesson that moves
 *      anyway keeps its room (a swap of two lessons in one room is a swap and not a swap with a room change). Of two proposals that
 *      differ only in the rooms, the search offers the one that changes fewest.
 *
 * What it does not do, and says so: a lesson that stays where it stands and changes room so that another may have its own (it would be a
 * move of its own, a unit that lands where it stands); a room that a lesson leaves in the same proposal (free is as the school stood); more
 * than one room per landing.
 */

/**
 * The facts a landing's rooms are asked with: E3's world (the snapshot indexed, the rooms, what a lesson needs of one), and the rooms the school's
 * LOCK rules leave a lesson (swap-room-locks.ts: the generator keeps to them too). Absent: no lesson is locked to rooms.
 */
export type RoomWorld = Pick<PossibleWorld, 'context' | 'rooms' | 'needsOf'> & {
  lockedRoomsOf?: (lesson: SwapLesson, needs: RoomNeeds) => ReadonlySet<string> | null;
};

export function makeRoomWorldOf(world: RoomWorld, options: { otherRooms?: boolean } = {}): MakeRoomWorld {
  const { context } = world;
  // The school as it stood does not change while a question is answered, and the search asks the same landing from every branch.
  const standing = new Map<string, MakeRoomWay>();
  const another = new Map<string, MakeRoomWay | null>();
  const keyOf = (unit: SwapUnit, to: SwapSlot): string => `${unit.id}|${to.dayOfWeek}|${to.startMinutes}`;
  const vacatingOf = (unit: SwapUnit): Set<string> => new Set(unit.members.map((member) => member.id));

  const inTheWay = (unit: SwapUnit, to: SwapSlot): MakeRoomWay => {
    const key = keyOf(unit, to);
    const known = standing.get(key);
    if (known) return known;
    const vacating = vacatingOf(unit);
    const lessons = new Map<string, MakeRoomWay['lessons'][number]>();
    let closed = false;
    for (const landing of context.landingsOf(unit, to)) {
      const way = context.inTheWay(landing, vacating);
      for (const other of way.lessons) lessons.set(other.id, other);
      if (way.closures.length > 0 || context.boardRefusal(landing) !== null) closed = true;
    }
    const made = { lessons: [...lessons.values()], closed };
    standing.set(key, made);
    return made;
  };

  const otherRoom = (unit: SwapUnit, to: SwapSlot): MakeRoomWay | undefined => {
    if (unit.members.length !== 1) return undefined;
    const key = keyOf(unit, to);
    const known = another.get(key);
    if (known !== undefined) return known ?? undefined;
    const made = anotherRoomFor(world, unit, to, vacatingOf(unit));
    another.set(key, made ?? null);
    return made;
  };

  const withRooms = (placement: Placement): Landing[] =>
    context.landingsOf(placement.unit, placement.to).map((landing) => {
      const room = placement.rooms?.get(landing.lesson.id);
      return room === undefined ? landing : { lesson: { ...landing.lesson, roomId: room }, to: landing.to };
    });

  return {
    inTheWay,
    // Asked for, or every lesson keeps its room, as Gör plats answered before the rooms (a page that cannot send a room change back must not be offered one).
    ...(options.otherRooms === true ? { otherRoom } : {}),
    landingsClash: (a, b) => withRooms(a).some((left) => withRooms(b).some((right) => context.landingsClash(left, right))),
  };
}

/** The landing of a one-lesson unit in the best other room that fits and is free then, when its own is the trouble; else undefined. */
function anotherRoomFor(world: RoomWorld, unit: SwapUnit, to: SwapSlot, vacating: ReadonlySet<string>): MakeRoomWay | undefined {
  const { context } = world;
  const landing = context.landingsOf(unit, to)[0]!;
  const own = landing.lesson.roomId;
  if (own === null) return undefined;

  // Without the room: the teachers, the classes and every rule that does not name it. Whatever shuts the stretch here no room opens.
  const bareLanding: Landing = { lesson: { ...landing.lesson, roomId: null }, to: landing.to };
  const bare = context.inTheWay(bareLanding, vacating);
  if (bare.closures.length > 0 || context.boardRefusal(bareLanding) !== null) return undefined;

  // With it. The room is the trouble when it adds a lesson to those already in the way, or a row or another school's hold shuts it.
  const held = context.inTheWay(landing, vacating);
  if (held.lessons.length === bare.lessons.length && held.closures.length === 0 && context.boardRefusal(landing) === null) return undefined;

  const needs = world.needsOf(landing.lesson);
  if (needs === null) return undefined;
  // The rooms the school's LOCK rules leave the lesson: the generator would put it in no other (g524).
  const locked = world.lockedRoomsOf?.(landing.lesson, needs) ?? null;
  for (const room of roomsByFit(world.rooms, needs, world.rooms.find((candidate) => candidate.id === own))) {
    if (room.id === own) continue;
    if (locked !== null && !locked.has(room.id)) continue;
    // Only the room is asked, as the room chooser asks it (room-choices.ts): the lessons that hold the room, the rows that shut it, the hold of another school.
    const taking: Landing = {
      lesson: { ...landing.lesson, teacherId: null, coTeacherId: null, studentGroupId: '', extraGroupIds: [], roomId: room.id },
      to: landing.to,
    };
    const there = context.inTheWay(taking, vacating);
    if (there.lessons.length > 0 || there.closures.length > 0 || context.boardRefusal(taking) !== null) continue;
    return { lessons: bare.lessons, closed: false, rooms: new Map([[landing.lesson.id, room.id]]) };
  }
  return undefined;
}
