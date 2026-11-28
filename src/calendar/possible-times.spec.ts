import type { RoomNeeds } from '../optimization/room-eligibility';
import { makeWorld } from '../swaps/__fixtures__/swap-world';
import { SwapContext } from '../swaps/swap-context';
import type { SwapData } from '../swaps/swap-snapshot';
import type { SwapLesson } from '../swaps/swap-types';
import {
  byScore,
  costOf,
  POSSIBLE_SCORE,
  probeStarts,
  roomAllowed,
  roomsByFit,
  runsOf,
  startsOf,
  wishesOf,
  type PossibleSubject,
  type PossibleWindow,
  type PossibleWorld,
  type Probe,
  type RoomFact,
  type Settled,
  type WishRow,
} from './possible-times';

/*
 * The pure half of the possible-times query, held against a brute force that knows nothing but "does anything overlap" on the
 * swap tests' hourly school, and against an independent count of idle minutes for the order.
 */

const base = makeWorld({ seed: 11 });
const NEEDS: RoomNeeds = { studentGroupSize: 3, minGradeLevel: 7, maxGradeLevel: 7, requiredRoomTypeId: null };
const ROOMS: RoomFact[] = ['r1', 'r2', 'r3', 'r4', 'r5'].map((id) => ({
  id,
  name: id,
  capacity: 30,
  roomTypeId: null,
  minGradeLevel: null,
  maxGradeLevel: null,
  building: null,
}));

function worldOf(over: Partial<SwapData> = {}, rooms: RoomFact[] = [], wishes: WishRow[] = [], unplaced: SwapLesson[] = []): PossibleWorld {
  const context = new SwapContext({ ...base.data, ...over }, { unplaced });
  return { context, rooms, wishes, needsOf: () => NEEDS };
}

function subjectOf(world: PossibleWorld, lesson: SwapLesson, unplaced = false): PossibleSubject {
  return { unit: world.context.unitOf.get(lesson.id)!, lesson, unplaced };
}

const WINDOW: PossibleWindow = { days: [1, 2, 3, 4, 5], fromMinutes: 420, toMinutes: 900, stepMinutes: 30 };
const at = (probed: ReturnType<typeof probeStarts>, day: number, start: number): Probe => probed.find((entry) => entry.dayOfWeek === day && entry.startMinutes === start)!.probe;
const overlaps = (a0: number, a1: number, b0: number, b1: number): boolean => a0 < b1 && b0 < a1;

describe('startsOf', () => {
  it('lists the starts of each day in order, the last one ending at the window', () => {
    const starts = startsOf({ days: [3, 1], fromMinutes: 480, toMinutes: 600, stepMinutes: 30 }, 60);
    expect(starts).toEqual([
      { dayOfWeek: 1, startMinutes: 480 },
      { dayOfWeek: 1, startMinutes: 510 },
      { dayOfWeek: 1, startMinutes: 540 },
      { dayOfWeek: 3, startMinutes: 480 },
      { dayOfWeek: 3, startMinutes: 510 },
      { dayOfWeek: 3, startMinutes: 540 },
    ]);
  });

  it('lists nothing when the lesson is longer than the window', () => {
    expect(startsOf({ days: [1], fromMinutes: 480, toMinutes: 520, stepMinutes: 5 }, 60)).toEqual([]);
  });
});

describe('the prune, against a brute force on the hourly school', () => {
  const world = worldOf();
  const lessons = base.data.lessons;

  it('says a start is a candidate exactly when nothing overlaps the teacher, the room or the class, and otherwise who holds it', () => {
    let candidates = 0;
    let inTheWay = 0;
    let crowded = 0;
    for (const lesson of lessons.slice(0, 40)) {
      const probed = probeStarts(world, subjectOf(world, lesson), WINDOW);
      for (const { dayOfWeek, startMinutes, probe } of probed) {
        if (dayOfWeek === lesson.dayOfWeek && startMinutes === lesson.startMinutes) {
          expect(probe.kind).toBe('STANDS');
          continue;
        }
        const end = startMinutes + (lesson.endMinutes - lesson.startMinutes);
        const touching = lessons.filter((other) => other.id !== lesson.id && other.dayOfWeek === dayOfWeek && overlaps(startMinutes, end, other.startMinutes, other.endMinutes));
        const people = touching.filter((other) => other.teacherId === lesson.teacherId || other.studentGroupId === lesson.studentGroupId);
        const rooms = touching.filter((other) => other.roomId === lesson.roomId);
        // The teacher and the class first; the room only when they are free (no other room is on offer here).
        const holding = people.length > 0 ? people : rooms;
        if (holding.length === 0) {
          expect(probe.kind).toBe('CANDIDATE');
          candidates += 1;
        } else if (holding.length === 1) {
          expect(probe).toEqual({ kind: 'IN_THE_WAY', blocker: holding[0] });
          inTheWay += 1;
        } else {
          expect(probe).toEqual({ kind: 'CROWDED', units: holding.length, locked: false });
          crowded += 1;
        }
      }
    }
    // The school is busy enough for all three answers to have been given, or the comparison proves little.
    expect(candidates).toBeGreaterThan(50);
    expect(inTheWay).toBeGreaterThan(50);
    expect(crowded).toBeGreaterThan(50);
  });

  it('calls a lesson that is locked a crowd, and the same lesson unlocked a lesson in the way', () => {
    const mover: SwapLesson = { ...base.data.lessons[0]!, id: 'mover', teacherId: 'ta', roomId: 'ra', studentGroupId: 'c1', dayOfWeek: 1, startMinutes: 480, endMinutes: 540 };
    const blocker: SwapLesson = { ...mover, id: 'blocker', teacherId: 'tb', roomId: 'rb', dayOfWeek: 2, startMinutes: 540, endMinutes: 600 };
    const probeWith = (isLocked: boolean) => {
      const world = worldOf({ lessons: [mover, { ...blocker, isLocked }] });
      return at(probeStarts(world, subjectOf(world, mover), WINDOW), 2, 540);
    };
    expect(probeWith(true)).toEqual({ kind: 'CROWDED', units: 1, locked: true });
    expect(probeWith(false)).toEqual({ kind: 'IN_THE_WAY', blocker: expect.objectContaining({ id: 'blocker' }) });
  });
});

describe('a stretch a rule shuts', () => {
  const mover = base.data.lessons.find((lesson) => lesson.dayOfWeek === 2)!;
  const closedAt = (world: PossibleWorld, day: number, start: number) => at(probeStarts(world, subjectOf(world, mover), WINDOW), day, start);

  it("is the stage's ramtid, named FRAME, and wins over a lesson that is in the way", () => {
    const world = worldOf({ frames: [{ min: 7, max: 7, day: null, start: 480, end: 780 }] });
    expect(closedAt(world, 3, 420)).toEqual({ kind: 'CLOSED', code: 'FRAME', params: {} });
    expect(closedAt(world, 3, 750)).toEqual({ kind: 'CLOSED', code: 'FRAME', params: {} });
    // Inside the frame it is an ordinary start.
    expect(closedAt(world, 3, 540).kind).not.toBe('CLOSED');
  });

  it("is the class's meal, named LUNCH", () => {
    const sittings = [{ studentGroupId: mover.studentGroupId, dayOfWeek: 4, startMinutes: 660, endMinutes: 690 }];
    const world = worldOf({ sittings });
    expect(closedAt(world, 4, 660)).toEqual({ kind: 'CLOSED', code: 'LUNCH', params: {} });
    expect(closedAt(world, 4, 630)).toEqual({ kind: 'CLOSED', code: 'LUNCH', params: {} });
    expect(closedAt(world, 4, 690).kind).not.toBe('CLOSED');
    expect(closedAt(world, 3, 660).kind).not.toBe('CLOSED');
  });

  it('is a weekly rule on the årskurs, named GRADE_RULE', () => {
    const row = { resourceType: 'GRADE_LEVEL', userId: null, roomId: null, studentGroupId: null, minGradeLevel: 7, maxGradeLevel: 9, dayOfWeek: 5, startMinutes: 780, endMinutes: 840 };
    expect(closedAt(worldOf({ constraints: [row] }), 5, 780)).toEqual({ kind: 'CLOSED', code: 'GRADE_RULE', params: {} });
  });

  it("is another school's hold on the teacher, named OTHER_SCHOOL with the school", () => {
    const hold = { resourceKind: 'TEACHER' as const, resourceId: mover.teacherId!, dayOfWeek: 1, startTime: '09:00', endTime: '10:00', schools: ['Norra skolan'], kind: 'TEACHER_BUSY' as const };
    const world = worldOf({ holds: [hold] as never });
    expect(closedAt(world, 1, 540)).toEqual({ kind: 'CLOSED', code: 'OTHER_SCHOOL', params: { schools: 'Norra skolan' } });
    expect(closedAt(world, 1, 600).kind).not.toBe('CLOSED');
  });

  it("is a weekly row that makes the teacher or the class unavailable, named AVAILABILITY with what it closes", () => {
    const teacherRow = { resourceType: 'TEACHER', userId: mover.teacherId, roomId: null, studentGroupId: null, minGradeLevel: null, maxGradeLevel: null, dayOfWeek: 2, startMinutes: 840, endMinutes: 900 };
    const groupRow = { ...teacherRow, resourceType: 'STUDENT_GROUP', userId: null, studentGroupId: mover.studentGroupId, dayOfWeek: 3 };
    expect(closedAt(worldOf({ constraints: [teacherRow] }), 2, 840)).toEqual({ kind: 'CLOSED', code: 'AVAILABILITY', params: { resource: 'TEACHER' } });
    expect(closedAt(worldOf({ constraints: [groupRow] }), 3, 840)).toEqual({ kind: 'CLOSED', code: 'AVAILABILITY', params: { resource: 'GROUP' } });
  });

  it('is not the room while another room can be had: a closed room is then a question of another room', () => {
    const roomRow = { resourceType: 'ROOM', userId: null, roomId: mover.roomId, studentGroupId: null, minGradeLevel: null, maxGradeLevel: null, dayOfWeek: 5, startMinutes: 840, endMinutes: 900 };
    const withRooms = worldOf({ constraints: [roomRow] }, ROOMS);
    const probe = at(probeStarts(withRooms, subjectOf(withRooms, mover), WINDOW), 5, 840);
    expect(probe.kind).toBe('CANDIDATE');
    if (probe.kind === 'CANDIDATE') {
      expect(probe.roomChanged).toBe(true);
      expect(probe.rooms.get(mover.id)).not.toBe(mover.roomId);
    }
  });

  it('is the room when no other room fits and no lesson holds it: the weekly row on the room, named with the resource it closes', () => {
    const roomRow = { resourceType: 'ROOM', userId: null, roomId: mover.roomId, studentGroupId: null, minGradeLevel: null, maxGradeLevel: null, dayOfWeek: 5, startMinutes: 840, endMinutes: 900 };
    const world = worldOf({ constraints: [roomRow] });
    expect(at(probeStarts(world, subjectOf(world, mover), WINDOW), 5, 840)).toEqual({ kind: 'CLOSED', code: 'AVAILABILITY', params: { resource: 'ROOM' } });
  });

  it('is the room when no other room fits and no lesson holds it: a room lent to another school, named OTHER_SCHOOL with the school', () => {
    const hold = { resourceKind: 'ROOM' as const, resourceId: mover.roomId!, dayOfWeek: 5, startTime: '14:00', endTime: '15:00', schools: ['Norra skolan'], kind: 'ROOM_LENT' as const };
    const world = worldOf({ holds: [hold] as never });
    expect(at(probeStarts(world, subjectOf(world, mover), WINDOW), 5, 840)).toEqual({ kind: 'CLOSED', code: 'OTHER_SCHOOL', params: { schools: 'Norra skolan' } });
    // Another room that fits gets the lesson out of it instead.
    const withRooms = worldOf({ holds: [hold] as never }, ROOMS);
    expect(at(probeStarts(withRooms, subjectOf(withRooms, mover), WINDOW), 5, 840).kind).toBe('CANDIDATE');
  });
});

describe('another room', () => {
  // Class c1's lesson wants Tuesday 15:00; its room r1 is held by another class's lesson then, the teacher and the class are free.
  const mover = base.data.lessons.find((lesson) => lesson.dayOfWeek === 1)!;
  const taker: SwapLesson = { ...mover, id: 'taker', studentGroupId: 'c9', groupName: 'C9', teacherId: 'tx', dayOfWeek: 2, startMinutes: 900, endMinutes: 960 };
  const data = { lessons: [...base.data.lessons, taker].map((lesson) => (lesson.id === taker.id ? { ...lesson, roomId: mover.roomId } : lesson)) };

  it('offers the best free room that fits when only the room is taken, and says it changed', () => {
    const world = worldOf(data, ROOMS);
    const probe = at(probeStarts(world, subjectOf(world, mover), { ...WINDOW, toMinutes: 1000 }), 2, 900);
    expect(probe.kind).toBe('CANDIDATE');
    if (probe.kind === 'CANDIDATE') {
      expect(probe.roomChanged).toBe(true);
      expect(probe.rooms.get(mover.id)).not.toBe(mover.roomId);
    }
  });

  it('leaves the lesson in its own room when that is free', () => {
    const world = worldOf(data, ROOMS);
    const probe = at(probeStarts(world, subjectOf(world, mover), { ...WINDOW, toMinutes: 1000 }), 5, 900);
    expect(probe.kind).toBe('CANDIDATE');
    if (probe.kind === 'CANDIDATE') {
      expect(probe.roomChanged).toBe(false);
      expect(probe.rooms.get(mover.id)).toBe(mover.roomId);
    }
  });

  it('names the lesson in the room when no other room fits', () => {
    const world = worldOf(data, [{ ...ROOMS[0]!, id: mover.roomId! }]);
    const probe = at(probeStarts(world, subjectOf(world, mover), { ...WINDOW, toMinutes: 1000 }), 2, 900);
    expect(probe).toEqual({ kind: 'IN_THE_WAY', blocker: expect.objectContaining({ id: 'taker' }) });
  });
});

describe('what a room must satisfy (the generator’s own rule)', () => {
  const room = (over: Partial<RoomFact> = {}): RoomFact => ({ id: 'r', name: 'R', capacity: 30, roomTypeId: null, minGradeLevel: null, maxGradeLevel: null, building: null, ...over });
  const needs = (over: Partial<RoomNeeds> = {}): RoomNeeds => ({ ...NEEDS, studentGroupSize: 25, requiredRoomTypeId: null, ...over });

  it('is big enough, of the type the subject needs, and takes the whole year span of the group', () => {
    expect(roomAllowed(room({ capacity: 24 }), needs())).toBe(false);
    expect(roomAllowed(room({ capacity: 25 }), needs())).toBe(true);
    expect(roomAllowed(room({ capacity: null }), needs())).toBe(true);
    expect(roomAllowed(room({ roomTypeId: 'slojd' }), needs({ requiredRoomTypeId: 'idrott' }))).toBe(false);
    expect(roomAllowed(room({ roomTypeId: 'idrott' }), needs({ requiredRoomTypeId: 'idrott' }))).toBe(true);
    // The room takes years 4–6; a group of 6–7 is not inside it, half in is not allowed.
    expect(roomAllowed(room({ minGradeLevel: 4, maxGradeLevel: 6 }), needs({ minGradeLevel: 6, maxGradeLevel: 7 }))).toBe(false);
    expect(roomAllowed(room({ minGradeLevel: 4, maxGradeLevel: 6 }), needs({ minGradeLevel: 5, maxGradeLevel: 6 }))).toBe(true);
    // A group whose years are unknown is let through.
    expect(roomAllowed(room({ minGradeLevel: 4, maxGradeLevel: 6 }), needs({ minGradeLevel: null, maxGradeLevel: null }))).toBe(true);
  });

  it('orders the rooms: the lesson’s own kind first, then the smallest that is big enough, then its own building', () => {
    const own = room({ id: 'own', roomTypeId: 'klass', building: 'A' });
    const ordered = roomsByFit(
      [
        room({ id: 'big', name: 'Big', capacity: 60, roomTypeId: 'klass' }),
        room({ id: 'other-kind', name: 'Kind', capacity: 26, roomTypeId: 'grupp' }),
        room({ id: 'snug', name: 'Snug', capacity: 26, roomTypeId: 'klass', building: 'B' }),
        room({ id: 'snug-a', name: 'SnugA', capacity: 26, roomTypeId: 'klass', building: 'A' }),
        room({ id: 'small', name: 'Small', capacity: 10, roomTypeId: 'klass' }),
      ],
      needs(),
      own,
    ).map((candidate) => candidate.id);
    expect(ordered).toEqual(['snug-a', 'snug', 'big', 'other-kind']);
  });
});

describe('the order is the written cost', () => {
  /** The idle minutes of one body over the week: every gap of 15 minutes or more between its lessons of a day. */
  function idle(slots: Array<{ day: number; start: number; end: number }>): number {
    let sum = 0;
    for (let day = 1; day <= 7; day += 1) {
      const sorted = slots.filter((slot) => slot.day === day).sort((a, b) => a.start - b.start);
      let reach = -1;
      for (const slot of sorted) {
        if (reach >= 0 && slot.start - reach >= 15) sum += slot.start - reach;
        reach = Math.max(reach, slot.end);
      }
    }
    return sum;
  }
  const slotOf = (lesson: SwapLesson) => ({ day: lesson.dayOfWeek, start: lesson.startMinutes, end: lesson.endMinutes });

  it('is the swap search’s own figure for every candidate, counted again by hand, and the best is first', () => {
    const world = worldOf();
    const lessons = base.data.lessons;
    let compared = 0;
    for (const lesson of lessons.slice(0, 12)) {
      const subject = subjectOf(world, lesson);
      const costed = probeStarts(world, subject, { days: [1, 2, 3, 4, 5], fromMinutes: 480, toMinutes: 900, stepMinutes: 60 })
        .flatMap(({ dayOfWeek, startMinutes, probe }) => (probe.kind === 'CANDIDATE' ? [costOf(world, subject, { dayOfWeek, startMinutes, rooms: probe.rooms, roomChanged: probe.roomChanged })] : []))
        .sort(byScore);
      const pupils = base.pupilsOf.get(lesson.studentGroupId)!.length;
      const classLessons = lessons.filter((other) => other.studentGroupId === lesson.studentGroupId);
      const teacherLessons = lessons.filter((other) => other.teacherId === lesson.teacherId);
      const byHand = (candidate: { dayOfWeek: number; startMinutes: number }) => {
        const moved = { day: candidate.dayOfWeek, start: candidate.startMinutes, end: candidate.startMinutes + 60 };
        const swapped = (all: SwapLesson[]) => all.map((other) => (other.id === lesson.id ? moved : slotOf(other)));
        const pupilDelta = pupils * (idle(swapped(classLessons)) - idle(classLessons.map(slotOf)));
        const teacherDelta = idle(swapped(teacherLessons)) - idle(teacherLessons.map(slotOf));
        // swap-soft.ts SCORE: PUPIL_CLASS 25, MOVED_LESSON 5 (one lesson moved).
        return pupilDelta / 25 + teacherDelta + 5;
      };
      for (const candidate of costed) {
        expect(candidate.score).toBeCloseTo(byHand(candidate), 9);
        compared += 1;
      }
      const scores = costed.map((candidate) => candidate.score);
      expect(scores).toEqual([...scores].sort((a, b) => a - b));
    }
    expect(compared).toBeGreaterThan(100);
  });

  it('puts the earlier time first when two cost the same', () => {
    const tie = (day: number, start: number) => ({ dayOfWeek: day, startMinutes: start, endMinutes: start + 60, rooms: new Map(), roomChanged: false, costs: [], wishes: { met: 0, avoided: 0 }, score: 3 });
    expect([tie(2, 480), tie(1, 540), tie(1, 480)].sort(byScore).map((entry) => [entry.dayOfWeek, entry.startMinutes])).toEqual([
      [1, 480],
      [1, 540],
      [2, 480],
    ]);
  });

  it('counts a wish for a free hour against the time, and a wish for a busy one for it, and charges another room a little', () => {
    const lesson = base.data.lessons[0]!;
    const free: WishRow = { resourceType: 'TEACHER', userId: lesson.teacherId, roomId: null, studentGroupId: null, dayOfWeek: 5, startMinutes: 480, endMinutes: 540, type: 'PREFERRED_FREE' };
    const busy: WishRow = { ...free, type: 'PREFERRED_BUSY' };
    const plain = worldOf();
    const start = { dayOfWeek: 5, startMinutes: 480, rooms: new Map([[lesson.id, lesson.roomId]]), roomChanged: false };
    const none = costOf(plain, subjectOf(plain, lesson), start);
    const worse = costOf({ ...plain, wishes: [free] }, subjectOf(plain, lesson), start);
    const better = costOf({ ...plain, wishes: [busy] }, subjectOf(plain, lesson), start);
    expect(worse.score - none.score).toBeCloseTo(POSSIBLE_SCORE.WISH, 9);
    expect(none.score - better.score).toBeCloseTo(POSSIBLE_SCORE.WISH, 9);
    expect(worse.wishes).toEqual({ met: 0, avoided: 1 });
    expect(better.wishes).toEqual({ met: 1, avoided: 0 });
    expect(costOf(plain, subjectOf(plain, lesson), { ...start, roomChanged: true }).score - none.score).toBeCloseTo(POSSIBLE_SCORE.ROOM_CHANGE, 9);
  });

  it('reads a wish only on the day, the hour and the resource it names', () => {
    const lesson = base.data.lessons[0]!;
    const row = (over: Partial<WishRow>): WishRow => ({ resourceType: 'TEACHER', userId: lesson.teacherId, roomId: null, studentGroupId: null, dayOfWeek: 2, startMinutes: 600, endMinutes: 660, type: 'PREFERRED_FREE', ...over });
    const slot = { dayOfWeek: 2, startMinutes: 600, endMinutes: 660 };
    expect(wishesOf([row({})], lesson, null, slot)).toEqual({ met: 0, avoided: 1 });
    expect(wishesOf([row({ dayOfWeek: 3 })], lesson, null, slot)).toEqual({ met: 0, avoided: 0 });
    expect(wishesOf([row({ startMinutes: 660, endMinutes: 720 })], lesson, null, slot)).toEqual({ met: 0, avoided: 0 });
    expect(wishesOf([row({ userId: 'someone-else' })], lesson, null, slot)).toEqual({ met: 0, avoided: 0 });
    expect(wishesOf([row({ resourceType: 'ROOM', userId: null, roomId: 'r9' })], lesson, 'r9', slot)).toEqual({ met: 0, avoided: 1 });
    expect(wishesOf([row({ resourceType: 'STUDENT_GROUP', userId: null, studentGroupId: lesson.studentGroupId, type: 'PREFERRED_BUSY' })], lesson, null, slot)).toEqual({ met: 1, avoided: 0 });
  });
});

describe('a brick, which stands nowhere yet', () => {
  const sample = base.data.lessons[0]!;
  const brick: SwapLesson = {
    ...sample,
    id: 'brick',
    subjectId: 'sx',
    subjectName: 'Nytt ämne',
    teacherId: 't1',
    roomId: null,
    dayOfWeek: 1,
    startMinutes: 0,
    endMinutes: 60,
  };

  it('is a unit of its own, and the figures before it is laid are the school without it', () => {
    const world = worldOf({}, ROOMS, [], [brick]);
    const subject = subjectOf(world, brick, true);
    expect(subject.unit.members).toEqual([brick]);
    expect(world.context.data.lessons.some((lesson) => lesson.id === 'brick')).toBe(false);

    const costed = probeStarts(world, subject, { days: [1, 2, 3, 4, 5], fromMinutes: 480, toMinutes: 900, stepMinutes: 60 })
      .flatMap(({ dayOfWeek, startMinutes, probe }) => (probe.kind === 'CANDIDATE' ? [costOf(world, subject, { dayOfWeek, startMinutes, rooms: probe.rooms, roomChanged: probe.roomChanged })] : []));
    expect(costed.length).toBeGreaterThan(5);
    const classLessons = base.data.lessons.filter((other) => other.studentGroupId === brick.studentGroupId);
    const idleOf = (slots: Array<{ day: number; start: number; end: number }>) => {
      let sum = 0;
      for (let day = 1; day <= 5; day += 1) {
        const sorted = slots.filter((slot) => slot.day === day).sort((a, b) => a.start - b.start);
        sorted.forEach((slot, index) => {
          if (index > 0 && slot.start - sorted[index - 1]!.end >= 15) sum += slot.start - sorted[index - 1]!.end;
        });
      }
      return sum;
    };
    const slots = classLessons.map((lesson) => ({ day: lesson.dayOfWeek, start: lesson.startMinutes, end: lesson.endMinutes }));
    for (const candidate of costed) {
      const pupils = base.pupilsOf.get(brick.studentGroupId)!.length;
      const withBrick = [...slots, { day: candidate.dayOfWeek, start: candidate.startMinutes, end: candidate.endMinutes }];
      const figure = candidate.costs.find((cost) => cost.code === 'PUPIL_GAPS')!;
      // Before: the class's week as it stands. After: the brick laid, as the pupils' idle minutes (weighted by the class's pupils).
      expect(figure.before).toBeCloseTo(pupils * idleOf(slots), 9);
      expect(figure.after).toBeCloseTo(pupils * idleOf(withBrick), 9);
    }
  });

  it('does not hold itself, nor anything of the school it has no teacher or class in common with, in its way', () => {
    const world = worldOf({}, ROOMS, [], [brick]);
    const probed = probeStarts(world, subjectOf(world, brick, true), { days: [1], fromMinutes: 480, toMinutes: 900, stepMinutes: 60 });
    // The teacher of the brick is t1: where t1 or the class holds it, something is in the way; everywhere else it may stand.
    for (const { startMinutes, probe } of probed) {
      const holding = base.data.lessons.filter(
        (other) => other.dayOfWeek === 1 && overlaps(startMinutes, startMinutes + 60, other.startMinutes, other.endMinutes) && (other.teacherId === 't1' || other.studentGroupId === brick.studentGroupId),
      );
      expect(probe.kind === 'CANDIDATE').toBe(holding.length === 0);
    }
  });
});

describe('runs', () => {
  const answer = (start: number, settled: Settled) => ({ dayOfWeek: 1, startMinutes: start, answer: settled });

  it('cuts starts into stretches of one answer, and a different answer or a gap starts a new one', () => {
    const closed: Settled = { kind: 'CLOSED', code: 'LUNCH', params: {} };
    const runs = runsOf(
      [
        answer(480, { kind: 'FREE' }),
        answer(485, { kind: 'FREE' }),
        answer(490, closed),
        answer(495, closed),
        answer(500, { kind: 'UNJUDGED' }),
        answer(505, { kind: 'FREE' }),
        { dayOfWeek: 2, startMinutes: 510, answer: { kind: 'FREE' } },
      ],
      5,
    );
    expect(runs).toEqual([
      { dayOfWeek: 1, fromMinutes: 480, toMinutes: 485, kind: 'FREE' },
      { dayOfWeek: 1, fromMinutes: 490, toMinutes: 495, kind: 'CLOSED', code: 'LUNCH', params: {} },
      { dayOfWeek: 1, fromMinutes: 505, toMinutes: 505, kind: 'FREE' },
      { dayOfWeek: 2, fromMinutes: 510, toMinutes: 510, kind: 'FREE' },
    ]);
  });

  it('carries the room a time in another room is free in, and cuts the run where the room changes (E3: Ledigt, annan sal läggs)', () => {
    const inRoom = (roomId: string): Settled => ({ kind: 'CHANGE', rooms: [{ lessonId: 'l1', roomId }] });
    const runs = runsOf([answer(480, inRoom('r2')), answer(485, inRoom('r2')), answer(490, inRoom('r3')), answer(495, { kind: 'FREE' })], 5);
    expect(runs).toEqual([
      { dayOfWeek: 1, fromMinutes: 480, toMinutes: 485, kind: 'CHANGE', rooms: [{ lessonId: 'l1', roomId: 'r2' }] },
      { dayOfWeek: 1, fromMinutes: 490, toMinutes: 490, kind: 'CHANGE', rooms: [{ lessonId: 'l1', roomId: 'r3' }] },
      { dayOfWeek: 1, fromMinutes: 495, toMinutes: 495, kind: 'FREE' },
    ]);
  });

  it('keeps two lessons in the way as two runs, and carries what the board needs of each kind', () => {
    const runs = runsOf(
      [
        answer(480, { kind: 'IN_THE_WAY', blockerId: 'a' }),
        answer(485, { kind: 'IN_THE_WAY', blockerId: 'b' }),
        answer(490, { kind: 'CROWDED', units: 3, locked: true }),
        answer(495, { kind: 'CROWDED', units: 3, locked: true }),
      ],
      5,
    );
    expect(runs).toEqual([
      { dayOfWeek: 1, fromMinutes: 480, toMinutes: 480, kind: 'IN_THE_WAY', blockerId: 'a' },
      { dayOfWeek: 1, fromMinutes: 485, toMinutes: 485, kind: 'IN_THE_WAY', blockerId: 'b' },
      { dayOfWeek: 1, fromMinutes: 490, toMinutes: 495, kind: 'CROWDED', units: 3, locked: true },
    ]);
  });
});
