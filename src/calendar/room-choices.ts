import type { Landing } from '../swaps/swap-context';
import type { SwapLesson } from '../swaps/swap-types';
import { roomAllowed, roomsByFit, type ClosedCode, type PossibleSubject, type PossibleWorld, type RoomFact } from './possible-times';

/*
 * E3, SALVÄLJAREN: WHICH ROOM, AT THIS TIME?
 *
 * The rooms of the school in the order the schemaläggare should look at them, for one lesson laid at one time: the free ones that
 * the generator would put the lesson in first (the lesson's own room, then its own kind of room, then the smallest that is big
 * enough, then its own building), then the free ones it would not (too small, another type, outside the group's years), then the
 * ones a lesson stands in, naming it, then the ones that are shut. Each row says its seats against the pupils the lesson needs, and
 * what it is that is wrong, in a field of its own and never in a colour.
 *
 * It asks the room alone: the teacher and the class are not the question here, and a time where they are not free is the possible
 * times' answer (possible-times.ts), not this one's. A room is free exactly when the clash rule's room arm and its weekly rows leave
 * it alone, and not shut by another school's hold: the same overlap findConflicts makes (SwapContext.inTheWay), asked of nothing but
 * the room.
 */

/** A lesson standing in a room, as a refusal names one: by class, subject, day and clock. */
export interface RoomOccupant {
  lessonId: string;
  className: string;
  subjectName: string;
  dayOfWeek: number;
  startMinutes: number;
  endMinutes: number;
  isLocked: boolean;
}

export interface RoomChoice {
  roomId: string;
  name: string;
  /** Seats, or null when the school has not said. */
  capacity: number | null;
  /** The pupils the lesson needs seats for. */
  needed: number;
  /** FREE: nothing holds it then. BUSY: a lesson stands in it. CLOSED: a weekly row closes it, or another school holds it. */
  state: 'FREE' | 'BUSY' | 'CLOSED';
  /** The seats are fewer than the pupils. */
  tooSmall: boolean;
  /** The room is of the type the subject needs, or the subject needs none. */
  typeOk: boolean;
  /** The room is of the same type as the lesson's own room (false when the lesson has none). */
  sameTypeAsOwn: boolean;
  /** The generator would put the lesson in this room: the seats, the type and the years all fit. */
  allowed: boolean;
  /** The lesson's room as it stands. */
  current: boolean;
  /**
   * The school lets this room hold several lessons at once while their pupils fit its seats: the prune does not call it taken, whoever
   * stands in it, and the judge counts the pupils when the lesson is laid. A free room that is shared is free as far as a prune can say.
   */
  shared: boolean;
  /** 1 is the best of the free rooms that fit; null for every other room. */
  rank: number | null;
  /** BUSY: the first lesson that stands in it then, and how many do. */
  occupant: RoomOccupant | null;
  occupants: number;
  /** CLOSED: the rule, and what it is that closes it. */
  closedBy: ClosedCode | null;
  closedParams: Record<string, string | number>;
}

const lengthOf = (lesson: Pick<SwapLesson, 'startMinutes' | 'endMinutes'>): number => lesson.endMinutes - lesson.startMinutes;

/** The rooms for `subject.lesson` laid at a start, in the order described above. */
export function roomChoicesOf(world: PossibleWorld, subject: PossibleSubject, dayOfWeek: number, startMinutes: number): RoomChoice[] {
  const { context } = world;
  const member = subject.lesson;
  const vacating = new Set(subject.unit.members.map((entry) => entry.id));
  const needs = world.needsOf(member) ?? { studentGroupSize: 1, minGradeLevel: null, maxGradeLevel: null, requiredRoomTypeId: null };
  const to = { dayOfWeek, startMinutes, endMinutes: startMinutes + lengthOf(member) };
  const own = world.rooms.find((room) => room.id === member.roomId);
  const fit = roomsByFit(world.rooms, needs, own);
  const fitOrder = new Map(fit.map((room, index) => [room.id, index]));

  const rows = world.rooms.map((room): RoomChoice => {
    // Only the room is asked: no teacher and no class, so that nothing but the room can hold it.
    const landing: Landing = { lesson: { ...member, teacherId: null, coTeacherId: null, studentGroupId: '', extraGroupIds: [], roomId: room.id }, to };
    const way = context.inTheWay(landing, vacating);
    const hold = context.boardRefusal(landing) === 'OTHER_SCHOOL';
    const state: RoomChoice['state'] = way.closures.length > 0 || hold ? 'CLOSED' : way.lessons.length > 0 ? 'BUSY' : 'FREE';
    const occupants = [...way.lessons].sort((a, b) => a.startMinutes - b.startMinutes || (a.id < b.id ? -1 : 1));
    const first = occupants[0];
    return {
      roomId: room.id,
      name: room.name,
      capacity: room.capacity,
      needed: needs.studentGroupSize,
      state,
      tooSmall: room.capacity !== null && room.capacity < needs.studentGroupSize,
      typeOk: needs.requiredRoomTypeId === null || room.roomTypeId === needs.requiredRoomTypeId,
      sameTypeAsOwn: own !== undefined && room.roomTypeId === own.roomTypeId,
      allowed: roomAllowed(room, needs),
      current: room.id === member.roomId,
      shared: context.isSharedRoom(room.id),
      rank: null,
      occupant:
        state === 'BUSY' && first
          ? { lessonId: first.id, className: first.groupName, subjectName: first.subjectName, dayOfWeek: first.dayOfWeek, startMinutes: first.startMinutes, endMinutes: first.endMinutes, isLocked: first.isLocked }
          : null,
      occupants: state === 'BUSY' ? occupants.length : 0,
      closedBy: state === 'CLOSED' ? (hold ? 'OTHER_SCHOOL' : 'AVAILABILITY') : null,
      closedParams: state === 'CLOSED' ? (hold ? { schools: context.holdSchoolsAt(landing).join(', ') } : { resource: 'ROOM' }) : {},
    };
  });

  // The lessons that move with it land on this very time, each in its own room: a room one of them keeps is theirs, whoever
  // stood in it before. The judge holds the unit as one move and would refuse the two in one room.
  for (const sibling of subject.unit.members) {
    if (sibling.id === member.id || sibling.roomId === null) continue;
    const landing = { dayOfWeek, startMinutes, endMinutes: startMinutes + lengthOf(sibling) };
    if (!(landing.startMinutes < to.endMinutes && to.startMinutes < landing.endMinutes)) continue;
    const row = rows.find((candidate) => candidate.roomId === sibling.roomId);
    if (!row || row.state === 'CLOSED') continue;
    if (row.state === 'FREE') {
      row.state = 'BUSY';
      row.occupant = { lessonId: sibling.id, className: sibling.groupName, subjectName: sibling.subjectName, dayOfWeek, startMinutes: landing.startMinutes, endMinutes: landing.endMinutes, isLocked: sibling.isLocked };
    }
    row.occupants += 1;
  }

  const byName = (a: RoomChoice, b: RoomChoice) => a.name.localeCompare(b.name, 'sv') || (a.roomId < b.roomId ? -1 : 1);
  // The free rooms that fit: the lesson's own first when it is free, then as the generator would pick.
  const fits = rows
    .filter((row) => row.state === 'FREE' && row.allowed)
    .sort((a, b) => Number(b.current) - Number(a.current) || (fitOrder.get(a.roomId) ?? 0) - (fitOrder.get(b.roomId) ?? 0));
  fits.forEach((row, index) => {
    row.rank = index + 1;
  });
  return [
    ...fits,
    ...rows.filter((row) => row.state === 'FREE' && !row.allowed).sort(byName),
    ...rows.filter((row) => row.state === 'BUSY').sort((a, b) => Number(b.allowed) - Number(a.allowed) || byName(a, b)),
    ...rows.filter((row) => row.state === 'CLOSED').sort(byName),
  ];
}

/** The room facts of a school as the choice needs them (the world's own). */
export type { RoomFact };
