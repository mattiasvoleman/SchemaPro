import { proposalId } from './swap-search';
import { searchMakeRoom, type MakeRoomInput, type MakeRoomWay } from './swap-make-room';
import { buildUnits, slotKey } from './swap-units';
import type { SwapLesson, SwapMove, SwapSlot, SwapUnit } from './swap-types';

/*
 * E5a, ANNAN LEDIG SAL, Klart (a) for the rooms: THE SEARCH GIVES EXACTLY THE PROPOSALS AN EXHAUSTIVE CHECK GIVES, THE ROOMS COUNTED.
 *
 * swap-make-room.spec.ts holds the search to a brute force on a school where a lesson keeps its room. This is the same school with a
 * fourth room, two rooms that a weekly row shuts on some days, and the rule of swap-rooms.ts for what a displaced lesson may do when its
 * own room is held: take the best other room that is free then, as a SECOND way to the same landing. The brute force tries every
 * assignment of every subset of the unlocked units to every place of the grid in every room way, and keeps the sets that hold the list in
 * the head of swap-make-room.ts with that one rule added; it shares no code with the search.
 *
 * What the two share on purpose is the rule's own reading of the school (`altRoom`: when the own room is the trouble and which room is
 * the best free one), as the first spec shares `holds`. That reading is held against the real SwapContext, with the generator's room
 * order, in swap-rooms.spec.ts; what is held here is what the SEARCH does with a world that offers a room.
 */

const DAYS = [1, 2, 3];
const STARTS = [480, 540, 600, 660];
const HOUR = 60;
/** The school's rooms in the order the generator would give them: the first free one that is not the lesson's own is the one it takes. */
const ROOMS = ['r1', 'r2', 'r3', 'r4'];

function random(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const lesson = (id: string, day: number, start: number, over: Partial<SwapLesson> = {}): SwapLesson => ({
  id,
  subjectId: `s-${id}`,
  subjectName: id,
  studentGroupId: 'c1',
  groupName: 'C1',
  teacherId: null,
  coTeacherId: null,
  roomId: null,
  dayOfWeek: day,
  startMinutes: start,
  endMinutes: start + HOUR,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  isLocked: false,
  isGenerated: true,
  extraGroupIds: [],
  studentIds: [],
  ...over,
});

const slotOf = (l: SwapLesson): SwapSlot => ({ dayOfWeek: l.dayOfWeek, startMinutes: l.startMinutes, endMinutes: l.endMinutes });
const overlap = (a: SwapSlot, b: SwapSlot): boolean => a.dayOfWeek === b.dayOfWeek && a.startMinutes < b.endMinutes && b.startMinutes < a.endMinutes;
const landing = (member: SwapLesson, to: SwapSlot): SwapSlot => ({ dayOfWeek: to.dayOfWeek, startMinutes: to.startMinutes, endMinutes: to.startMinutes + (member.endMinutes - member.startMinutes) });

/** A weekly row that shuts a room: r3 on day 3, r4 on days 2 and 3. */
const roomShut = (room: string | null, day: number): boolean => room !== null && ((room === 'r3' && day === 3) || (room === 'r4' && (day === 2 || day === 3)));
/** A rule that shuts a stretch whatever else is there: class c1 has no lesson at 08:00 on day 3. */
const shut = (l: SwapLesson, at: SwapSlot): boolean => l.studentGroupId === 'c1' && at.dayOfWeek === 3 && at.startMinutes === 480;

/** What a double booking is: the room taken as `roomOf` says (a lesson's own unless a room change gives it another). */
function holds(a: SwapLesson, at: SwapSlot, b: SwapLesson, bt: SwapSlot, ra: string | null = a.roomId, rb: string | null = b.roomId): boolean {
  if (a.id === b.id || !overlap(at, bt)) return false;
  return a.studentGroupId === b.studentGroupId || (ra !== null && ra === rb) || (a.teacherId !== null && a.teacherId === b.teacherId);
}

interface Mini {
  lessons: SwapLesson[];
  unitOf: Map<string, SwapUnit>;
  units: SwapUnit[];
}

/** Three classes, three teachers and four rooms on twelve hourly places, about two thirds full, a lesson locked here and there, one block of two. */
function miniWorld(seed: number, lockedShare = 0.12): Mini {
  const next = random(seed);
  const lessons: SwapLesson[] = [];
  const taken = new Set<string>();
  let n = 0;
  for (const group of ['c1', 'c2', 'c3']) {
    for (const day of DAYS) {
      for (const start of STARTS) {
        if (next() > 0.62) continue;
        const key = `${day}|${start}`;
        const teacher = ['t1', 't2', 't3'].sort(() => next() - 0.5).find((id) => !taken.has(`${id}|${key}`));
        const room = [...ROOMS].sort(() => next() - 0.5).find((id) => !taken.has(`${id}|${key}`) && !roomShut(id, day));
        if (!teacher || !room) continue;
        taken.add(`${teacher}|${key}`);
        taken.add(`${room}|${key}`);
        n += 1;
        lessons.push(lesson(`l${String(n).padStart(2, '0')}`, day, start, { studentGroupId: group, teacherId: teacher, roomId: room, isLocked: next() < lockedShare }));
      }
    }
  }
  for (const day of DAYS) {
    const start = STARTS[Math.floor(next() * STARTS.length)]!;
    const here = lessons.filter((l) => l.dayOfWeek === day && l.startMinutes === start);
    const groups = ['c1', 'c2', 'c3'].filter((g) => !here.some((l) => l.studentGroupId === g));
    const teachers = ['t1', 't2', 't3'].filter((t) => !here.some((l) => l.teacherId === t));
    const rooms = ROOMS.filter((r) => !here.some((l) => l.roomId === r) && !roomShut(r, day));
    if (groups.length < 2 || teachers.length < 2 || rooms.length < 2) continue;
    for (const index of [0, 1]) {
      n += 1;
      lessons.push(lesson(`b${n}`, day, start, { studentGroupId: groups[index]!, teacherId: teachers[index]!, roomId: rooms[index]!, subjectId: 'sB' }));
    }
    break;
  }
  const blockOf = (l: SwapLesson) => (l.subjectId === 'sB' ? 'B' : null);
  const unitOf = buildUnits(lessons, { blockOf, sameTimesOf: () => null, groupFacts: new Map(), sharesPupils: () => false });
  return { lessons, unitOf, units: [...new Map([...unitOf.values()].map((u) => [u.id, u])).values()] };
}

/**
 * THE ROOM RULE, as swap-rooms.ts says it (the head of that file): a unit of one lesson that stands in a room, landing where the room is the
 * trouble and nothing else shuts the stretch, takes the first room of the school's order that is not its own and that no lesson stands in
 * then and no row shuts. The holders of its own room are then no one in the way.
 */
function altRoom(world: Mini, unit: SwapUnit, at: SwapSlot): { holders: SwapLesson[]; room: string } | undefined {
  if (unit.members.length !== 1) return undefined;
  const member = unit.members[0]!;
  if (member.roomId === null) return undefined;
  const to = landing(member, at);
  if (shut(member, to)) return undefined;
  const bare = world.lessons.filter((other) => holds(member, to, other, slotOf(other), null));
  const heldBy = world.lessons.filter((other) => other.id !== member.id && other.roomId === member.roomId && overlap(to, slotOf(other)));
  if (!(roomShut(member.roomId, to.dayOfWeek) || heldBy.some((other) => !bare.includes(other)))) return undefined;
  const free = ROOMS.find((room) => room !== member.roomId && !roomShut(room, to.dayOfWeek) && !world.lessons.some((other) => other.id !== member.id && other.roomId === room && overlap(to, slotOf(other))));
  return free === undefined ? undefined : { holders: bare, room: free };
}

type Rooms = ReadonlyMap<string, string> | undefined;

/** A unit at a slot in some rooms, and a unit at another: any member of one holds what any member of the other holds. */
const unitsHold = (a: SwapUnit, at: SwapSlot, ra: Rooms, b: SwapUnit, bt: SwapSlot, rb: Rooms): boolean =>
  a.members.some((m) => b.members.some((o) => holds(m, landing(m, at), o, landing(o, bt), ra?.get(m.id) ?? m.roomId, rb?.get(o.id) ?? o.roomId)));

function moveOf(unit: SwapUnit, to: SwapSlot, rooms: Rooms): SwapMove[] {
  return unit.members.map((m) => {
    const room = rooms?.get(m.id);
    return { lessonId: m.id, from: slotOf(m), to: landing(m, to), ...(room !== undefined && m.roomId !== null ? { room: { from: m.roomId, to: room } } : {}) };
  });
}

/** The order a set's moves are listed by, for the order the search must give two sets of the same times. */
const keyOf = (moves: readonly SwapMove[]): string => [...moves].map((move) => `${move.lessonId}>${slotKey(move.to)}${move.room ? `@${move.room.to}` : ''}`).sort().join(';');
const timesOf = (moves: readonly SwapMove[]): string => [...moves].map((move) => `${move.lessonId}>${slotKey(move.to)}`).sort().join(';');
const changesOf = (moves: readonly SwapMove[]): number => moves.filter((move) => move.room !== undefined).length;

interface Ask {
  picked: SwapUnit;
  placed: boolean;
  target: { dayOfWeek: number; startMinutes: number };
  depth: number;
  maxUnits: number;
}

interface Way {
  to: SwapSlot;
  rooms: Rooms;
}

/** Every set of moves that is a proposal by the list in the head of swap-make-room.ts and the room rule, the one that changes fewest rooms of each set of times. */
function bruteForce(world: Mini, ask: Ask): Map<string, { depth: number; units: number; changes: number }> {
  const { picked, depth, maxUnits } = ask;
  const to: SwapSlot = { dayOfWeek: ask.target.dayOfWeek, startMinutes: ask.target.startMinutes, endMinutes: ask.target.startMinutes + HOUR };
  const others = world.units.filter((u) => u.id !== picked.id && !u.locked);
  const places: SwapSlot[] = DAYS.flatMap((dayOfWeek) => STARTS.map((startMinutes) => ({ dayOfWeek, startMinutes, endMinutes: startMinutes + HOUR })));
  const closed = (unit: SwapUnit, at: SwapSlot): boolean => unit.members.some((m) => shut(m, landing(m, at)) || roomShut(m.roomId, at.dayOfWeek));
  /** The ways a unit may stand at a place: its own rooms, and the other room the rule gives it. */
  const waysAt = (unit: SwapUnit, at: SwapSlot): Way[] => {
    const ways: Way[] = [];
    if (!closed(unit, at)) ways.push({ to: at, rooms: undefined });
    const alt = altRoom(world, unit, at);
    if (alt) ways.push({ to: at, rooms: new Map([[unit.members[0]!.id, alt.room]]) });
    return ways;
  };
  const best = new Map<string, { moves: SwapMove[]; depth: number; units: number; changes: number }>();
  const pickedWays = waysAt(picked, to);

  const subsets: SwapUnit[][] = [[]];
  const grow = (from: number, chosen: SwapUnit[]) => {
    for (let i = from; i < others.length; i += 1) {
      const set = [...chosen, others[i]!];
      if (set.length + 1 > maxUnits) return;
      subsets.push(set);
      grow(i + 1, set);
    }
  };
  grow(0, []);

  for (const pickedWay of pickedWays) {
    for (const subset of subsets) {
      const moving = new Set([picked.id, ...subset.map((u) => u.id)]);
      const stay = world.units.filter((u) => !moving.has(u.id));
      if (stay.some((u) => unitsHold(picked, to, pickedWay.rooms, u, u.slot, undefined))) continue;
      const options = subset.map((unit) =>
        places
          .filter((place) => !(place.dayOfWeek === unit.slot.dayOfWeek && place.startMinutes === unit.slot.startMinutes))
          .flatMap((place) => waysAt(unit, place))
          .filter((way) => !stay.some((u) => unitsHold(unit, way.to, way.rooms, u, u.slot, undefined))),
      );
      const choose = (index: number, placed: Array<{ unit: SwapUnit; way: Way }>) => {
        if (index === subset.length) {
          const all = [{ unit: picked, way: pickedWay }, ...placed];
          // Every unit that moves stood in the way of one that moves, reached from the picked unit, within `depth` levels.
          const level = new Map<string, number>([[picked.id, 0]]);
          const queue = [picked.id];
          for (let head = 0; head < queue.length; head += 1) {
            const from = all.find((p) => p.unit.id === queue[head])!;
            for (const other of all) {
              if (level.has(other.unit.id)) continue;
              if (unitsHold(from.unit, from.way.to, from.way.rooms, other.unit, other.unit.slot, undefined)) {
                level.set(other.unit.id, level.get(from.unit.id)! + 1);
                queue.push(other.unit.id);
              }
            }
          }
          if (all.some((p) => !level.has(p.unit.id))) return;
          const deepest = Math.max(...level.values());
          if (deepest > depth) return;
          const moves = all.flatMap((p) => moveOf(p.unit, p.way.to, p.way.rooms));
          const times = timesOf(moves);
          const known = best.get(times);
          const changes = changesOf(moves);
          if (!known || changes < known.changes || (changes === known.changes && keyOf(moves) < keyOf(known.moves))) {
            best.set(times, { moves, depth: deepest, units: all.length, changes });
          }
          return;
        }
        for (const way of options[index]!) {
          const here = { unit: subset[index]!, way };
          // No two landings hold the same teacher, room or class at once.
          if ([{ unit: picked, way: pickedWay }, ...placed].some((p) => unitsHold(here.unit, here.way.to, here.way.rooms, p.unit, p.way.to, p.way.rooms))) continue;
          choose(index + 1, [...placed, here]);
        }
      };
      choose(0, []);
    }
  }
  return new Map([...best.values()].map((entry) => [proposalId(entry.moves), { depth: entry.depth, units: entry.units, changes: entry.changes }]));
}

/** The search over the same world: the plain overlap as the prune, the room rule as the world's second way, the judge the whole school after the moves. */
function search(world: Mini, ask: Ask, over: Partial<MakeRoomInput> = {}) {
  const lessonsOf = (unit: SwapUnit) => new Set(unit.members.map((m) => m.id));
  const standing = (unit: SwapUnit, at: SwapSlot): MakeRoomWay => {
    const own = lessonsOf(unit);
    const lessons = world.lessons.filter((other) => !own.has(other.id) && unit.members.some((m) => holds(m, landing(m, at), other, slotOf(other))));
    return { lessons, closed: unit.members.some((m) => shut(m, landing(m, at)) || roomShut(m.roomId, at.dayOfWeek)) };
  };
  return searchMakeRoom({
    picked: ask.picked,
    placed: ask.placed,
    target: ask.target,
    unitOf: ask.placed ? world.unitOf : new Map([...world.unitOf].filter(([id]) => !lessonsOf(ask.picked).has(id))),
    starts: STARTS,
    days: DAYS,
    world: {
      inTheWay: standing,
      otherRoom: (unit, at) => {
        const alt = altRoom(world, unit, at);
        return alt ? { lessons: alt.holders, closed: false, rooms: new Map([[unit.members[0]!.id, alt.room]]) } : undefined;
      },
      landingsClash: (a, b) => unitsHold(a.unit, a.to, a.rooms, b.unit, b.to, b.rooms),
    },
    // A room change costs a little: of two sets of the same times the one that changes fewer rooms is first.
    soft: (moves) => ({ costs: [], score: moves.length + 0.1 * changesOf(moves) }),
    judge: async (sets) =>
      sets.map((moves) => {
        const moved = new Map(moves.map((m) => [m.lessonId, m]));
        const after = world.lessons.map((l) => ({ l, at: moved.get(l.id)?.to ?? slotOf(l), room: moved.get(l.id)?.room?.to ?? l.roomId }));
        return !after.some(({ l, at, room }, i) => after.slice(i + 1).some((o) => holds(l, at, o.l, o.at, room, o.room)) || roomShut(room, at.dayOfWeek));
      }),
    limit: 1_000_000,
    budgetMs: 1_000_000,
    depth: ask.depth,
    maxUnits: ask.maxUnits,
    ...over,
  });
}

function asks(world: Mini, depth: number, maxUnits: number, every: number): Ask[] {
  const targets = DAYS.flatMap((dayOfWeek) => STARTS.map((startMinutes) => ({ dayOfWeek, startMinutes })));
  const out: Ask[] = [];
  world.units
    .filter((_, index) => index % every === 0)
    .forEach((picked) => {
      for (const target of targets) {
        if (target.dayOfWeek === picked.slot.dayOfWeek && target.startMinutes === picked.slot.startMinutes) continue;
        out.push({ picked, placed: true, target, depth, maxUnits });
      }
    });
  const brick = lesson('brick', 1, 0, { studentGroupId: 'c1', teacherId: 't1', roomId: 'r1', endMinutes: HOUR });
  const unit: SwapUnit = { id: brick.id, members: [brick], links: [], slot: slotOf(brick), locked: false };
  for (const target of targets) out.push({ picked: unit, placed: false, target, depth, maxUnits });
  return out;
}

describe('E5a, Annan ledig sal: Gör plats with rooms finds exactly the proposals an exhaustive check finds', () => {
  const SEEDS = [3, 5, 8, 13, 21, 34];
  const seen = { asked: 0, proposals: 0, withRoomChange: 0, manyChanges: 0, pickedChanged: 0, fewerUnits: 0, bricksChanged: 0 };

  it.each(SEEDS)('seed %i: depth 3, up to four units', async (seed) => {
    const world = miniWorld(seed);
    for (const ask of asks(world, 3, 4, 4)) {
      const result = await search(world, ask);
      const expected = bruteForce(world, ask);
      const got = new Map(result.proposals.map((p) => [proposalId(p.moves), { depth: p.depth, units: p.units.length, changes: changesOf(p.moves) }]));
      expect(got).toEqual(expected);
      expect(result.refused).toBe(0);
      expect(result.truncated).toBe(false);
      seen.asked += 1;
      seen.proposals += got.size;
      for (const proposal of result.proposals) {
        const changes = changesOf(proposal.moves);
        if (changes > 0) seen.withRoomChange += 1;
        if (changes > 1) seen.manyChanges += 1;
        if (proposal.moves[0]!.room) seen.pickedChanged += 1;
        if (!ask.placed && proposal.moves[0]!.room) seen.bricksChanged += 1;
      }
      // A way that holds no room holder leaves them in place: a proposal with a room change may be shorter than the same lesson's other proposals.
      if (result.proposals.some((p) => changesOf(p.moves) > 0 && p.units.length < Math.max(...result.proposals.map((q) => q.units.length)))) seen.fewerUnits += 1;
    }
  }, 180_000);

  it('does not stand on an empty pass: rooms are changed, by the picked lesson and by displaced ones, several in one proposal, and a brick takes another room', () => {
    expect(seen.asked).toBeGreaterThan(100);
    expect(seen.proposals).toBeGreaterThan(300);
    expect(seen.withRoomChange).toBeGreaterThan(50);
    expect(seen.manyChanges).toBeGreaterThan(0);
    expect(seen.pickedChanged).toBeGreaterThan(0);
    expect(seen.bricksChanged).toBeGreaterThan(0);
    expect(seen.fewerUnits).toBeGreaterThan(0);
  });

  it.each([1, 2])('depth %i leaves out what is deeper', async (depth) => {
    for (const seed of [5, 13]) {
      const world = miniWorld(seed);
      for (const ask of asks(world, depth, 5, 5)) {
        const result = await search(world, ask);
        expect(new Set(result.proposals.map((p) => proposalId(p.moves)))).toEqual(new Set(bruteForce(world, ask).keys()));
        for (const proposal of result.proposals) expect(proposal.depth).toBeLessThanOrEqual(depth);
      }
    }
  }, 180_000);

  it('offers no two proposals of the same times in different rooms, and the one it keeps changes fewest', async () => {
    const world = miniWorld(8);
    let multi = 0;
    for (const ask of asks(world, 3, 5, 3)) {
      const { proposals } = await search(world, ask);
      const times = proposals.map((p) => timesOf(p.moves));
      expect(new Set(times).size).toBe(times.length);
      multi += proposals.filter((p) => changesOf(p.moves) > 0).length;
    }
    expect(multi).toBeGreaterThan(0);
  }, 180_000);

  it('never moves a block’s lessons to another room: a unit of two keeps the rooms the school gave it', async () => {
    let blocks = 0;
    for (const seed of SEEDS) {
      const world = miniWorld(seed);
      const block = new Set(world.lessons.filter((l) => l.subjectId === 'sB').map((l) => l.id));
      for (const ask of asks(world, 3, 4, 2)) {
        const { proposals } = await search(world, ask);
        for (const proposal of proposals) {
          for (const move of proposal.moves) {
            if (block.has(move.lessonId)) {
              blocks += 1;
              expect(move.room).toBeUndefined();
            }
          }
        }
      }
    }
    expect(blocks).toBeGreaterThan(5);
  }, 180_000);

  it('a swap of two lessons in one room is a swap: the room is held only by the one that leaves, so neither changes room', () => {
    const a = lesson('a', 1, 480, { studentGroupId: 'c1', teacherId: 't1', roomId: 'r1' });
    const b = lesson('b', 1, 540, { studentGroupId: 'c1', teacherId: 't2', roomId: 'r1' });
    const free = lesson('f', 2, 480, { studentGroupId: 'c2', teacherId: 't3', roomId: 'r2' });
    const world: Mini = { lessons: [a, b, free], ...(() => {
      const unitOf = buildUnits([a, b, free], { blockOf: () => null, sameTimesOf: () => null, groupFacts: new Map(), sharesPupils: () => false });
      return { unitOf, units: [...new Map([...unitOf.values()].map((u) => [u.id, u])).values()] };
    })() };
    const ask: Ask = { picked: world.unitOf.get('a')!, placed: true, target: { dayOfWeek: 1, startMinutes: 540 }, depth: 2, maxUnits: 3 };
    return search(world, ask).then((result) => {
      const swap = result.proposals.find((p) => p.moves.length === 2 && p.moves.every((m) => (m.lessonId === 'b' ? m.to.startMinutes === 480 : m.to.startMinutes === 540) && m.to.dayOfWeek === 1));
      expect(swap).toBeDefined();
      expect(changesOf(swap!.moves)).toBe(0);
      // And it is the first, ahead of every set that gets a lesson out of the way by a room.
      expect(result.proposals[0]!.moves).toHaveLength(2);
    });
  });

  it('keeps, of the same times in other rooms, the one that changes fewest even when the order does not price a room change at all', async () => {
    let multi = 0;
    for (const seed of [5, 13, 21]) {
      const world = miniWorld(seed);
      for (const ask of asks(world, 3, 4, 3)) {
        const result = await search(world, ask, { soft: (moves) => ({ costs: [], score: moves.length }) });
        expect(new Map(result.proposals.map((p) => [proposalId(p.moves), changesOf(p.moves)]))).toEqual(
          new Map([...bruteForce(world, ask)].map(([id, entry]) => [id, entry.changes])),
        );
        multi += result.proposals.filter((p) => changesOf(p.moves) > 0).length;
      }
    }
    expect(multi).toBeGreaterThan(50);
  }, 180_000);

  it('says what the time holds for the school as it stands, unless a free room makes it less: a locked lesson that holds only the room is no one in the way', async () => {
    const picked = lesson('p', 1, 480, { studentGroupId: 'c1', teacherId: 't1', roomId: 'r1' });
    const holder = lesson('h', 2, 540, { studentGroupId: 'c2', teacherId: 't2', roomId: 'r1', isLocked: true });
    const mini = ((): Mini => {
      const lessons = [picked, holder];
      const unitOf = buildUnits(lessons, { blockOf: () => null, sameTimesOf: () => null, groupFacts: new Map(), sharesPupils: () => false });
      return { lessons, unitOf, units: [...new Map([...unitOf.values()].map((u) => [u.id, u])).values()] };
    })();
    const ask: Ask = { picked: mini.unitOf.get('p')!, placed: true, target: { dayOfWeek: 2, startMinutes: 540 }, depth: 2, maxUnits: 3 };
    const free = await search(mini, ask);
    // The own room is held by a lesson the generation keeps; r2 is free: the lesson goes there, nothing else moves, and nothing is "in the way".
    expect(free.stuck).toBeUndefined();
    expect(free.blockers).toEqual([]);
    expect(free.proposals).toHaveLength(1);
    expect(free.proposals[0]!.moves).toEqual([expect.objectContaining({ lessonId: 'p', room: { from: 'r1', to: 'r2' } })]);
    // Every other room taken or shut then (r2 and r3 stand in, r4 is shut on day 2): the locked holder is a wall, and it is named.
    const crowded = [...mini.lessons, lesson('k2', 2, 540, { studentGroupId: 'c3', teacherId: 't3', roomId: 'r2' }), lesson('k3', 2, 540, { studentGroupId: 'c4', teacherId: 't4', roomId: 'r3' })];
    const unitOf = buildUnits(crowded, { blockOf: () => null, sameTimesOf: () => null, groupFacts: new Map(), sharesPupils: () => false });
    const walled = await search({ lessons: crowded, unitOf, units: [...new Map([...unitOf.values()].map((u) => [u.id, u])).values()] }, { ...ask, picked: unitOf.get('p')! });
    expect(walled.stuck).toBe('LOCKED_IN_THE_WAY');
    expect(walled.proposals).toEqual([]);
    expect(walled.blockers.map((unit) => unit.id)).toEqual(['h']);
  });

  it('with a cap on the landings, keeps the nearest one that stands in the way of fewest, and that is a landing in another room when it is the nearest', async () => {
    // P (class c1) is asked to Monday 08:00, where H (class c1) stands: H must go. H's nearest landing is Monday 09:00, where Z holds H's own room r2 and
    // r1 is free: in r1 it stands in the way of no one, in r2 of Z. Every other landing of the week stands in the way of no one either, and is further off.
    const p = lesson('p', 1, 660, { studentGroupId: 'c1', teacherId: 't1', roomId: 'r1' });
    const h = lesson('h', 1, 480, { studentGroupId: 'c1', teacherId: 't2', roomId: 'r2' });
    const z = lesson('z', 1, 540, { studentGroupId: 'c2', teacherId: 't3', roomId: 'r2' });
    const lessons = [p, h, z];
    const unitOf = buildUnits(lessons, { blockOf: () => null, sameTimesOf: () => null, groupFacts: new Map(), sharesPupils: () => false });
    const mini: Mini = { lessons, unitOf, units: [...new Map([...unitOf.values()].map((u) => [u.id, u])).values()] };
    const ask: Ask = { picked: unitOf.get('p')!, placed: true, target: { dayOfWeek: 1, startMinutes: 480 }, depth: 2, maxUnits: 3 };
    const full = await search(mini, ask);
    expect(full.proposals.length).toBeGreaterThan(6);
    const capped = await search(mini, ask, { perUnit: 1 });
    expect(capped.landingsCut).toBe(true);
    expect(capped.proposals).toHaveLength(1);
    const moved = capped.proposals[0]!.moves.find((move) => move.lessonId === 'h')!;
    expect(moved.to).toMatchObject({ dayOfWeek: 1, startMinutes: 540 });
    expect(moved.room).toEqual({ from: 'r2', to: 'r1' });
  });

  it('says TOO_MANY when more units stand in the way than a proposal may move, and offers nothing', async () => {
    let tooMany = 0;
    for (const seed of SEEDS) {
      const world = miniWorld(seed);
      for (const ask of asks(world, 3, 1, 2)) {
        const result = await search(world, ask);
        expect(new Set(result.proposals.map((p) => proposalId(p.moves)))).toEqual(new Set(bruteForce(world, ask).keys()));
        if (result.stuck === 'TOO_MANY') {
          tooMany += 1;
          expect(result.proposals).toEqual([]);
          expect(result.blockers.length).toBeGreaterThanOrEqual(1);
        }
      }
    }
    expect(tooMany).toBeGreaterThan(0);
  }, 180_000);

  it('a locked lesson that holds only the room is no wall when another room is free, and a wall when none is', async () => {
    let freed = 0;
    let walled = 0;
    for (const seed of SEEDS) {
      const world = miniWorld(seed, 0.5);
      for (const ask of asks(world, 2, 3, 1)) {
        const result = await search(world, ask);
        const brute = bruteForce(world, ask);
        expect(new Set(result.proposals.map((p) => proposalId(p.moves)))).toEqual(new Set(brute.keys()));
        if (result.stuck === 'LOCKED_IN_THE_WAY') {
          walled += 1;
          expect(result.proposals).toEqual([]);
        } else if (result.proposals.some((p) => p.moves[0]!.room) && result.blockers.every((u) => !u.locked) && ask.picked.members[0]!.roomId !== null) {
          freed += 1;
        }
      }
    }
    expect(walled).toBeGreaterThan(0);
    expect(freed).toBeGreaterThan(0);
  }, 180_000);
});
