import type { RoomNeeds } from '../optimization/room-eligibility';
import type { RoomFact } from '../calendar/possible-times';
import { makeWorld } from './__fixtures__/swap-world';
import { SwapContext } from './swap-context';
import { makeRoomWorldOf } from './swap-rooms';
import type { SwapData } from './swap-snapshot';
import type { SwapLesson, SwapSlot } from './swap-types';

/*
 * E5a, ANNAN LEDIG SAL: the rule of swap-rooms.ts, held against the school it reads.
 *
 * swap-make-room.rooms.spec.ts holds the SEARCH to an exhaustive check given a world that offers another room. This holds the WORLD that offers
 * it: when the own room of a displaced lesson is the trouble, which room is the best that fits and is free, and what is then no one in the way.
 * Once against a plain reading of an hourly school (a room is free when no lesson stands in it then; the order is the generator's), for every
 * lesson at every landing; and one case at a time for what the plain reading does not hold: the seats, the type, the weekly rows, another
 * school's hold, a block, a teacher that is busy, a holder that is in the way for more than the room.
 */

const base = makeWorld({ seed: 11 });
const NEEDS: RoomNeeds = { studentGroupSize: 3, minGradeLevel: 7, maxGradeLevel: 7, requiredRoomTypeId: null };
const room = (id: string, over: Partial<RoomFact> = {}): RoomFact => ({ id, name: id, capacity: 30, roomTypeId: 'klass', minGradeLevel: null, maxGradeLevel: null, building: 'A', ...over });
const ROOMS: RoomFact[] = ['r1', 'r2', 'r3', 'r4', 'r5'].map((id) => room(id));
const overlaps = (a0: number, a1: number, b0: number, b1: number): boolean => a0 < b1 && b0 < a1;

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

function worldOf(data: Partial<SwapData>, rooms: RoomFact[] = ROOMS, needs: RoomNeeds = NEEDS, options: { sharedRooms?: ReadonlySet<string> } = {}) {
  const context = new SwapContext({ ...base.data, ...data }, options);
  return { context, world: makeRoomWorldOf({ context, rooms, needsOf: () => needs }, { otherRooms: true }) };
}

const at = (dayOfWeek: number, startMinutes: number, length = 60): SwapSlot => ({ dayOfWeek, startMinutes, endMinutes: startMinutes + length });
const closing = (resourceType: 'ROOM' | 'TEACHER', id: string, day: number, start: number, end: number) => ({
  resourceType,
  userId: resourceType === 'TEACHER' ? id : null,
  roomId: resourceType === 'ROOM' ? id : null,
  studentGroupId: null,
  minGradeLevel: null,
  maxGradeLevel: null,
  dayOfWeek: day,
  startMinutes: start,
  endMinutes: end,
});

/** x stands Monday 08:00 in r1; a lesson of another class and teacher stands in r1 on Tuesday 09:00: the landing is held by its room alone. */
const mover = lessonOf('x', { studentGroupId: 'c1', teacherId: 'tx', roomId: 'r1' });
const holder = lessonOf('h', { studentGroupId: 'c2', groupName: 'C2', teacherId: 'th', roomId: 'r1', dayOfWeek: 2, startMinutes: 540, endMinutes: 600 });
const TARGET = at(2, 540);

describe('the room a displaced lesson takes when its own is held (swap-rooms.ts)', () => {
  it('offers the best other room that is free, with the holder of the own room no longer in the way, and leaves the first way as the school stands', () => {
    const { context, world } = worldOf({ lessons: [mover, holder] });
    const x = context.unitOf.get('x')!;
    // As the school stands, the lesson holds its own room and the holder is in the way.
    expect(world.inTheWay(x, TARGET)).toMatchObject({ closed: false, lessons: [{ id: 'h' }] });
    expect(world.inTheWay(x, TARGET).rooms).toBeUndefined();
    // Another room: the best free one that fits, in the generator's order (here the names'), and nobody in the way.
    const other = world.otherRoom!(x, TARGET)!;
    expect(other.closed).toBe(false);
    expect(other.lessons).toEqual([]);
    expect([...other.rooms!]).toEqual([['x', 'r2']]);
  });

  it('skips a room that is too small, one of another type than the subject needs, one a weekly row shuts, and one another school holds', () => {
    const rooms = [
      room('r1'),
      room('tiny', { name: 'a-tiny', capacity: 2 }),
      room('lab', { name: 'b-lab', roomTypeId: 'labb' }),
      room('shut', { name: 'c-shut' }),
      room('lent', { name: 'd-lent' }),
      room('ok', { name: 'e-ok' }),
    ];
    const constraints = [closing('ROOM', 'shut', 2, 540, 600)];
    const holds = [{ holdId: 'h1', kind: 'ROOM_LENT' as const, resourceKind: 'ROOM' as const, resourceId: 'lent', dayOfWeek: 2, startTime: '09:00:00', endTime: '10:00:00', schools: ['Grannskolan'] }];
    const { context, world } = worldOf({ lessons: [mover, holder], constraints, holds } as never, rooms, { ...NEEDS, studentGroupSize: 3, requiredRoomTypeId: 'klass' });
    const other = world.otherRoom!(context.unitOf.get('x')!, TARGET)!;
    expect([...other.rooms!]).toEqual([['x', 'ok']]);
  });

  it('does not offer a room that another lesson stands in then, and offers none when every room is taken or shut', () => {
    const taker = (id: string, roomId: string) => lessonOf(id, { studentGroupId: `g-${id}`, groupName: id, teacherId: `t-${id}`, roomId, dayOfWeek: 2, startMinutes: 540, endMinutes: 600 });
    const lessons = [mover, holder, taker('a', 'r2'), taker('b', 'r3')];
    const { context, world } = worldOf({ lessons });
    // r2 and r3 are taken at the target: the best is r4.
    expect([...world.otherRoom!(context.unitOf.get('x')!, TARGET)!.rooms!]).toEqual([['x', 'r4']]);
    const full = worldOf({ lessons: [...lessons, taker('c', 'r4'), taker('d', 'r5')] });
    expect(full.world.otherRoom!(full.context.unitOf.get('x')!, TARGET)).toBeUndefined();
  });

  it('is offered when the own room is shut by a weekly row or lent to another school, and says the same for the way as the school stands: closed', () => {
    const shutRow = worldOf({ lessons: [mover], constraints: [closing('ROOM', 'r1', 2, 480, 720)] } as never);
    const x = shutRow.context.unitOf.get('x')!;
    expect(shutRow.world.inTheWay(x, TARGET).closed).toBe(true);
    expect([...shutRow.world.otherRoom!(x, TARGET)!.rooms!]).toEqual([['x', 'r2']]);
    const lent = worldOf({ lessons: [mover], holds: [{ holdId: 'h1', kind: 'ROOM_LENT', resourceKind: 'ROOM', resourceId: 'r1', dayOfWeek: 2, startTime: '09:00:00', endTime: '10:00:00', schools: ['Grannskolan'] }] } as never);
    expect(lent.world.inTheWay(lent.context.unitOf.get('x')!, TARGET).closed).toBe(true);
    expect([...lent.world.otherRoom!(lent.context.unitOf.get('x')!, TARGET)!.rooms!]).toEqual([['x', 'r2']]);
  });

  it('offers no room when the stretch is shut for something that is not the room: a teacher’s row, and says nothing of a teacher that is only busy', () => {
    const teacherRow = worldOf({ lessons: [mover, holder], constraints: [closing('TEACHER', 'tx', 2, 480, 720)] } as never);
    expect(teacherRow.world.otherRoom!(teacherRow.context.unitOf.get('x')!, TARGET)).toBeUndefined();
    // A teacher that stands in another lesson then is the one in the way: the room is still the lesson's to change, and that lesson is named.
    const busy = lessonOf('b', { studentGroupId: 'c3', groupName: 'C3', teacherId: 'tx', roomId: 'r5', dayOfWeek: 2, startMinutes: 540, endMinutes: 600 });
    const withBusy = worldOf({ lessons: [mover, holder, busy] });
    const other = withBusy.world.otherRoom!(withBusy.context.unitOf.get('x')!, TARGET)!;
    expect(other.lessons.map((lesson) => lesson.id)).toEqual(['b']);
    expect([...other.rooms!]).toEqual([['x', 'r2']]);
  });

  it('offers no room when a rule of the board shuts the stretch whatever the room: the ramtid of the lesson’s years', () => {
    const framed = worldOf({ lessons: [mover, holder], frames: [{ min: 7, max: 9, day: null, start: 480, end: 540 }] } as never);
    const x = framed.context.unitOf.get('x')!;
    expect(framed.world.inTheWay(x, TARGET).closed).toBe(true);
    expect(framed.world.otherRoom!(x, TARGET)).toBeUndefined();
    // Inside the frame the same landing is open to another room.
    expect(framed.world.otherRoom!(x, at(2, 480))).toBeUndefined();
    const open = worldOf({ lessons: [mover, { ...holder, startMinutes: 480, endMinutes: 540 }], frames: [{ min: 7, max: 9, day: null, start: 480, end: 540 }] } as never);
    expect([...open.world.otherRoom!(open.context.unitOf.get('x')!, at(2, 480))!.rooms!]).toEqual([['x', 'r2']]);
  });

  it('offers none when the lesson that holds the room is in the way for more than the room: it has to go anyway', () => {
    const both = lessonOf('both', { studentGroupId: 'c2', groupName: 'C2', teacherId: 'tx', roomId: 'r1', dayOfWeek: 2, startMinutes: 540, endMinutes: 600 });
    const { context, world } = worldOf({ lessons: [mover, both] });
    expect(world.inTheWay(context.unitOf.get('x')!, TARGET).lessons.map((lesson) => lesson.id)).toEqual(['both']);
    expect(world.otherRoom!(context.unitOf.get('x')!, TARGET)).toBeUndefined();
  });

  it('offers none for a lesson with no room, a lesson whose room is free, a school whose rooms are not the question, and a unit of more than one lesson', () => {
    const noRoom = worldOf({ lessons: [{ ...mover, roomId: null }, holder] });
    expect(noRoom.world.otherRoom!(noRoom.context.unitOf.get('x')!, TARGET)).toBeUndefined();
    const free = worldOf({ lessons: [mover, { ...holder, roomId: 'r2' }] });
    expect(free.world.otherRoom!(free.context.unitOf.get('x')!, TARGET)).toBeUndefined();
    const unknown = makeRoomWorldOf({ context: new SwapContext({ ...base.data, lessons: [mover, holder] }), rooms: ROOMS, needsOf: () => null }, { otherRooms: true });
    expect(unknown.otherRoom!(new SwapContext({ ...base.data, lessons: [mover, holder] }).unitOf.get('x')!, TARGET)).toBeUndefined();
    // A block: two lessons that move as one keep the rooms they were given.
    const left = lessonOf('bl', { subjectId: 'sB', studentGroupId: 'c1', teacherId: 'tx', roomId: 'r1' });
    const right = lessonOf('br', { subjectId: 'sB', studentGroupId: 'c3', groupName: 'C3', teacherId: 'ty', roomId: 'r3' });
    const data = { lessons: [left, right, holder], posts: [{ studentGroupId: 'c1', subjectId: 'sB', blockId: 'B1', minutesBefore: 0, minutesAfter: 0, distribution: { maxLessonsPerDay: null, minDaysBetween: null } }, { studentGroupId: 'c3', subjectId: 'sB', blockId: 'B1', minutesBefore: 0, minutesAfter: 0, distribution: { maxLessonsPerDay: null, minDaysBetween: null } }], blocks: [{ id: 'B1', sameTimesAsBlockId: null }] } as never;
    const block = worldOf(data);
    const unit = block.context.unitOf.get('bl')!;
    expect(unit.members).toHaveLength(2);
    expect(block.world.otherRoom!(unit, TARGET)).toBeUndefined();
  });

  it('does not call a room the school lets several lessons share held: the prune does not, and the judge counts the pupils', () => {
    const { context, world } = worldOf({ lessons: [mover, holder] }, ROOMS, NEEDS, { sharedRooms: new Set(['r1']) });
    // r1 is shared, so the holder is not in the way for the room and the room is no trouble.
    expect(world.inTheWay(context.unitOf.get('x')!, TARGET).lessons).toEqual([]);
    expect(world.otherRoom!(context.unitOf.get('x')!, TARGET)).toBeUndefined();
  });

  it('says whether two landings clash with the rooms they take counted: two lessons in one room do, and two in two rooms do not', () => {
    const second = lessonOf('y', { studentGroupId: 'c3', groupName: 'C3', teacherId: 'ty', roomId: 'r1', dayOfWeek: 3, startMinutes: 480, endMinutes: 540 });
    const { context, world } = worldOf({ lessons: [mover, second] });
    const x = context.unitOf.get('x')!;
    const y = context.unitOf.get('y')!;
    const there = at(4, 600);
    // Both bound for r1 at one time: a clash. Given r2 the clash is gone, and given a room each that differs, none.
    expect(world.landingsClash({ unit: x, to: there }, { unit: y, to: there })).toBe(true);
    expect(world.landingsClash({ unit: x, to: there, rooms: new Map([['x', 'r2']]) }, { unit: y, to: there })).toBe(false);
    expect(world.landingsClash({ unit: x, to: there, rooms: new Map([['x', 'r2']]) }, { unit: y, to: there, rooms: new Map([['y', 'r2']]) })).toBe(true);
    // At times that do not meet, a room is no clash.
    expect(world.landingsClash({ unit: x, to: there }, { unit: y, to: at(4, 720) })).toBe(false);
  });

  it('offers no other room unless it is asked to: a world made without the option answers every landing as it stands', () => {
    const context = new SwapContext({ ...base.data, lessons: [mover, holder] });
    const off = makeRoomWorldOf({ context, rooms: ROOMS, needsOf: () => NEEDS });
    const on = worldOf({ lessons: [mover, holder] });
    expect('otherRoom' in off).toBe(false);
    expect('otherRoom' in on.world).toBe(true);
    const x = context.unitOf.get('x')!;
    expect(off.inTheWay(x, TARGET).lessons.map((lesson) => lesson.id)).toEqual(on.world.inTheWay(on.context.unitOf.get('x')!, TARGET).lessons.map((lesson) => lesson.id));
  });

  it('answers the same for the same landing every time it is asked', () => {
    const { context, world } = worldOf({ lessons: [mover, holder] });
    const x = context.unitOf.get('x')!;
    expect(world.otherRoom!(x, TARGET)).toBe(world.otherRoom!(x, TARGET));
    expect(world.inTheWay(x, TARGET)).toBe(world.inTheWay(x, TARGET));
  });
});

describe('the school’s LOCK rules of rooms (g524): the generator keeps to them, so the room given is one they leave the lesson', () => {
  it('skips a room outside the rooms the lesson is locked to, takes the best that is inside, and offers none when none is left', () => {
    const { context } = worldOf({ lessons: [mover, holder] });
    const x = context.unitOf.get('x')!;
    const withLock = (allowed: string[] | null) =>
      makeRoomWorldOf({ context, rooms: ROOMS, needsOf: () => NEEDS, lockedRoomsOf: () => (allowed === null ? null : new Set(allowed)) }, { otherRooms: true });
    // Not locked: r2, the first by the generator's order.
    expect([...withLock(null).otherRoom!(x, TARGET)!.rooms!]).toEqual([['x', 'r2']]);
    // Locked to r4 and r5 (the own room r1 is outside, as a school may have laid it by hand): r4, which r2 and r3 do not matter to.
    expect([...withLock(['r4', 'r5']).otherRoom!(x, TARGET)!.rooms!]).toEqual([['x', 'r4']]);
    // Locked to the own room and a room that is taken then: no room to give.
    const taken = lessonOf('t', { studentGroupId: 'c9', groupName: 'C9', teacherId: 't9', roomId: 'r3', dayOfWeek: 2, startMinutes: 540, endMinutes: 600 });
    const crowded = worldOf({ lessons: [mover, holder, taken] });
    const lockedToTaken = makeRoomWorldOf({ context: crowded.context, rooms: ROOMS, needsOf: () => NEEDS, lockedRoomsOf: () => new Set(['r1', 'r3']) }, { otherRooms: true });
    expect(lockedToTaken.otherRoom!(crowded.context.unitOf.get('x')!, TARGET)).toBeUndefined();
  });

  it('asks the rule of the lesson it is choosing a room for, with what the lesson needs', () => {
    const { context } = worldOf({ lessons: [mover, holder] });
    const asked: Array<[string, RoomNeeds]> = [];
    const world = makeRoomWorldOf(
      { context, rooms: ROOMS, needsOf: () => NEEDS, lockedRoomsOf: (lesson, needs) => (asked.push([lesson.id, needs]), null) },
      { otherRooms: true },
    );
    world.otherRoom!(context.unitOf.get('x')!, TARGET);
    expect(asked).toEqual([['x', NEEDS]]);
  });
});

describe('against a plain reading of the hourly school', () => {
  it.each([3, 7, 11])('seed %i: for every lesson at every landing, another room is offered exactly when the own is the trouble and another is free, and it is the first free one', (seed) => {
    const data = makeWorld({ seed, classes: 5, teachers: 7, rooms: 5, perClass: 18 }).data;
    const context = new SwapContext(data);
    const world = makeRoomWorldOf({ context, rooms: ROOMS, needsOf: () => NEEDS }, { otherRooms: true });
    const lessons = data.lessons;
    let offered = 0;
    let refused = 0;
    let notTrouble = 0;
    for (const lesson of lessons) {
      const unit = context.unitOf.get(lesson.id)!;
      for (let day = 1; day <= 5; day += 1) {
        for (let start = 480; start <= 780; start += 60) {
          if (day === lesson.dayOfWeek && start === lesson.startMinutes) continue;
          const to = at(day, start);
          const others = lessons.filter((other) => other.id !== lesson.id && other.dayOfWeek === day && overlaps(start, start + 60, other.startMinutes, other.endMinutes));
          const byTeacherOrClass = others.filter((other) => other.studentGroupId === lesson.studentGroupId || (other.teacherId !== null && other.teacherId === lesson.teacherId));
          const byRoom = others.filter((other) => other.roomId === lesson.roomId);
          const free = ROOMS.map((entry) => entry.id).find((id) => id !== lesson.roomId && !others.some((other) => other.roomId === id));
          const got = world.otherRoom!(unit, to);
          const troubled = byRoom.some((other) => !byTeacherOrClass.includes(other));
          if (!troubled) {
            notTrouble += 1;
            expect(got).toBeUndefined();
          } else if (free === undefined) {
            refused += 1;
            expect(got).toBeUndefined();
          } else {
            offered += 1;
            expect(got).toBeDefined();
            expect([...got!.rooms!]).toEqual([[lesson.id, free]]);
            expect(new Set(got!.lessons.map((other) => other.id))).toEqual(new Set(byTeacherOrClass.map((other) => other.id)));
            expect(got!.closed).toBe(false);
          }
          // The first way is the school as it stands: every holder, the room's too.
          expect(new Set(world.inTheWay(unit, to).lessons.map((other) => other.id))).toEqual(new Set([...byTeacherOrClass, ...byRoom].map((other) => other.id)));
        }
      }
    }
    expect(offered).toBeGreaterThan(20);
    expect(notTrouble).toBeGreaterThan(100);
    expect(refused).toBeGreaterThanOrEqual(0);
  });
});
