import type { RoomNeeds } from '../optimization/room-eligibility';
import type { RoomFact } from '../calendar/possible-times';
import { makeWorld } from '../swaps/__fixtures__/swap-world';
import { SwapContext } from '../swaps/swap-context';
import type { SwapData } from '../swaps/swap-snapshot';
import type { SwapLesson } from '../swaps/swap-types';
import { planFill, pointsOf, windowOfFrames, type FillBrick, type FillOptions, type FillOrder, type FillWorld } from './fill-plan';

/*
 * LÄGG DET SOM GÅR, the pure planner (E7a): held against what a brute force knows (nothing but "does anything overlap"), on the swap tests' hourly school
 * and on small worlds laid by hand so that the order of the bricks is what decides.
 */

const base = makeWorld({ seed: 5, classes: 3, perClass: 0 });
const NEEDS: RoomNeeds = { studentGroupSize: 3, minGradeLevel: 7, maxGradeLevel: 7, requiredRoomTypeId: null };
const WINDOW = { days: [1, 2, 3, 4, 5], fromMinutes: 480, toMinutes: 840 };

const lessonOf = (id: string, classId: string, day: number, start: number, over: Partial<SwapLesson> = {}): SwapLesson => ({
  id,
  subjectId: 's1',
  subjectName: 'Matematik',
  studentGroupId: classId,
  groupName: classId.toUpperCase(),
  teacherId: `t-${id}`,
  coTeacherId: null,
  roomId: null,
  dayOfWeek: day,
  startMinutes: start,
  endMinutes: start + 60,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  isLocked: false,
  isGenerated: true,
  extraGroupIds: [],
  studentIds: [],
  ...over,
});

/** A brick: a lesson of this class and teacher that stands nowhere. */
const brickOf = (key: string, classId: string, teacherId: string, minutes = 60, over: Partial<SwapLesson> = {}): FillBrick => ({
  key,
  lesson: lessonOf(`fill:${key}`, classId, 1, 0, { teacherId, endMinutes: minutes, isGenerated: false, ...over }),
});

const closed = (resource: 'STUDENT_GROUP' | 'TEACHER', id: string, day: number, start: number, end: number): SwapData['constraints'][number] => ({
  resourceType: resource,
  userId: resource === 'TEACHER' ? id : null,
  roomId: null,
  studentGroupId: resource === 'STUDENT_GROUP' ? id : null,
  minGradeLevel: null,
  maxGradeLevel: null,
  dayOfWeek: day,
  startMinutes: start,
  endMinutes: end,
});

function worldWith(data: Partial<SwapData>, rooms: RoomFact[] = [], needs: RoomNeeds | null = NEEDS): FillWorld {
  return { data: { ...base.data, lessons: [], posts: [], ...data }, rooms, wishes: [], needsOf: () => needs, closedWeeks: null, sharedRooms: new Set() };
}

const options = (over: Partial<FillOptions> = {}): FillOptions => ({ order: 'FEWEST', choice: 'EARLIEST', stepMinutes: 60, ...over });

describe('the order is what decides: the brick with the fewest free starts goes first', () => {
  // Teacher Z teaches two bricks of an hour, on Monday between 08:00 and 11:00. Class c1 is open only 09:00–10:00, so its brick has one start. Class c2 is
  // closed before 09:00, so its brick has 09:00 and 10:00; by the keys it comes first, and on its earliest start it takes the only start the other has.
  const trap = (): FillWorld =>
    worldWith({
      constraints: [
        closed('STUDENT_GROUP', 'c1', 1, 480, 540),
        closed('STUDENT_GROUP', 'c1', 1, 600, 660),
        closed('STUDENT_GROUP', 'c2', 1, 480, 540),
      ],
    });
  const bricks = [brickOf('a', 'c2', 'Z'), brickOf('b', 'c1', 'Z')];
  const window = { days: [1], fromMinutes: 480, toMinutes: 660 };

  it('loses the brick with one start when the bricks are taken in the tray\'s order', async () => {
    const plan = await planFill(trap(), bricks, window, options({ order: 'LONGEST' }));
    expect(plan.placed.map((entry) => entry.brick.key)).toEqual(['a']);
    expect(plan.left.map((entry) => [entry.brick.key, entry.reason])).toEqual([['b', 'NO_FREE_START']]);
  });

  it.each(['FEWEST_ONCE', 'FEWEST_EXACT', 'FEWEST'] as FillOrder[])('lays both when the order is %s', async (order) => {
    const plan = await planFill(trap(), bricks, window, options({ order }));
    expect(plan.left).toEqual([]);
    expect(plan.placed.map((entry) => [entry.brick.key, entry.startMinutes])).toEqual([
      ['b', 540],
      ['a', 600],
    ]);
  });
});

describe('the incremental order counts again the bricks a laid lesson touched', () => {
  // a (teacher Z) has one start, 08:00. b (also Z) has three, c (another teacher) has two. The count stands in the order a, c, b until a is laid: it takes Z's 08:00 from b,
  // which has two left and is before c by its key. Left uncounted, b still has three and c goes before it.
  const world = (): FillWorld =>
    worldWith({
      constraints: [closed('STUDENT_GROUP', 'c1', 1, 540, 840), closed('STUDENT_GROUP', 'c2', 1, 660, 840), closed('STUDENT_GROUP', 'c3', 1, 600, 840)],
    });
  const bricks = [brickOf('a', 'c1', 'Z'), brickOf('b', 'c2', 'Z'), brickOf('c', 'c3', 'T3')];
  const window = { days: [1], fromMinutes: 480, toMinutes: 840 };

  it('lays b before c once a has taken the teacher\'s first hour from it', async () => {
    const plan = await planFill(world(), bricks, window, options({ order: 'FEWEST', stepMinutes: 60 }));
    expect(plan.placed.map((entry) => entry.brick.key)).toEqual(['a', 'b', 'c']);
  });

  it('counts again a brick of a group that shares a pupil with the class laid in, with no teacher in common', async () => {
    // The teaching group g holds a pupil of c1: a lesson of c1 at 08:00 takes 08:00 from g though no teacher is the same.
    const shared = worldWith({
      groups: [...base.data.groups, { id: 'g', name: 'G', kind: 'TEACHING_GROUP', halfOfId: null, replacesSubjectId: null, gradeLevel: null }],
      rosters: {
        ...base.data.rosters,
        membersByGroup: new Map([...base.data.rosters.membersByGroup, ['g', new Set(['p-c1-1'])]]),
        groupsByStudent: new Map([...base.data.rosters.groupsByStudent, ['p-c1-1', new Set(['c1', 'g'])]]),
      },
      constraints: [closed('STUDENT_GROUP', 'c1', 1, 540, 840), closed('STUDENT_GROUP', 'g', 1, 660, 840), closed('STUDENT_GROUP', 'c3', 1, 600, 840)],
    });
    const plan = await planFill(shared, [brickOf('a', 'c1', 'T1'), brickOf('b', 'g', 'T2'), brickOf('c', 'c3', 'T3')], window, options({ order: 'FEWEST', stepMinutes: 60 }));
    expect(plan.placed.map((entry) => entry.brick.key)).toEqual(['a', 'b', 'c']);
  });

  it('is the order the exact count gives, which counts every brick again every time', async () => {
    const plan = await planFill(world(), bricks, window, options({ order: 'FEWEST_EXACT', stepMinutes: 60 }));
    expect(plan.placed.map((entry) => entry.brick.key)).toEqual(['a', 'b', 'c']);
  });

  it('is the order of the first count, a c b, when the count is made once', async () => {
    const plan = await planFill(world(), bricks, window, options({ order: 'FEWEST_ONCE', stepMinutes: 60 }));
    expect(plan.placed.map((entry) => entry.brick.key)).toEqual(['a', 'c', 'b']);
  });
});

describe('the time a brick is laid on: the cheapest, or the cheapest that leaves the others a start', () => {
  // Teacher Z teaches two bricks on Monday between 08:00 and 14:00. X (two hours, class c2) can stand 09:00–11:00 or 12:00–14:00; Y (an hour, class c1) can
  // stand at 09:00 or at 10:00. On the cost alone X takes the earlier time, which holds Z for both of Y's: Y is left. The one that keeps the others open
  // takes 12:00 for X and has room for Y.
  const world = (): FillWorld =>
    worldWith({
      constraints: [
        closed('STUDENT_GROUP', 'c2', 1, 480, 540),
        closed('STUDENT_GROUP', 'c2', 1, 660, 720),
        closed('STUDENT_GROUP', 'c1', 1, 480, 540),
        closed('STUDENT_GROUP', 'c1', 1, 660, 840),
      ],
    });
  const bricks = [brickOf('x', 'c2', 'Z', 120), brickOf('y', 'c1', 'Z', 60)];
  const window = { days: [1], fromMinutes: 480, toMinutes: 840 };

  it('lays the cheapest first and loses a brick to it', async () => {
    const plan = await planFill(world(), bricks, window, options({ choice: 'COST', stepMinutes: 60 }));
    expect(plan.placed.map((entry) => [entry.brick.key, entry.startMinutes])).toEqual([['x', 540]]);
    expect(plan.left.map((entry) => [entry.brick.key, entry.reason])).toEqual([['y', 'NO_FREE_START']]);
  });

  it('takes the cheapest of the starts that leave every other brick one, and lays both', async () => {
    const plan = await planFill(world(), bricks, window, options({ choice: 'KEEP_OPEN', stepMinutes: 60 }));
    expect(plan.left).toEqual([]);
    // Y at 10:00 and not 09:00: with X at 12:00 the teacher's gap is an hour there and two at 09:00, and the cost is what chooses among the starts that are left.
    expect(plan.placed.map((entry) => [entry.brick.key, entry.startMinutes])).toEqual([
      ['x', 720],
      ['y', 600],
    ]);
  });

  it('is the cheapest under an order that does not count what the others have left', async () => {
    const plan = await planFill(world(), bricks, window, options({ order: 'LONGEST', choice: 'KEEP_OPEN', stepMinutes: 60 }));
    expect(plan.placed.map((entry) => [entry.brick.key, entry.startMinutes])).toEqual([['x', 540]]);
  });
});

describe('what a laid brick is held to', () => {
  it('is laid on a start the world has nobody in: no clash of teacher, class or room, with the bricks laid before it standing', async () => {
    // A brute force on random worlds: take lessons out, put them back, and replay every placement in order against a fresh context.
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const school = makeWorld({ seed, classes: 4, teachers: 5, rooms: 4, perClass: 18 });
      const gone = school.data.lessons.filter((_, index) => index % 4 === 0);
      const goneIds = new Set(gone.map((lesson) => lesson.id));
      const data = { ...school.data, lessons: school.data.lessons.filter((lesson) => !goneIds.has(lesson.id)) };
      const rooms: RoomFact[] = ['r1', 'r2', 'r3', 'r4'].map((id) => ({ id, name: id, capacity: 30, roomTypeId: null, minGradeLevel: null, maxGradeLevel: null, building: null }));
      const bricks = gone.map((lesson): FillBrick => ({ key: lesson.id, lesson: { ...lesson, id: `fill:${lesson.id}`, roomId: null, dayOfWeek: 1, startMinutes: 0, endMinutes: 60 } }));
      const world: FillWorld = { data, rooms, wishes: [], needsOf: () => NEEDS, closedWeeks: null, sharedRooms: new Set() };
      for (const order of ['LONGEST', 'FEWEST'] as FillOrder[]) {
        const plan = await planFill(world, bricks, { days: [1, 2, 3, 4, 5], fromMinutes: 480, toMinutes: 840 }, options({ order, choice: 'COST' }));
        expect(plan.placed.length + plan.left.length).toBe(bricks.length);
        const standing = [...data.lessons];
        for (const entry of plan.placed) {
          const asLesson: SwapLesson = { ...entry.brick.lesson, id: entry.brick.key, dayOfWeek: entry.dayOfWeek, startMinutes: entry.startMinutes, endMinutes: entry.endMinutes, roomId: entry.roomId };
          const context = new SwapContext({ ...data, lessons: standing }, {});
          const way = context.inTheWay({ lesson: asLesson, to: { dayOfWeek: asLesson.dayOfWeek, startMinutes: asLesson.startMinutes, endMinutes: asLesson.endMinutes } }, new Set());
          expect([seed, order, entry.brick.key, way.lessons.map((lesson) => lesson.id), way.closures]).toEqual([seed, order, entry.brick.key, [], []]);
          expect(entry.roomId === null || ['r1', 'r2', 'r3', 'r4'].includes(entry.roomId)).toBe(true);
          standing.push(asLesson);
        }
      }
    }
  });

  it('moves nothing that stands: the world it was given is the world it leaves', async () => {
    const school = makeWorld({ seed: 9, classes: 3, perClass: 14 });
    const before = JSON.stringify(school.data.lessons);
    const world: FillWorld = { data: school.data, rooms: [], wishes: [], needsOf: () => null, closedWeeks: null, sharedRooms: new Set() };
    const bricks = [brickOf('x', 'c1', 'tx'), brickOf('y', 'c2', 'ty'), brickOf('z', 'c3', 'tz')];
    const plan = await planFill(world, bricks, WINDOW, options({ choice: 'COST' }));
    expect(plan.placed.length).toBe(3);
    expect(JSON.stringify(school.data.lessons)).toBe(before);
    expect(plan.placed.every((entry) => !('exempt' in entry))).toBe(true);
  });

  it('never lays a brick outside the frame, in the class\'s meal or in a closed hour of its teacher, since the prune closes them and the fill gives no exemption', async () => {
    const world = worldWith({
      frames: [{ min: 7, max: 7, day: null, start: 540, end: 660 }],
      sittings: [{ studentGroupId: 'c1', dayOfWeek: 1, startMinutes: 600, endMinutes: 630 }],
      constraints: [closed('TEACHER', 'T', 1, 540, 570)],
      groups: base.data.groups,
    });
    const plan = await planFill(world, [brickOf('a', 'c1', 'T', 30)], { days: [1], fromMinutes: 480, toMinutes: 720 }, options({ stepMinutes: 15 }));
    // 09:00–09:30 is the teacher's closed half hour, 10:00–10:30 the meal, and the frame ends at 11:00: 09:30 is the first start there is.
    expect(plan.placed.map((entry) => [entry.startMinutes, entry.endMinutes])).toEqual([[570, 600]]);
    const everywhere = await planFill(world, [brickOf('b', 'c1', 'T', 30)], { days: [1], fromMinutes: 480, toMinutes: 720 }, options({ stepMinutes: 15, choice: 'COST' }));
    for (const entry of everywhere.placed) {
      expect(entry.startMinutes).toBeGreaterThanOrEqual(540);
      expect(entry.endMinutes).toBeLessThanOrEqual(660);
      expect(entry.startMinutes < 630 && 600 < entry.endMinutes).toBe(false);
    }
  });
});

describe('the answer', () => {
  it('says "not laid" for a brick no start fits, and lays the others', async () => {
    const world = worldWith({ constraints: [closed('TEACHER', 'Gone', 1, 0, 1440), closed('TEACHER', 'Gone', 2, 0, 1440), closed('TEACHER', 'Gone', 3, 0, 1440), closed('TEACHER', 'Gone', 4, 0, 1440), closed('TEACHER', 'Gone', 5, 0, 1440)] });
    const plan = await planFill(world, [brickOf('a', 'c1', 'Gone'), brickOf('b', 'c2', 'Here')], WINDOW, options());
    expect(plan.placed.map((entry) => entry.brick.key)).toEqual(['b']);
    expect(plan.left).toEqual([{ brick: expect.objectContaining({ key: 'a' }), reason: 'NO_FREE_START', freeStarts: 0 }]);
  });

  it('asks the judge in the order of the cost and lays on the first start it lets through, naming which of them that was', async () => {
    const asked: number[] = [];
    const plan = await planFill(worldWith({}), [brickOf('a', 'c1', 'T')], WINDOW, options({ judge: async (candidate) => (asked.push(candidate.startMinutes), asked.length >= 3) }));
    expect(asked).toHaveLength(3);
    expect(plan.placed[0]).toMatchObject({ rank: 3, startMinutes: asked[2] });
  });

  it('leaves a brick the judge refused every start of, as JUDGE, after the tries it was given', async () => {
    let tries = 0;
    const plan = await planFill(worldWith({}), [brickOf('a', 'c1', 'T')], WINDOW, options({ judgeTries: 4, judge: async () => (tries++, false) }));
    expect(tries).toBe(4);
    expect(plan.left).toEqual([{ brick: expect.objectContaining({ key: 'a' }), reason: 'JUDGE', freeStarts: expect.any(Number) }]);
  });

  it('leaves the bricks not begun when the time is out, as TIME, and keeps what it had laid', async () => {
    // The clock moves 100 ms with every judgement; the time given is 150: two bricks are begun, and the third is not.
    let clock = 0;
    const plan = await planFill(
      worldWith({}),
      [brickOf('a', 'c1', 'T1'), brickOf('b', 'c2', 'T2'), brickOf('c', 'c3', 'T3')],
      WINDOW,
      options({ order: 'LONGEST', budgetMs: 150, now: () => clock, judge: async () => ((clock += 100), true) }),
    );
    expect(plan.placed.map((entry) => entry.brick.key)).toEqual(['a', 'b']);
    expect(plan.left).toEqual([{ brick: expect.objectContaining({ key: 'c' }), reason: 'TIME', freeStarts: -1 }]);
  });

  it('tells the callback of each brick as it is laid, in order, before the next is asked about', async () => {
    const told: string[] = [];
    const asked: string[] = [];
    await planFill(worldWith({}), [brickOf('a', 'c1', 'T1'), brickOf('b', 'c2', 'T2')], WINDOW, options({ order: 'LONGEST', onPlaced: (placed) => told.push(placed.brick.key), judge: async (candidate) => (asked.push(`${candidate.brick.key}:${told.join('')}`), true) }));
    expect(told).toEqual(['a', 'b']);
    expect(asked).toEqual(['a:', 'b:a']);
  });
});

describe('the room', () => {
  const rooms: RoomFact[] = [
    { id: 'big', name: 'Stor', capacity: 30, roomTypeId: null, minGradeLevel: null, maxGradeLevel: null, building: null },
    { id: 'small', name: 'Liten', capacity: 4, roomTypeId: null, minGradeLevel: null, maxGradeLevel: null, building: null },
  ];

  it('is the smallest the generator\'s rule allows that nothing holds at the time', async () => {
    const plan = await planFill(worldWith({}, rooms), [brickOf('a', 'c1', 'T')], WINDOW, options());
    expect(plan.placed[0]!.roomId).toBe('small');
  });

  it('is another when the first is taken by a lesson that stands', async () => {
    const taken = lessonOf('stands', 'c3', 1, 480, { roomId: 'small', teacherId: 'Other' });
    const plan = await planFill(worldWith({ lessons: [taken] }, rooms), [brickOf('a', 'c1', 'T')], { days: [1], fromMinutes: 480, toMinutes: 600 }, options());
    expect(plan.placed[0]).toMatchObject({ startMinutes: 480, roomId: 'big' });
  });

  it('is none when the school has no room the rule allows, and the brick is laid all the same', async () => {
    const plan = await planFill(worldWith({}, rooms, { ...NEEDS, studentGroupSize: 60 }), [brickOf('a', 'c1', 'T')], WINDOW, options());
    expect(plan.placed[0]!.roomId).toBeNull();
  });

  it('closes a start for want of a room when rooms there are and every one is taken then', async () => {
    const both = [lessonOf('s1', 'c2', 1, 480, { roomId: 'big', teacherId: 'O1' }), lessonOf('s2', 'c3', 1, 480, { roomId: 'small', teacherId: 'O2' })];
    const plan = await planFill(worldWith({ lessons: both }, rooms), [brickOf('a', 'c1', 'T')], { days: [1], fromMinutes: 480, toMinutes: 600 }, options());
    expect(plan.placed[0]!.startMinutes).toBe(540);
  });
});

describe('the starts asked about', () => {
  it('are the grid with STEP, and the points where something begins or ends with POINTS, so a lesson that packs against another is laid there', async () => {
    const standing = lessonOf('stands', 'c1', 1, 480, { endMinutes: 525, teacherId: 'Other' });
    const world = worldWith({ lessons: [standing] });
    const window = { days: [1], fromMinutes: 480, toMinutes: 720 };
    const onGrid = await planFill(world, [brickOf('a', 'c1', 'T', 45)], window, options({ stepMinutes: 60 }));
    const onPoints = await planFill(world, [brickOf('a', 'c1', 'T', 45)], window, options({ stepMinutes: 60, starts: 'POINTS' }));
    expect(onGrid.placed[0]!.startMinutes).toBe(540);
    expect(onPoints.placed[0]!.startMinutes).toBe(525);
  });

  it('are the points of the school: the lessons\' starts and ends, the meals, the closed hours, the frame', () => {
    const data = { ...base.data, lessons: [lessonOf('x', 'c1', 1, 495)], sittings: [{ studentGroupId: 'c1', dayOfWeek: 1, startMinutes: 700, endMinutes: 730 }], constraints: [closed('TEACHER', 'T', 1, 600, 640)], frames: [{ min: 7, max: 9, day: null, start: 480, end: 900 }] };
    expect(pointsOf(data, { fromMinutes: 480, toMinutes: 900 })).toEqual([480, 495, 555, 600, 640, 700, 730, 900]);
  });

  it('are the days and the hours the frames give: a school with no frame asks the weekdays, seven to eighteen', () => {
    expect(windowOfFrames({ ...base.data, frames: [] })).toEqual({ days: [1, 2, 3, 4, 5], fromMinutes: 420, toMinutes: 1080 });
    expect(windowOfFrames({ ...base.data, frames: [{ min: 7, max: 9, day: 2, start: 500, end: 800 }, { min: 7, max: 9, day: 4, start: 480, end: 900 }] })).toEqual({ days: [2, 4], fromMinutes: 480, toMinutes: 900 });
  });
});
