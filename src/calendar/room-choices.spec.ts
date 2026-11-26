import type { RoomNeeds } from '../optimization/room-eligibility';
import { makeWorld } from '../swaps/__fixtures__/swap-world';
import { SwapContext } from '../swaps/swap-context';
import type { SwapData } from '../swaps/swap-snapshot';
import type { SwapLesson } from '../swaps/swap-types';
import type { PossibleSubject, PossibleWorld, RoomFact } from './possible-times';
import { roomChoicesOf } from './room-choices';

/*
 * The room chooser, held against a brute force that knows nothing but "does a lesson overlap in this room", and against the
 * generator's own rule for what fits.
 */

const base = makeWorld({ seed: 11 });
const NEEDS: RoomNeeds = { studentGroupSize: 3, minGradeLevel: 7, maxGradeLevel: 7, requiredRoomTypeId: null };
const room = (id: string, over: Partial<RoomFact> = {}): RoomFact => ({ id, name: id, capacity: 30, roomTypeId: 'klass', minGradeLevel: null, maxGradeLevel: null, building: 'A', ...over });
const ROOMS: RoomFact[] = ['r1', 'r2', 'r3', 'r4', 'r5'].map((id) => room(id));

function worldOf(over: Partial<SwapData> = {}, rooms: RoomFact[] = ROOMS, needs: RoomNeeds = NEEDS): PossibleWorld {
  return { context: new SwapContext({ ...base.data, ...over }), rooms, wishes: [], needsOf: () => needs };
}
const subjectOf = (world: PossibleWorld, lesson: SwapLesson): PossibleSubject => ({ unit: world.context.unitOf.get(lesson.id)!, lesson, unplaced: false });
const overlaps = (a0: number, a1: number, b0: number, b1: number): boolean => a0 < b1 && b0 < a1;

describe('the room chooser, against a brute force on the hourly school', () => {
  it('calls a room free exactly when no other lesson stands in it then, and names a lesson that does', () => {
    const world = worldOf();
    const lessons = base.data.lessons;
    let free = 0;
    let busy = 0;
    for (const lesson of lessons.slice(0, 30)) {
      for (let day = 1; day <= 5; day++) {
        for (let start = 450; start <= 780; start += 30) {
          const choices = roomChoicesOf(world, subjectOf(world, lesson), day, start);
          expect(choices.map((choice) => choice.roomId).sort()).toEqual(ROOMS.map((entry) => entry.id).sort());
          for (const choice of choices) {
            const standing = lessons.filter((other) => other.id !== lesson.id && other.roomId === choice.roomId && other.dayOfWeek === day && overlaps(start, start + 60, other.startMinutes, other.endMinutes));
            expect(choice.state).toBe(standing.length === 0 ? 'FREE' : 'BUSY');
            if (standing.length === 0) free += 1;
            else {
              busy += 1;
              expect(choice.occupants).toBe(standing.length);
              const first = [...standing].sort((a, b) => a.startMinutes - b.startMinutes || (a.id < b.id ? -1 : 1))[0]!;
              expect(choice.occupant).toEqual({ lessonId: first.id, className: first.groupName, subjectName: first.subjectName, dayOfWeek: first.dayOfWeek, startMinutes: first.startMinutes, endMinutes: first.endMinutes, isLocked: false });
            }
          }
        }
      }
    }
    expect(free).toBeGreaterThan(100);
    expect(busy).toBeGreaterThan(100);
  });

  it('puts the free rooms that fit first and ranks them, then the free that do not, then the busy, then the shut', () => {
    const lesson = base.data.lessons.find((entry) => entry.dayOfWeek === 1)!;
    const rooms = [
      room('own', { name: 'Egen', capacity: 28, roomTypeId: 'klass' }),
      room('snug', { name: 'Snäv', capacity: 4, roomTypeId: 'klass' }),
      room('big', { name: 'Stor', capacity: 80, roomTypeId: 'klass' }),
      room('small', { name: 'Liten', capacity: 2, roomTypeId: 'klass' }),
      room('lab', { name: 'Labb', capacity: 30, roomTypeId: 'labb' }),
      room('taken', { name: 'Upptagen', capacity: 30 }),
      room('shut', { name: 'Stängd', capacity: 30 }),
    ];
    const here = { ...lesson, roomId: 'own', dayOfWeek: 3, startMinutes: 480, endMinutes: 540 };
    const taker: SwapLesson = { ...lesson, id: 'taker', studentGroupId: 'c9', groupName: 'C9', subjectName: 'Idrott', teacherId: 'tx', roomId: 'taken', dayOfWeek: 1, startMinutes: 540, endMinutes: 600 };
    const closing = { resourceType: 'ROOM', userId: null, roomId: 'shut', studentGroupId: null, minGradeLevel: null, maxGradeLevel: null, dayOfWeek: 1, startMinutes: 540, endMinutes: 600 };
    const world = worldOf({ lessons: [here, taker], constraints: [closing] }, rooms, { ...NEEDS, studentGroupSize: 3, requiredRoomTypeId: 'klass' });
    const choices = roomChoicesOf(world, subjectOf(world, here), 1, 540);

    expect(choices.map((choice) => [choice.roomId, choice.state, choice.rank])).toEqual([
      // The lesson's own room first when it is free, then as the generator picks: its own kind, the smallest that is big enough.
      ['own', 'FREE', 1],
      ['snug', 'FREE', 2],
      ['big', 'FREE', 3],
      // Free, and not what the generator would use: too small, or not the type the subject needs. Not ranked.
      ['lab', 'FREE', null],
      ['small', 'FREE', null],
      ['taken', 'BUSY', null],
      ['shut', 'CLOSED', null],
    ]);
    const byId = new Map(choices.map((choice) => [choice.roomId, choice]));
    expect(byId.get('own')).toMatchObject({ current: true, allowed: true, tooSmall: false, typeOk: true, sameTypeAsOwn: true, capacity: 28, needed: 3 });
    expect(byId.get('small')).toMatchObject({ tooSmall: true, allowed: false });
    expect(byId.get('lab')).toMatchObject({ typeOk: false, allowed: false, sameTypeAsOwn: false });
    expect(byId.get('taken')).toMatchObject({ occupants: 1, occupant: { lessonId: 'taker', className: 'C9', subjectName: 'Idrott', dayOfWeek: 1, startMinutes: 540, endMinutes: 600 } });
    expect(byId.get('shut')).toMatchObject({ closedBy: 'AVAILABILITY', closedParams: { resource: 'ROOM' } });
  });

  it('does not count the lesson itself, nor the other lessons of its own unit, as holding the room', () => {
    const lesson = base.data.lessons.find((entry) => entry.dayOfWeek === 2)!;
    const world = worldOf();
    const choices = roomChoicesOf(world, subjectOf(world, lesson), lesson.dayOfWeek, lesson.startMinutes);
    expect(choices.find((choice) => choice.roomId === lesson.roomId)).toMatchObject({ state: 'FREE', current: true, rank: 1 });
  });

  it('holds the room of a lesson that moves with it: the two land on one time, and one room cannot take both', () => {
    const lesson = base.data.lessons[0]!;
    const mover: SwapLesson = { ...lesson, id: 'mover', studentGroupId: 'c1', groupName: 'C1', teacherId: 'ta', roomId: 'r1', subjectId: 's1', dayOfWeek: 2, startMinutes: 480, endMinutes: 540 };
    const sibling: SwapLesson = { ...mover, id: 'sibling', studentGroupId: 'c2', groupName: 'C2', subjectName: 'Idrott', teacherId: 'tb', roomId: 'r2', subjectId: 's2' };
    const post = (studentGroupId: string, subjectId: string) => ({ studentGroupId, subjectId, blockId: 'B1', minutesBefore: 0, minutesAfter: 0, distribution: { maxLessonsPerDay: null, minDaysBetween: null } });
    const world = worldOf({ lessons: [mover, sibling], blocks: [{ id: 'B1', sameTimesAsBlockId: null }], posts: [post('c1', 's1'), post('c2', 's2')] });
    const subject = subjectOf(world, mover);
    expect(subject.unit.members.map((entry) => entry.id).sort()).toEqual(['mover', 'sibling']);
    // At 08:30 the sibling is where it stands, and lands in r2 at 08:30 as well: r2 is not free for the mover whoever it is.
    const at = (start: number) => roomChoicesOf(world, subject, 2, start).find((choice) => choice.roomId === 'r2')!;
    expect(at(510)).toMatchObject({ state: 'BUSY', occupants: 1, occupant: { lessonId: 'sibling', className: 'C2', subjectName: 'Idrott', dayOfWeek: 2, startMinutes: 510, endMinutes: 570 } });
    // The two always land on one start, so at any time the sibling's room is the sibling's, and a room it does not keep is free.
    expect(at(720)).toMatchObject({ state: 'BUSY', occupant: { lessonId: 'sibling', startMinutes: 720, endMinutes: 780 } });
    expect(roomChoicesOf(world, subject, 2, 720).find((choice) => choice.roomId === 'r3')).toMatchObject({ state: 'FREE' });
  });

  it('does not call a room taken that the school lets several lessons share, and says it is shared: the judge counts the pupils', () => {
    const lesson = base.data.lessons.find((entry) => entry.dayOfWeek === 1)!;
    const holder: SwapLesson = { ...lesson, id: 'holder', studentGroupId: 'c9', groupName: 'C9', teacherId: 'tx', roomId: 'r3', dayOfWeek: 4, startMinutes: 600, endMinutes: 660 };
    const data = { ...base.data, lessons: [lesson, holder] };
    const rows = (shared: string[]) => {
      const world: PossibleWorld = { context: new SwapContext(data, { sharedRooms: new Set(shared) }), rooms: ROOMS, wishes: [], needsOf: () => NEEDS };
      return roomChoicesOf(world, subjectOf(world, lesson), 4, 600).find((choice) => choice.roomId === 'r3')!;
    };
    expect(rows([])).toMatchObject({ state: 'BUSY', shared: false, occupants: 1 });
    expect(rows(['r3'])).toMatchObject({ state: 'FREE', shared: true, occupants: 0 });
  });

  it('calls a shared room busy, and names who sits in it, when the judge has said its seats are taken (g488)', () => {
    const lesson = base.data.lessons.find((entry) => entry.dayOfWeek === 1)!;
    const holder: SwapLesson = { ...lesson, id: 'holder', studentGroupId: 'c9', groupName: 'C9', subjectName: 'Idrott', teacherId: 'tx', roomId: 'r3', dayOfWeek: 4, startMinutes: 600, endMinutes: 660 };
    const data = { ...base.data, lessons: [lesson, holder] };
    const world: PossibleWorld = { context: new SwapContext(data, { sharedRooms: new Set(['r3']) }), rooms: ROOMS, wishes: [], needsOf: () => NEEDS };
    const rows = (full: ReadonlyMap<string, readonly SwapLesson[]>) => roomChoicesOf(world, subjectOf(world, lesson), 4, 600, full);
    // Without the judge's word a shared room is free as far as a prune can say, and ranked among the rooms the lesson can have.
    expect(rows(new Map()).find((choice) => choice.roomId === 'r3')).toMatchObject({ state: 'FREE', shared: true });
    // With it, it is a room a lesson sits in: busy, named, and not ranked; the others are ranked without it.
    const full = rows(new Map([['r3', [holder]]]));
    expect(full.find((choice) => choice.roomId === 'r3')).toMatchObject({ state: 'BUSY', shared: true, rank: null, occupants: 1, occupant: { lessonId: 'holder', className: 'C9', subjectName: 'Idrott' } });
    expect(full.filter((choice) => choice.rank !== null).map((choice) => choice.rank)).toEqual([1, 2, 3, 4]);
  });

  it('names the other school that holds a room, and does not say a hold is a lesson', () => {
    const lesson = base.data.lessons[0]!;
    const hold = { resourceKind: 'ROOM' as const, resourceId: 'r2', dayOfWeek: 4, startTime: '09:00', endTime: '10:00', schools: ['Södra skolan'], kind: 'ROOM_LENT' as const };
    const world = worldOf({ holds: [hold] as never, lessons: [{ ...lesson, roomId: 'r1', dayOfWeek: 1 }] });
    const choice = roomChoicesOf(world, subjectOf(world, { ...lesson, roomId: 'r1', dayOfWeek: 1 }), 4, 540).find((entry) => entry.roomId === 'r2')!;
    expect(choice).toMatchObject({ state: 'CLOSED', closedBy: 'OTHER_SCHOOL', closedParams: { schools: 'Södra skolan' }, occupant: null, occupants: 0 });
  });

  it('answers for a lesson with no room of its own, and for a school with no seats counted', () => {
    const lesson = { ...base.data.lessons[0]!, roomId: null, dayOfWeek: 5, startMinutes: 900, endMinutes: 960 };
    const rooms = ROOMS.map((entry) => ({ ...entry, capacity: null }));
    const world = worldOf({ lessons: [lesson] }, rooms);
    const choices = roomChoicesOf(world, subjectOf(world, lesson), 5, 900);
    expect(choices.every((choice) => choice.state === 'FREE' && choice.allowed && !choice.tooSmall && !choice.current)).toBe(true);
    expect(choices.map((choice) => choice.rank)).toEqual([1, 2, 3, 4, 5]);
  });
});
