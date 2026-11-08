/**
 * DELADE SALAR (Placeringsregel 3): WHEN TWO LESSONS IN ONE ROOM ARE NO CLASH.
 *
 * Until the rule existed a room held one lesson at a time, in the generator and
 * in every check beside it, and two lessons in one room at one hour were a
 * ROOM clash. The generator can now be told that a room the school has marked
 * (Room.canBeShared, with a capacity) may hold several lessons together as
 * long as their pupils fit (LunchSetting.placementSharedMode SOFT or HARD).
 * A timetable it lays on that terms has two classes in the gymnasium, and
 * without this module every check that reads a ROOM clash would paint it red
 * and refuse to publish it.
 *
 * ONE DECISION, ASKED BY THREE READERS: MasterLessonsService.findConflicts
 * (a hand edit and the import), yearClashes (the publish gate) and the
 * board's validatePlacement (web/lib/conflicts.ts, which keeps a copy of this
 * file in web/lib/shared-rooms.ts, and both replay
 * src/common/__fixtures__/shared-rooms-cases.json). The readers differ in where
 * they get the lessons' pupils from; the verdict is this file's alone.
 *
 * WHAT IS NO CLASH. A pair of lessons in a room share it when
 *   (a) the room is marked shareable and has a capacity (`sharedSeatsOf`),
 *   (b) the school holds the rule on, SOFT or HARD, and
 *   (c) the pupils of every lesson in the room at any moment of the candidate's
 *       lesson, COUNTED TOGETHER AND ONCE EACH, are no more than its seats.
 * Everything else about two lessons is untouched: the teacher, the class and
 * the pupils they share still clash as they did.
 *
 * "TOGETHER" IS THE WHOLE ROOM, NOT THE PAIR. Two lessons of twenty fit forty
 * seats and a third of twenty does not: asked of pairs, all three would pass.
 * So the question is put to the candidate and every lesson that stands in the
 * room beside it, and the answer is which of those lessons it cannot stay with.
 *
 * EXACTLY AS THE ENGINE COUNTS, NO STRICTER. The engine keeps a cumulative per
 * real week (add_shared_capacity, placement.py): at every instant the pupils of
 * the lessons then running, in odd and in even weeks apart. Summing every
 * lesson that touches the candidate's hour would refuse what the engine
 * produced whenever lessons are staggered (an 08:00-10:00 lesson beside one at
 * 08:00-09:00 and one at 09:00-10:00 never holds three at once) or alternate
 * (an odd-week and an even-week lesson never meet), and a schedule the
 * generator lays would then be refused by the checks that read it. So the
 * count is made per week part and per stretch of the candidate's lesson in
 * which the same lessons are running. It never says "fits" for a moment in
 * which the room really holds more than its seats.
 *
 * AN UNKNOWN COUNT IS A CLASH. A lesson whose pupils nobody knows (no class
 * list yet, a roster still loading) cannot be promised a seat, so the room is
 * as exclusive as it was. That is the direction to err in: a clash can be
 * looked at and waved through, a hall over its seats cannot be unseen.
 *
 * PURE. Minutes are minutes of the day, half-open [start, end).
 */

/** The school's setting for the rule (LunchSetting.placementSharedMode). */
export type SharedRoomMode = 'OFF' | 'SOFT' | 'HARD';

export type SharedRoomWeeks = 'ALL_WEEKS' | 'ODD_WEEKS' | 'EVEN_WEEKS';

/** What of a room the rule reads. */
export interface SharedRoomFacts {
  id: string;
  canBeShared?: boolean | null;
  capacity?: number | null;
}

/**
 * The seats a room can be shared under, or null when it cannot be shared.
 *
 * Null for every reason a room stays exclusive: the rule is off, the room is
 * not marked, or it has no capacity (no limit to share under, so nothing to
 * count against). SOFT and HARD read alike here: the checks hold a school to
 * the capacity it wrote either way, since a soft breach is the wish the
 * generator was allowed to pay for, and a timetable that breaks it is one the
 * school wants to be told about.
 */
export function sharedSeatsOf(
  mode: SharedRoomMode | null | undefined,
  room: Pick<SharedRoomFacts, 'canBeShared' | 'capacity'> | null | undefined,
): number | null {
  if (mode !== 'SOFT' && mode !== 'HARD') return null;
  if (!room || room.canBeShared !== true) return null;
  const seats = room.capacity;
  return typeof seats === 'number' && Number.isInteger(seats) && seats >= 1 ? seats : null;
}

/** roomId → seats, for the rooms of `rooms` that may be shared under `mode`. Empty when none. */
export function sharedSeatsByRoom(
  mode: SharedRoomMode | null | undefined,
  rooms: Iterable<SharedRoomFacts>,
): Map<string, number> {
  const seats = new Map<string, number>();
  if (mode !== 'SOFT' && mode !== 'HARD') return seats;
  for (const room of rooms) {
    const held = sharedSeatsOf(mode, room);
    if (held !== null) seats.set(room.id, held);
  }
  return seats;
}

/** A lesson standing in the room, as the count reads it. */
export interface RoomOccupant {
  /** Minute of the day it starts, inclusive. */
  start: number;
  /** Minute of the day it ends, exclusive. */
  end: number;
  /** Which weeks it runs; absent is every week. */
  recurrence?: SharedRoomWeeks | null;
  /**
   * Who sits in it: every pupil of its groups and every pupil named on it, once
   * each, less those a replacing group takes off it. EMPTY MEANS UNKNOWN.
   */
  pupils: ReadonlySet<string>;
}

const WEEK_PARTS = ['ODD_WEEKS', 'EVEN_WEEKS'] as const;
type WeekPart = (typeof WEEK_PARTS)[number];

const partsOf = (recurrence: SharedRoomWeeks | null | undefined): readonly WeekPart[] =>
  recurrence === 'ODD_WEEKS' ? ['ODD_WEEKS'] : recurrence === 'EVEN_WEEKS' ? ['EVEN_WEEKS'] : WEEK_PARTS;

const runsIn = (recurrence: SharedRoomWeeks | null | undefined, part: WeekPart): boolean =>
  recurrence == null || recurrence === 'ALL_WEEKS' || recurrence === part;

/**
 * Which of `others` the candidate cannot stay in the room with: the indexes of
 * those that stand in some moment of the candidate's lesson when the pupils
 * running together are more than `seats`, or all that meet it when a count is
 * unknown. An empty set is a room that holds them all.
 *
 * `others` are the lessons in the same room on the same day; this tests the
 * clock and the odd/even weeks itself and ignores the ones that never meet the
 * candidate. A date range (startDate, endDate) it cannot see: the caller leaves
 * out the lessons whose dates cannot overlap the candidate's, as every reader
 * already does with weeksCanOverlap.
 *
 * Symmetric by construction: a lesson is named only for a moment it stands in
 * together with the candidate, and asked from the other lesson's side the same
 * moment names the candidate, so the publish gate (which asks from every
 * lesson) lists each pair once however it is read.
 */
export function crowdedWith(
  seats: number,
  candidate: RoomOccupant,
  others: readonly RoomOccupant[],
): Set<number> {
  const crowded = new Set<number>();
  const meeting: number[] = [];
  others.forEach((other, index) => {
    const parts = partsOf(candidate.recurrence);
    if (other.start < candidate.end && candidate.start < other.end && parts.some((part) => runsIn(other.recurrence, part))) {
      meeting.push(index);
    }
  });
  if (meeting.length === 0) return crowded;

  if (candidate.pupils.size === 0 || meeting.some((index) => others[index]!.pupils.size === 0)) {
    for (const index of meeting) crowded.add(index);
    return crowded;
  }

  for (const part of partsOf(candidate.recurrence)) {
    const present = meeting.filter((index) => runsIn(others[index]!.recurrence, part));
    if (present.length === 0) continue;
    // The stretches of the candidate's lesson in which the same lessons run:
    // between two consecutive times at which any of them starts or ends.
    const cuts = new Set<number>([candidate.start, candidate.end]);
    for (const index of present) {
      const other = others[index]!;
      cuts.add(Math.max(candidate.start, other.start));
      cuts.add(Math.min(candidate.end, other.end));
    }
    const times = [...cuts].sort((a, b) => a - b);
    for (let at = 0; at + 1 < times.length; at += 1) {
      const from = times[at]!;
      const to = times[at + 1]!;
      const running = present.filter((index) => others[index]!.start < to && from < others[index]!.end);
      if (running.length === 0) continue;
      const together = new Set<string>(candidate.pupils);
      for (const index of running) for (const pupil of others[index]!.pupils) together.add(pupil);
      if (together.size > seats) for (const index of running) crowded.add(index);
    }
  }
  return crowded;
}
