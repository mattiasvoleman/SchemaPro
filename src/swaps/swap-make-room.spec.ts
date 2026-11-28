import { proposalId } from './swap-search';
import { searchMakeRoom, type MakeRoomInput, type Placement } from './swap-make-room';
import { buildUnits } from './swap-units';
import type { SwapLesson, SwapMove, SwapSlot, SwapUnit } from './swap-types';

/*
 * E5a Klart (a): THE SEARCH GIVES EXACTLY THE PROPOSALS AN EXHAUSTIVE CHECK ON A TIME GRID GIVES.
 *
 * The brute force below is the list in the head of swap-make-room.ts and nothing else: it tries EVERY assignment of every
 * subset of the unlocked units to every place of the grid, and keeps the ones that
 *   - leave the school with no double booking (a teacher, a room or a class twice at once),
 *   - move only what stood in the way of something that moves, reached from the picked unit (so nothing moves for no reason),
 *   - are no deeper than `depth` levels (the smallest level there is) and no longer than `maxUnits`.
 * It shares no code with the search: not the level-by-level enumeration, not the blockers it asks for, not the order. The grid is
 * hourly with every lesson an hour long, so the search's prune is exact and the judge (here the same plain overlap) refuses
 * nothing: `refused` is 0, which is what lets the two sets be held equal and not only nested.
 */

const DAYS = [1, 2, 3];
const STARTS = [480, 540, 600, 660];
const HOUR = 60;

/** A small deterministic generator, so that a difference between two runs is the code's and not the data's. */
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

/** What a double booking is, and nothing else. */
function holds(a: SwapLesson, at: SwapSlot, b: SwapLesson, bt: SwapSlot): boolean {
  if (a.id === b.id || !overlap(at, bt)) return false;
  return a.studentGroupId === b.studentGroupId || (a.roomId !== null && a.roomId === b.roomId) || (a.teacherId !== null && a.teacherId === b.teacherId);
}

/** A rule that shuts a stretch whatever else is there (the stage's ramtid, say): class c1 has no lesson at 08:00 on day 3. */
const shut = (l: SwapLesson, at: SwapSlot): boolean => l.studentGroupId === 'c1' && at.dayOfWeek === 3 && at.startMinutes === 480;

interface Mini {
  lessons: SwapLesson[];
  unitOf: Map<string, SwapUnit>;
  units: SwapUnit[];
}

/**
 * A school of three classes, three teachers and three rooms on twelve hourly places, a little under two thirds full, a lesson
 * locked here and there, and one parallel block of two lessons (two classes, two teachers, two rooms) that moves as one.
 */
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
        const room = ['r1', 'r2', 'r3'].sort(() => next() - 0.5).find((id) => !taken.has(`${id}|${key}`));
        if (!teacher || !room) continue;
        taken.add(`${teacher}|${key}`);
        taken.add(`${room}|${key}`);
        n += 1;
        lessons.push(
          lesson(`l${String(n).padStart(2, '0')}`, day, start, {
            studentGroupId: group,
            teacherId: teacher,
            roomId: room,
            isLocked: next() < lockedShare,
          }),
        );
      }
    }
  }
  // The block: two lessons of two classes at one place, taken from the free teachers and rooms there; none if the week is too full.
  for (const day of DAYS) {
    const start = STARTS[Math.floor(next() * STARTS.length)]!;
    const key = `${day}|${start}`;
    const here = lessons.filter((l) => l.dayOfWeek === day && l.startMinutes === start);
    const groups = ['c1', 'c2', 'c3'].filter((g) => !here.some((l) => l.studentGroupId === g));
    const teachers = ['t1', 't2', 't3'].filter((t) => !here.some((l) => l.teacherId === t));
    const rooms = ['r1', 'r2', 'r3'].filter((r) => !here.some((l) => l.roomId === r));
    if (groups.length < 2 || teachers.length < 2 || rooms.length < 2) continue;
    for (const index of [0, 1]) {
      n += 1;
      lessons.push(lesson(`b${n}`, day, start, { studentGroupId: groups[index]!, teacherId: teachers[index]!, roomId: rooms[index]!, subjectId: 'sB' }));
    }
    void key;
    break;
  }
  const blockOf = (l: SwapLesson) => (l.subjectId === 'sB' ? 'B' : null);
  const unitOf = buildUnits(lessons, { blockOf, sameTimesOf: () => null, groupFacts: new Map(), sharesPupils: () => false });
  return { lessons, unitOf, units: [...new Map([...unitOf.values()].map((u) => [u.id, u])).values()] };
}

/** A unit's members laid at `to` as the grid does: each keeps its length, here always an hour. */
const landing = (member: SwapLesson, to: SwapSlot): SwapSlot => ({ dayOfWeek: to.dayOfWeek, startMinutes: to.startMinutes, endMinutes: to.startMinutes + (member.endMinutes - member.startMinutes) });

/** The unit-level rule: any member of one holds what any member of the other holds. */
const unitsHold = (a: SwapUnit, at: SwapSlot, b: SwapUnit, bt: SwapSlot): boolean =>
  a.members.some((m) => b.members.some((o) => holds(m, landing(m, at), o, landing(o, bt))));

function moveOf(unit: SwapUnit, to: SwapSlot): SwapMove[] {
  return unit.members.map((m) => ({ lessonId: m.id, from: slotOf(m), to: landing(m, to) }));
}

interface Ask {
  picked: SwapUnit;
  /** False: the picked unit is a brick, which stands nowhere and leaves no place behind. */
  placed: boolean;
  target: { dayOfWeek: number; startMinutes: number };
  depth: number;
  maxUnits: number;
}

/** The exhaustive check: every set of moves that is one by the rules in the head of swap-make-room.ts. */
function bruteForce(world: Mini, ask: Ask): Map<string, { depth: number; units: number }> {
  const { picked, depth, maxUnits } = ask;
  const to: SwapSlot = { dayOfWeek: ask.target.dayOfWeek, startMinutes: ask.target.startMinutes, endMinutes: ask.target.startMinutes + HOUR };
  const others = world.units.filter((u) => u.id !== picked.id && !u.locked);
  const found = new Map<string, { depth: number; units: number }>();
  // Where each unit may land: every place of the grid but its own, that no rule shuts.
  const places: SwapSlot[] = DAYS.flatMap((dayOfWeek) => STARTS.map((startMinutes) => ({ dayOfWeek, startMinutes, endMinutes: startMinutes + HOUR })));
  const landings = (unit: SwapUnit): SwapSlot[] =>
    places.filter((place) => !(place.dayOfWeek === unit.slot.dayOfWeek && place.startMinutes === unit.slot.startMinutes) && !unit.members.some((m) => shut(m, landing(m, place))));
  if (picked.members.some((m) => shut(m, landing(m, to)))) return found;
  const pickedLands: Placement = { unit: picked, to };

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

  for (const subset of subsets) {
    const moving = new Set([picked.id, ...subset.map((u) => u.id)]);
    const stay = world.units.filter((u) => !moving.has(u.id));
    // The picked unit's landing must be clear of everything that stays.
    if (stay.some((u) => unitsHold(picked, to, u, u.slot))) continue;
    const options = subset.map((unit) => landings(unit).filter((place) => !stay.some((u) => unitsHold(unit, place, u, u.slot))));
    const choose = (index: number, placed: Placement[]) => {
      if (index === subset.length) {
        const all: Placement[] = [pickedLands, ...placed];
        // Every unit that moves stood in the way of one that moves, reached from the picked unit, within `depth` levels.
        const level = new Map<string, number>([[picked.id, 0]]);
        const queue = [picked.id];
        for (let head = 0; head < queue.length; head += 1) {
          const from = all.find((p) => p.unit.id === queue[head])!;
          for (const other of all) {
            if (level.has(other.unit.id)) continue;
            // `other` stood where it did and is in the way of `from`'s landing.
            if (unitsHold(from.unit, from.to, other.unit, other.unit.slot)) {
              level.set(other.unit.id, level.get(from.unit.id)! + 1);
              queue.push(other.unit.id);
            }
          }
        }
        if (all.some((p) => !level.has(p.unit.id))) return;
        const deepest = Math.max(...level.values());
        if (deepest > depth) return;
        const moves = all.flatMap((p) => moveOf(p.unit, p.to));
        found.set(proposalId(moves), { depth: deepest, units: all.length });
        return;
      }
      for (const place of options[index]!) {
        const here: Placement = { unit: subset[index]!, to: place };
        if ([pickedLands, ...placed].some((p) => unitsHold(here.unit, here.to, p.unit, p.to))) continue;
        choose(index + 1, [...placed, here]);
      }
    };
    choose(0, []);
  }
  return found;
}

/** The search over the same world, with the world's own plain overlap as the prune and as the judge. */
function search(world: Mini, ask: Ask, over: Partial<MakeRoomInput> = {}) {
  const lessonsOf = (unit: SwapUnit) => new Set(unit.members.map((m) => m.id));
  return searchMakeRoom({
    picked: ask.picked,
    placed: ask.placed,
    target: ask.target,
    unitOf: ask.placed ? world.unitOf : new Map([...world.unitOf].filter(([id]) => !lessonsOf(ask.picked).has(id))),
    starts: STARTS,
    days: DAYS,
    world: {
      inTheWay: (unit, at) => {
        const own = lessonsOf(unit);
        const lessons = world.lessons.filter((other) => !own.has(other.id) && unit.members.some((m) => holds(m, landing(m, at), other, slotOf(other))));
        return { lessons, closed: unit.members.some((m) => shut(m, landing(m, at))) };
      },
      landingsClash: (a, b) => unitsHold(a.unit, a.to, b.unit, b.to),
    },
    soft: (moves) => ({ costs: [], score: moves.length }),
    // The judge here is the same plain overlap over the whole school after the move: it must refuse nothing the prune let through.
    judge: async (sets) =>
      sets.map((moves) => {
        const to = new Map(moves.map((m) => [m.lessonId, m.to]));
        const after = world.lessons.map((l) => ({ l, at: to.get(l.id) ?? slotOf(l) }));
        return !after.some(({ l, at }, i) => after.slice(i + 1).some((o) => holds(l, at, o.l, o.at)));
      }),
    limit: 1_000_000,
    budgetMs: 1_000_000,
    depth: ask.depth,
    maxUnits: ask.maxUnits,
    ...over,
  });
}

/** Every (picked, target) question worth asking of a world: a few placed lessons at every place, and a brick at every place. */
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
  // A brick of class c1 taught by t1 in room r1: no place, nothing at its origin.
  const brick = lesson('brick', 1, 0, { studentGroupId: 'c1', teacherId: 't1', roomId: 'r1', endMinutes: HOUR });
  const unit: SwapUnit = { id: brick.id, members: [brick], links: [], slot: slotOf(brick), locked: false };
  for (const target of targets) out.push({ picked: unit, placed: false, target, depth, maxUnits });
  return out;
}

describe('E5a: Gör plats finds exactly the proposals an exhaustive check on the time grid finds', () => {
  const SEEDS = [3, 5, 8, 13, 21, 34];
  let seen = { asked: 0, proposals: 0, byLevel: [0, 0, 0, 0], withEmptyLanding: 0, bricks: 0, lockedStuck: 0, big: 0 };

  beforeAll(() => {
    seen = { asked: 0, proposals: 0, byLevel: [0, 0, 0, 0], withEmptyLanding: 0, bricks: 0, lockedStuck: 0, big: 0 };
  });

  it.each(SEEDS)('seed %i: depth 3, up to four units', async (seed) => {
    const world = miniWorld(seed);
    for (const ask of asks(world, 3, 4, 4)) {
      const result = await search(world, ask);
      const expected = bruteForce(world, ask);
      const got = new Map(result.proposals.map((p) => [proposalId(p.moves), { depth: p.depth, units: p.units.length }]));
      expect(got).toEqual(expected);
      // The judge, which is the school's whole rule, refused nothing the prune let through: the prune is exact on this grid.
      expect(result.refused).toBe(0);
      expect(result.truncated).toBe(false);
      seen.asked += 1;
      seen.proposals += got.size;
      if (result.stuck === 'LOCKED_IN_THE_WAY') seen.lockedStuck += 1;
      if (!ask.placed) seen.bricks += got.size;
      for (const proposal of result.proposals) {
        seen.byLevel[proposal.depth] = (seen.byLevel[proposal.depth] ?? 0) + 1;
        if (proposal.units.length >= 4) seen.big += 1;
        // A move to an EMPTY place: a displaced lesson lands where no lesson of the proposal stood (it is not a swap of places).
        const pickedIds = new Set(ask.picked.members.map((m) => m.id));
        const vacated = new Set(proposal.moves.map((m) => `${m.from.dayOfWeek}|${m.from.startMinutes}`));
        if (proposal.moves.some((m) => !pickedIds.has(m.lessonId) && !vacated.has(`${m.to.dayOfWeek}|${m.to.startMinutes}`))) seen.withEmptyLanding += 1;
      }
    }
  }, 120_000);

  it.each([1, 2])('depth %i leaves out what is deeper, as the brute force does', async (depth) => {
    for (const seed of [5, 13]) {
      const world = miniWorld(seed);
      for (const ask of asks(world, depth, 5, 5)) {
        const result = await search(world, ask);
        const got = new Set(result.proposals.map((p) => proposalId(p.moves)));
        expect(got).toEqual(new Set(bruteForce(world, ask).keys()));
        for (const proposal of result.proposals) expect(proposal.depth).toBeLessThanOrEqual(depth);
      }
    }
  }, 120_000);

  it('a longer set is found when more units are let move, and never when fewer are', async () => {
    const world = miniWorld(8);
    const sizes = new Map<number, number>();
    for (const maxUnits of [2, 3, 5]) {
      let all = 0;
      for (const ask of asks(world, 3, maxUnits, 6)) {
        const result = await search(world, ask);
        expect(new Set(result.proposals.map((p) => proposalId(p.moves)))).toEqual(new Set(bruteForce(world, ask).keys()));
        for (const proposal of result.proposals) expect(proposal.units.length).toBeLessThanOrEqual(maxUnits);
        all += result.proposals.length;
      }
      sizes.set(maxUnits, all);
    }
    expect(sizes.get(3)!).toBeGreaterThanOrEqual(sizes.get(2)!);
    expect(sizes.get(5)!).toBeGreaterThan(sizes.get(3)!);
  }, 120_000);

  /*
   * E5a Klart (c): NO LOCKED LESSON MOVES IN ANY PROPOSAL. Asked of every proposal of every question above, by the world's own
   * flag and not by the search's, and with the share of locked lessons turned up so that it bites.
   */
  it('moves no locked lesson in any proposal, but the one that was picked', async () => {
    let proposals = 0;
    let lockedSeen = 0;
    for (const seed of SEEDS) {
      const world = miniWorld(seed, 0.35);
      const locked = new Set(world.lessons.filter((l) => l.isLocked).map((l) => l.id));
      lockedSeen += locked.size;
      for (const ask of asks(world, 3, 4, 3)) {
        const result = await search(world, ask);
        for (const proposal of result.proposals) {
          proposals += 1;
          const pickedIds = new Set(ask.picked.members.map((m) => m.id));
          for (const move of proposal.moves) if (!pickedIds.has(move.lessonId)) expect(locked.has(move.lessonId)).toBe(false);
        }
        expect(new Set(result.proposals.map((p) => proposalId(p.moves)))).toEqual(new Set(bruteForce(world, ask).keys()));
      }
    }
    expect(lockedSeen).toBeGreaterThan(10);
    expect(proposals).toBeGreaterThan(50);
  }, 120_000);

  it('does not stop at a swap: a lesson goes to an empty place, a brick finds room, and the third level is reached', () => {
    // Not a vacuous pass. The numbers are the six seeds' of the first test, which has run before this one.
    expect(seen.asked).toBeGreaterThan(100);
    expect(seen.proposals).toBeGreaterThan(300);
    expect(seen.byLevel[1]).toBeGreaterThan(0);
    expect(seen.byLevel[2]).toBeGreaterThan(0);
    expect(seen.byLevel[3]).toBeGreaterThan(0);
    expect(seen.withEmptyLanding).toBeGreaterThan(0);
    expect(seen.bricks).toBeGreaterThan(0);
    expect(seen.lockedStuck).toBeGreaterThan(0);
    expect(seen.big).toBeGreaterThan(0);
  });

  it('says what the target holds when nothing can be done, and answers a free place with the single move', async () => {
    const world = miniWorld(5, 0.5);
    let closed = 0;
    let free = 0;
    for (const ask of asks(world, 3, 4, 1)) {
      const result = await search(world, ask);
      if (result.stuck === 'CLOSED') {
        closed += 1;
        expect(result.proposals).toEqual([]);
      }
      if (result.blockers.length === 0 && !result.stuck && result.proposals.length > 0) {
        free += 1;
        expect(result.proposals[0]!.units).toHaveLength(1);
      }
    }
    expect(closed).toBeGreaterThan(0);
    expect(free).toBeGreaterThan(0);
  }, 120_000);

  it('cuts to the landings that stand in the way of fewest others when told to, says so, and then offers fewer and no others', async () => {
    const world = miniWorld(13);
    let cut = 0;
    for (const ask of asks(world, 3, 4, 5)) {
      const full = await search(world, ask);
      const small = await search(world, ask, { perUnit: 2 });
      expect(new Set(small.proposals.map((p) => proposalId(p.moves)))).toEqual(
        new Set([...small.proposals.map((p) => proposalId(p.moves))].filter((id) => full.proposals.some((p) => proposalId(p.moves) === id))),
      );
      expect(small.proposals.length).toBeLessThanOrEqual(full.proposals.length);
      if (small.landingsCut) cut += 1;
    }
    expect(cut).toBeGreaterThan(0);
  }, 120_000);

  it('stops at the candidate cap and says so, and never judges more than the list needs', async () => {
    const world = miniWorld(8);
    const ask = asks(world, 3, 4, 1).find((entry) => bruteForce(world, entry).size > 10)!;
    const capped = await search(world, ask, { maxCandidates: 5 });
    expect(capped.candidates).toBe(5);
    expect(capped.truncated).toBe(true);
    const few = await search(world, ask, { limit: 2, chunk: 1 });
    expect(few.proposals).toHaveLength(2);
    expect(few.judged).toBe(2);
  });
});

/*
 * g514 (granskning av #514): WHAT THE ORACLE ABOVE LEAVES OPEN. It holds the search to the exhaustive check with every bound off and a judge that
 * refuses nothing, so four things the school meets were pinned by no test: that a judge's "no" removes a proposal, the order the list comes in,
 * which landings the per-unit cap keeps (the cap is on in production, 8 per unit), and the time budget.
 */
describe('E5a: the judge’s no, the order, the cap and the clock', () => {
  const ids = (proposals: ReadonlyArray<{ moves: readonly SwapMove[] }>): string[] => proposals.map((p) => proposalId(p.moves));

  it('a set the judge refuses is no proposal, is counted as refused, and the list is filled from the ones that are left, in order', async () => {
    const world = miniWorld(13);
    let vetoed = 0;
    let filled = 0;
    for (const ask of asks(world, 3, 4, 3)) {
      const full = await search(world, ask);
      // The judge's no: every set of three moves.
      const veto = new Set(full.proposals.filter((p) => p.moves.length === 3).map((p) => proposalId(p.moves)));
      const refusing = (sets: ReadonlyArray<readonly SwapMove[]>) => Promise.resolve(sets.map((moves) => !veto.has(proposalId(moves))));
      const survivors = ids(full.proposals).filter((id) => !veto.has(id));
      const answer = await search(world, ask, { judge: refusing });
      expect(ids(answer.proposals)).toEqual(survivors);
      expect(answer.refused).toBe(veto.size);
      expect(answer.judged).toBe(full.judged);
      vetoed += veto.size;
      // A short list is filled past the refused ones: the two best that stand, not the first two asked.
      const two = await search(world, ask, { judge: refusing, limit: 2, chunk: 1 });
      expect(ids(two.proposals)).toEqual(survivors.slice(0, 2));
      if (veto.size > 0 && survivors.length >= 2) filled += 1;
    }
    expect(vetoed).toBeGreaterThan(5);
    expect(filled).toBeGreaterThan(0);
  }, 120_000);

  it('answers cheapest first: fewer moves before more (the soft score of this world), and a set by its name when the two are equal', async () => {
    const world = miniWorld(8);
    let longer = 0;
    for (const ask of asks(world, 3, 5, 2)) {
      const { proposals } = await search(world, ask);
      for (let at = 1; at < proposals.length; at += 1) {
        const [before, after] = [proposals[at - 1]!, proposals[at]!];
        expect(before.score).toBeLessThanOrEqual(after.score);
        if (before.score === after.score) {
          expect(before.moves.length).toBeLessThanOrEqual(after.moves.length);
          if (before.moves.length === after.moves.length) {
            const name = (p: typeof before) => [...p.moves].map((move) => `${move.lessonId}>${move.to.dayOfWeek}|${move.to.startMinutes}|${move.to.endMinutes}`).sort().join(';');
            expect(name(before) < name(after)).toBe(true);
          }
        }
        if (after.moves.length > before.moves.length) longer += 1;
      }
    }
    expect(longer).toBeGreaterThan(10);
  }, 120_000);

  it('with a cap on landings, a displaced lesson is offered the ones that stand in the way of fewest others, the same day first, then the nearest', async () => {
    const places: SwapSlot[] = DAYS.flatMap((dayOfWeek) => STARTS.map((startMinutes) => ({ dayOfWeek, startMinutes, endMinutes: startMinutes + HOUR })));
    let asked = 0;
    let foundMatters = 0;
    let dayMatters = 0;
    for (const seed of [5, 13, 21, 34]) {
      const world = miniWorld(seed, 0);
      for (const ask of asks(world, 1, 3, 2)) {
        if (!ask.placed) continue;
        const uncapped = await search(world, ask);
        if (uncapped.blockers.length !== 1 || uncapped.stuck) continue;
        const blocker = uncapped.blockers[0]!;
        const to: SwapSlot = { dayOfWeek: ask.target.dayOfWeek, startMinutes: ask.target.startMinutes, endMinutes: ask.target.startMinutes + HOUR };
        // The landings of the one displaced unit, as the list in the head of swap-make-room.ts says they are weighed: this file's own
        // reading of it, over the world's plain overlap and nothing of the search's.
        const options = places
          .filter((place) => !(place.dayOfWeek === blocker.slot.dayOfWeek && place.startMinutes === blocker.slot.startMinutes))
          .filter((place) => !blocker.members.some((m) => shut(m, landing(m, place))))
          .filter((place) => !unitsHold(blocker, place, ask.picked, to))
          .map((place) => ({
            place,
            holders: world.units.filter((u) => u.id !== blocker.id && u.id !== ask.picked.id && unitsHold(blocker, place, u, u.slot)),
          }))
          .filter((option) => !option.holders.some((u) => u.locked) && 2 + option.holders.length <= 3)
          .map((option) => ({
            ...option,
            weight: [option.holders.length, option.place.dayOfWeek === blocker.slot.dayOfWeek ? 0 : 1, Math.abs(option.place.startMinutes - blocker.slot.startMinutes), option.place.dayOfWeek, option.place.startMinutes],
          }))
          .sort((a, b) => a.weight.reduce((diff, w, i) => diff || w - b.weight[i]!, 0));
        for (const cap of [1, 2, 3]) {
          // Depth one: a landing that stands in the way of another lesson has nowhere for that one to go, so it is a place taken and no proposal.
          const kept = options.slice(0, cap);
          const expected = new Set(kept.filter((option) => option.holders.length === 0).map((option) => `${option.place.dayOfWeek}|${option.place.startMinutes}`));
          const capped = await search(world, ask, { depth: 1, maxUnits: 3, perUnit: cap });
          const got = new Set(
            capped.proposals.map((p) => {
              const move = p.moves.find((m) => blocker.members.some((member) => member.id === m.lessonId))!;
              return `${move.to.dayOfWeek}|${move.to.startMinutes}`;
            }),
          );
          expect(got).toEqual(expected);
          asked += 1;
          // The weights are not idle in this world: a landing that stands in the way of someone is nearer than an empty one, or another day is.
          const byDistance = [...options].sort((a, b) => a.weight[1]! - b.weight[1]! || a.weight[2]! - b.weight[2]! || a.weight[3]! - b.weight[3]! || a.weight[4]! - b.weight[4]!).slice(0, cap);
          if (kept.map((o) => o.place.startMinutes + o.place.dayOfWeek * 10000).join() !== byDistance.map((o) => o.place.startMinutes + o.place.dayOfWeek * 10000).join()) foundMatters += 1;
          if (options.some((o) => o.weight[1] === 1) && options.some((o) => o.weight[1] === 0)) dayMatters += 1;
        }
      }
    }
    expect(asked).toBeGreaterThan(30);
    expect(foundMatters).toBeGreaterThan(0);
    expect(dayMatters).toBeGreaterThan(0);
  }, 120_000);

  it('stops judging when the time is up, but not before as many sets as the list holds have been judged, and says it stopped', async () => {
    const world = miniWorld(8);
    const ask = asks(world, 3, 4, 1).find((entry) => bruteForce(world, entry).size > 40)!;
    const run = (over: Partial<MakeRoomInput>) => {
      const clock = { at: 0, calls: [] as number[] };
      const result = search(world, ask, {
        chunk: 4,
        now: () => clock.at,
        // Every call of the judge takes a minute of the clock and refuses all of it, so that the list is never full.
        judge: async (sets) => {
          clock.calls.push(sets.length);
          clock.at += 60;
          return sets.map(() => false);
        },
        ...over,
      });
      return { clock, result };
    };
    // Time up after the second chunk (60 + 60 > 100), the list (3) long since judged: stopped, and said so.
    const stopped = run({ limit: 3, budgetMs: 100 });
    const answer = await stopped.result;
    expect(stopped.clock.calls).toEqual([4, 4]);
    expect(answer.judged).toBe(8);
    expect(answer.truncated).toBe(true);
    // A budget of nothing still judges the first chunk, and stops once the list's worth is judged.
    const none = run({ limit: 3, budgetMs: 0 });
    const nothing = await none.result;
    expect(none.clock.calls).toEqual([4]);
    expect(nothing.truncated).toBe(true);
    // The list is not given up on before `limit` sets have been judged, whatever the clock says: ten asked, three chunks of four.
    const wide = run({ limit: 10, budgetMs: 0 });
    const long = await wide.result;
    expect(wide.clock.calls).toEqual([4, 4, 4]);
    expect(long.judged).toBe(12);
    expect(long.truncated).toBe(true);
    // Plenty of time: every set is judged and nothing is cut.
    const plenty = run({ limit: 3, budgetMs: 1_000_000 });
    const all = await plenty.result;
    expect(all.judged).toBe(all.candidates);
    expect(all.truncated).toBe(false);
  });
});
