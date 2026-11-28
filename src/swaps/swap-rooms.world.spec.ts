import type { RoomNeeds } from '../optimization/room-eligibility';
import type { RoomFact } from '../calendar/possible-times';
import { makeWorld } from './__fixtures__/swap-world';
import { SwapContext } from './swap-context';
import { searchMakeRoom } from './swap-make-room';
import { makeRoomWorldOf } from './swap-rooms';
import type { SwapData } from './swap-snapshot';
import type { SwapLesson, SwapSlot } from './swap-types';

/*
 * E5a, ANNAN LEDIG SAL, two things swap-rooms.spec.ts does not hold (g524, found by mutating swap-rooms.ts):
 *   - the generator's ORDER of rooms is measured from the lesson's own room (its own kind first, then the fewest seats to spare, then its own building):
 *     the spec's rooms are all of one kind and one building, so a world that handed roomsByFit no own room at all passed every case;
 *   - the world says two UNITS clash when any lesson of one holds what any lesson of the other holds at its landing: the spec's units are all of one
 *     lesson, so a world that asked "every" where it must ask "any" of the members passed too (the judge would refuse the sets, and the list would be shorter
 *     for it, not wrong);
 *   - under a cap on the landings, of the two ways to ONE landing the lesson's own room is kept before another room (swap-make-room.ts, the last figure of
 *     `weight`): nothing but a cap tells them apart, and the exhaustive check runs without one.
 */

const base = makeWorld({ seed: 11 });
const NEEDS: RoomNeeds = { studentGroupSize: 3, minGradeLevel: 7, maxGradeLevel: 7, requiredRoomTypeId: null };
const room = (id: string, over: Partial<RoomFact> = {}): RoomFact => ({ id, name: id, capacity: 30, roomTypeId: 'klass', minGradeLevel: null, maxGradeLevel: null, building: 'A', ...over });
const ROOMS: RoomFact[] = ['r1', 'r2', 'r3', 'r4', 'r5'].map((id) => room(id));
const at = (dayOfWeek: number, startMinutes: number, length = 60): SwapSlot => ({ dayOfWeek, startMinutes, endMinutes: startMinutes + length });

const lessonOf = (id: string, over: Partial<SwapLesson>): SwapLesson => ({
  id,
  subjectId: 's1',
  subjectName: 'Ämne',
  studentGroupId: 'c1',
  groupName: 'C1',
  teacherId: 't1',
  coTeacherId: null,
  roomId: 'r1',
  dayOfWeek: 1,
  startMinutes: 480,
  endMinutes: 540,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  isLocked: false,
  isGenerated: true,
  extraGroupIds: [],
  studentIds: [],
  ...over,
});

function worldOf(data: Partial<SwapData>, rooms: RoomFact[] = ROOMS, needs: RoomNeeds = NEEDS) {
  const context = new SwapContext({ ...base.data, ...data });
  return { context, world: makeRoomWorldOf({ context, rooms, needsOf: () => needs }, { otherRooms: true }) };
}

describe('the room a displaced lesson takes: the generator’s order, measured from its own room', () => {
  // x stands in r1 on Monday 08:00; a lesson of another class and teacher holds r1 on Tuesday 09:00, so the landing is held by the room alone.
  const mover = lessonOf('x', { studentGroupId: 'c1', teacherId: 'tx', roomId: 'r1' });
  const holder = lessonOf('h', { studentGroupId: 'c2', groupName: 'C2', teacherId: 'th', roomId: 'r1', dayOfWeek: 2, startMinutes: 540, endMinutes: 600 });
  const target = at(2, 540);

  it('takes its own kind first, then the fewest seats to spare, then its own building', () => {
    const rooms = [
      room('r1', { name: 'own', roomTypeId: 'klass', building: 'A', capacity: 30 }),
      // The first by name, and the closest fit: a lab, in the own building, with the fewest seats to spare. Another kind than the lesson's own.
      room('r2', { name: 'a-lab', roomTypeId: 'labb', building: 'A', capacity: 4 }),
      room('r3', { name: 'b-klass-b', roomTypeId: 'klass', building: 'B', capacity: 30 }),
      room('r4', { name: 'c-klass-a', roomTypeId: 'klass', building: 'A', capacity: 30 }),
      room('r5', { name: 'd-klass-a-big', roomTypeId: 'klass', building: 'A', capacity: 60 }),
    ];
    const { context, world } = worldOf({ lessons: [mover, holder] }, rooms);
    // Its own kind before the lab; of that kind those with the fewest seats to spare (r3 and r4, not the bigger r5); of those the one in its own building.
    expect([...world.otherRoom!(context.unitOf.get('x')!, target)!.rooms!]).toEqual([['x', 'r4']]);
    // With its own kind taken then, the lab is next, and the lab is not in the way of the order for the lesson of another kind: a lab lesson takes the lab.
    const taken = (id: string, roomId: string) => lessonOf(id, { studentGroupId: `g-${id}`, groupName: id, teacherId: `t-${id}`, roomId, dayOfWeek: 2, startMinutes: 540, endMinutes: 600 });
    const crowded = worldOf({ lessons: [mover, holder, taken('a', 'r3'), taken('b', 'r4'), taken('c', 'r5')] }, rooms);
    expect([...crowded.world.otherRoom!(crowded.context.unitOf.get('x')!, target)!.rooms!]).toEqual([['x', 'r2']]);
  });
});

describe('what two units of several lessons hold of each other at their landings', () => {
  const lesson = (id: string, groupId: string, teacherId: string, roomId: string, day: number, start: number, subjectId: string) =>
    lessonOf(id, { studentGroupId: groupId, groupName: groupId.toUpperCase(), teacherId, roomId, dayOfWeek: day, startMinutes: start, endMinutes: start + 60, subjectId });
  const post = (studentGroupId: string, subjectId: string, blockId: string) => ({ studentGroupId, subjectId, blockId, minutesBefore: 0, minutesAfter: 0, distribution: { maxLessonsPerDay: null, minDaysBetween: null } });

  it('clash when ANY lesson of one holds a room, a teacher or a class that ANY lesson of the other holds then', () => {
    // Two blocks of two lessons each: B1 (p1 in r1, p2 in r2) on Monday 08:00 and B2 (q1 in r3, q2 in r1) on Tuesday 09:00.
    const lessons = [lesson('p1', 'c1', 't1', 'r1', 1, 480, 'sB'), lesson('p2', 'c3', 't2', 'r2', 1, 480, 'sB'), lesson('q1', 'c2', 't3', 'r3', 2, 540, 'sC'), lesson('q2', 'c4', 't4', 'r1', 2, 540, 'sC')];
    const data = {
      lessons,
      posts: [post('c1', 'sB', 'B1'), post('c3', 'sB', 'B1'), post('c2', 'sC', 'B2'), post('c4', 'sC', 'B2')],
      blocks: [{ id: 'B1', sameTimesAsBlockId: null }, { id: 'B2', sameTimesAsBlockId: null }],
    } as never;
    const { context, world } = worldOf(data);
    const first = context.unitOf.get('p1')!;
    const second = context.unitOf.get('q1')!;
    expect(first.members).toHaveLength(2);
    expect(second.members).toHaveLength(2);
    // Both to Wednesday 10:00: p1 and q2 are both in r1 then, and no other pair meets in a room, a teacher or a class.
    expect(world.landingsClash({ unit: first, to: at(3, 600) }, { unit: second, to: at(3, 600) })).toBe(true);
    expect(world.landingsClash({ unit: second, to: at(3, 600) }, { unit: first, to: at(3, 600) })).toBe(true);
    // At times that do not meet there is none.
    expect(world.landingsClash({ unit: first, to: at(3, 600) }, { unit: second, to: at(3, 720) })).toBe(false);
    // And none when the one pair that shared a room has been given another.
    expect(world.landingsClash({ unit: first, to: at(3, 600) }, { unit: second, to: at(3, 600), rooms: new Map([['q2', 'r5']]) })).toBe(false);
  });
});

describe('under a cap on the landings, the own room comes before another room for the same landing', () => {
  it('keeps the swap, where the lesson stands in the room the other leaves, and not the same landing in another room', async () => {
    // p (class c1) and h (class c2) both stand in r1, p on Monday 08:00 and h on Monday 09:00. p is asked to Monday 09:00, where h holds r1 and h is no one else's
    // trouble, so h goes (or p takes another room). h's nearest landings are p's own place and Monday 10:00, equally far off. At p's place h's room r1 is p's
    // until p has gone: h there is either in its own room (a swap, nobody else needs to go) or in r2, and neither way has anyone else in its way.
    const p = lessonOf('p', { studentGroupId: 'c1', teacherId: 't1', roomId: 'r1', dayOfWeek: 1, startMinutes: 480, endMinutes: 540 });
    const h = lessonOf('h', { studentGroupId: 'c2', groupName: 'C2', teacherId: 't2', roomId: 'r1', dayOfWeek: 1, startMinutes: 540, endMinutes: 600 });
    const { context, world } = worldOf({ lessons: [p, h] });
    const proposals = async (perUnit: number) =>
      (
        await searchMakeRoom({
          picked: context.unitOf.get('p')!,
          placed: true,
          target: { dayOfWeek: 1, startMinutes: 540 },
          unitOf: context.unitOf,
          starts: [480, 540, 600],
          days: [1],
          world,
          soft: (moves) => ({ costs: [], score: moves.length }),
          judge: async (sets) => sets.map(() => true),
          limit: 10,
          budgetMs: 1_000_000,
          depth: 2,
          maxUnits: 3,
          perUnit,
        })
      ).proposals;
    const hMove = (proposal: Awaited<ReturnType<typeof proposals>>[number]) => proposal.moves.find((move) => move.lessonId === 'h');
    // Without a cap both ways to h's place are there, and they are one proposal: the one that changes no room.
    const all = await proposals(Number.POSITIVE_INFINITY);
    const swapsAll = all.filter((proposal) => hMove(proposal)?.to.startMinutes === 480);
    expect(swapsAll).toHaveLength(1);
    expect(hMove(swapsAll[0]!)!.room).toBeUndefined();
    // With a cap of one landing the one h is given is the first of its ways to its nearest place, and that is the own room's.
    const capped = (await proposals(1)).filter((proposal) => hMove(proposal) !== undefined);
    expect(capped).toHaveLength(1);
    expect(hMove(capped[0]!)!.to.startMinutes).toBe(480);
    expect(hMove(capped[0]!)!.room).toBeUndefined();
  });
});
