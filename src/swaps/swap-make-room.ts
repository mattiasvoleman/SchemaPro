import { slotKey } from './swap-units';
import type { SoftCost, SwapLesson, SwapMove, SwapSlot, SwapUnit } from './swap-types';

/*
 * E5a, GÖR PLATS: WHAT HAS TO MOVE FOR THIS LESSON TO STAND AT THAT TIME?
 *
 * The question a drop on an occupied time asks, and the one a brick or a parked lesson asks of the time the schemaläggare points at.
 * The G1 search (swap-search.ts) answers the other one, "which lessons can trade places with this one", and answers it for slots
 * that are already taken; this one is aimed at a time, may move a lesson to an EMPTY place, makes room for a lesson that stands
 * nowhere, and goes three levels deep.
 *
 * A PROPOSAL IS A SET OF MOVES, and it is a proposal exactly when all of these hold (swap-make-room.spec.ts holds the search
 * against a brute force that knows only this list):
 *
 *   1. The picked unit lands at the target. A unit is a lesson and the lessons the school laid beside it (swap-units.ts): its
 *      members land together, each keeping its own length.
 *   2. Every other unit that moves is ONE THAT STOOD IN THE WAY: it holds the teacher, the room or the class of some landing of
 *      the set, as the school stood before any move. Nothing moves for no reason, and a lesson the school left alone stays.
 *   3. Nothing stands in the way of a landing at the end: no lesson that stays holds what a landing needs, and no two landings
 *      hold the same teacher, room or class at once.
 *   4. A LESSON THE GENERATION KEEPS NEVER MOVES (a locked one, a lesson a förläggning wrote, and so one with an exemption, which
 *      is locked as long as it holds). Where one stands in the way, the landing is not there to be had. The picked unit may be
 *      locked: the schemaläggare chose it.
 *   5. Every landing is a place that is not where the unit stands, at a start of the school's own grid (`starts`: the clocks its
 *      lessons begin at) on a school day. The picked unit lands at the start it was pointed at, whatever the grid says.
 *   6. DEPTH. The picked unit is level 0; a unit that stands in the way of a landing of level k is level k+1 at most, the
 *      smallest k there is, and no unit is deeper than `depth`: three levels is "make room for the lesson that makes room for the
 *      lesson that makes room". `maxUnits` caps the whole set, the picked unit included, so that a proposal stays readable.
 *
 * The G1 swap (two units standing in each other's slot) and chain of three are members of this family when the units hold each
 * other's slot; this search does not look for the pairs that stand in nobody's way (that is what a swap of two marked lessons
 * is: POST /swaps/pair).
 *
 * THE SEARCH HOLDS NO RULE, as swap-search.ts says of itself. `world.inTheWay` and `world.landingsClash` are plain overlaps the clash
 * rule also makes, so they can only lose a proposal, never admit one; `soft` orders what is left; and `judge` is the verdict, asked
 * of every proposal as ONE move, in that order, until the list is full. A proposal the judge refuses is not one.
 *
 * THE ENUMERATION IS EXACT UNTIL A BOUND SAYS OTHERWISE. It lays the units level by level (breadth first), so that a unit's level
 * is the smallest there is however the search came to it, and each set of moves is reached once. Three bounds cut it for a school
 * of thousands of lessons, and each one is said in the answer: `perUnit` landings tried for each displaced unit (the ones that
 * stand in the way of fewest others, then the nearest), `maxCandidates` sets in all, and the time budget for judging. None is
 * set in the test that holds the search against the brute force, which therefore sees every proposal.
 */

/** A unit at a slot: where it stands in a proposal. */
export interface Placement {
  unit: SwapUnit;
  to: SwapSlot;
}

/** What the search asks of the school, in the original world, as plain overlaps (SwapContext supplies them). */
export interface MakeRoomWorld {
  /**
   * The lessons that hold what `unit` would need at `to`, the unit's own lessons gone, and whether a rule shuts the stretch
   * whatever else is there (the stage's ramtid, the class's meal, a weekly row, another school's hold).
   */
  inTheWay: (unit: SwapUnit, to: SwapSlot) => { lessons: readonly SwapLesson[]; closed: boolean };
  /** Whether two units at their landings hold the same teacher, room or class at once. */
  landingsClash: (a: Placement, b: Placement) => boolean;
}

export interface MakeRoomInput {
  /** The unit that lands at `target`. */
  picked: SwapUnit;
  /** False for a brick or a parked lesson: the picked unit stands nowhere, so it leaves no place behind. */
  placed: boolean;
  target: { dayOfWeek: number; startMinutes: number };
  /** lesson id -> its unit, for the lessons that stand (the picked unit's too, when it stands). */
  unitOf: ReadonlyMap<string, SwapUnit>;
  /** The clocks a displaced unit may start at, ascending: the starts of the school's own lessons. */
  starts: readonly number[];
  /** The school days a displaced unit may land on. */
  days: readonly number[];
  world: MakeRoomWorld;
  soft: (moves: readonly SwapMove[]) => { costs: SoftCost[]; score: number };
  /** The hard verdict of each set of moves, each as ONE move. True: every hard rule holds. */
  judge: (sets: ReadonlyArray<readonly SwapMove[]>) => Promise<boolean[]>;
  limit: number;
  /** Stop judging after this many milliseconds, once `limit` sets have been judged. */
  budgetMs: number;
  /** Levels of displacement, 1..3. */
  depth: number;
  /** The most units a proposal moves, the picked one included. */
  maxUnits: number;
  /** Landings tried for each displaced unit. Absent: all of them. */
  perUnit?: number;
  /** The most sets to cost and order. Absent: all of them. */
  maxCandidates?: number;
  /** How many sets the judge is asked about in one call. */
  chunk?: number;
  /** How many sets are costed before the event loop is given back (and the budget looked at). */
  costSlice?: number;
  now?: () => number;
}

export interface MakeRoomProposal {
  /** Every unit's move, the picked unit's first, then the others by level and id. */
  moves: SwapMove[];
  /** The level of each moved unit by its id (the unit's lowest member id): 0 is the picked unit. */
  levels: Record<string, number>;
  /** The deepest level in the set. */
  depth: number;
  soft: SoftCost[];
  score: number;
  units: SwapUnit[];
}

export interface MakeRoomResult {
  proposals: MakeRoomProposal[];
  /** Sets the enumeration found. */
  candidates: number;
  /** Sets the judge was asked about. */
  judged: number;
  /** The judge refused this many of them. */
  refused: number;
  /** The candidate cap or the time budget ended the search: there may be more proposals. */
  truncated: boolean;
  /** Displaced units were offered only the landings that stand in the way of fewest others. Said in the stats, not to the reader. */
  landingsCut: boolean;
  /** The lessons (one per unit) standing in the way of the picked unit at the target, as the school stood. */
  blockers: SwapUnit[];
  /** Why there is nothing to offer at all, when it is known before any move is tried. */
  stuck?: 'CLOSED' | 'LOCKED_IN_THE_WAY' | 'TOO_MANY';
}

const durationOf = (unit: SwapUnit): number => unit.slot.endMinutes - unit.slot.startMinutes;

const byId = (a: SwapUnit, b: SwapUnit): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** A unit's members laid at a slot, each keeping its own length. */
export function movesOfUnit(unit: SwapUnit, to: SwapSlot): SwapMove[] {
  return unit.members.map((member) => ({
    lessonId: member.id,
    from: { dayOfWeek: member.dayOfWeek, startMinutes: member.startMinutes, endMinutes: member.endMinutes },
    to: {
      dayOfWeek: to.dayOfWeek,
      startMinutes: to.startMinutes,
      endMinutes: to.startMinutes + (member.endMinutes - member.startMinutes),
    },
  }));
}

interface Candidate {
  placements: Placement[];
  levels: Map<string, number>;
}

/** The distinct units of some lessons, in id order. */
function unitsOfLessons(lessons: readonly SwapLesson[], unitOf: ReadonlyMap<string, SwapUnit>): SwapUnit[] {
  const seen = new Map<string, SwapUnit>();
  for (const lesson of lessons) {
    const unit = unitOf.get(lesson.id);
    if (unit && !seen.has(unit.id)) seen.set(unit.id, unit);
  }
  return [...seen.values()].sort(byId);
}

export async function searchMakeRoom(input: MakeRoomInput): Promise<MakeRoomResult> {
  const now = input.now ?? Date.now;
  const started = now();
  const { picked, world } = input;
  const depth = Math.max(1, Math.min(3, input.depth));
  const maxUnits = Math.max(1, input.maxUnits);
  const maxCandidates = input.maxCandidates ?? Number.POSITIVE_INFINITY;
  const perUnit = input.perUnit ?? Number.POSITIVE_INFINITY;
  let truncated = false;
  let landingsCut = false;

  const pickedAt: SwapSlot = {
    dayOfWeek: input.target.dayOfWeek,
    startMinutes: input.target.startMinutes,
    endMinutes: input.target.startMinutes + durationOf(picked),
  };
  const empty = (over: Partial<MakeRoomResult>): MakeRoomResult => ({
    proposals: [],
    candidates: 0,
    judged: 0,
    refused: 0,
    truncated: false,
    landingsCut: false,
    blockers: [],
    ...over,
  });

  // Nothing to make room for: a unit that stands at the target already (a unit that stands nowhere has no place of its own), and a landing
  // that runs past midnight, which is no place (g514: both used to be answered with a proposal, the first a move from a place to itself).
  if (input.placed && picked.slot.dayOfWeek === pickedAt.dayOfWeek && picked.slot.startMinutes === pickedAt.startMinutes) return empty({});
  if (pickedAt.endMinutes > 24 * 60) return empty({ stuck: 'CLOSED' });

  // Level 0: the picked unit at the target.
  const first = world.inTheWay(picked, pickedAt);
  const pickedIds = new Set(picked.members.map((member) => member.id));
  const blockers = unitsOfLessons(first.lessons.filter((lesson) => !pickedIds.has(lesson.id)), input.unitOf);
  if (first.closed) return empty({ blockers, stuck: 'CLOSED' });
  if (blockers.some((unit) => unit.locked)) return empty({ blockers, stuck: 'LOCKED_IN_THE_WAY' });
  if (1 + blockers.length > maxUnits) return empty({ blockers, stuck: 'TOO_MANY' });

  const candidates: Candidate[] = [];

  /**
   * One level of displacement at a time. `queue` is the units of this level that still need a landing, `assigned` the placements
   * so far (the picked unit's first), `next` the units the landings so far put in the way, which are one level deeper.
   */
  const lay = (level: number, queue: readonly SwapUnit[], assigned: readonly Placement[], levels: ReadonlyMap<string, number>, next: ReadonlyMap<string, SwapUnit>): void => {
    if (candidates.length >= maxCandidates) {
      truncated = true;
      return;
    }
    if (queue.length === 0) {
      if (next.size === 0) {
        candidates.push({ placements: [...assigned], levels: new Map(levels) });
        return;
      }
      // The units found in this level's landings are one level deeper, and there are only `depth` levels.
      if (level + 1 > depth) return;
      const deeper = [...next.values()].sort(byId);
      const nextLevels = new Map(levels);
      for (const unit of deeper) nextLevels.set(unit.id, level + 1);
      lay(level + 1, deeper, assigned, nextLevels, new Map());
      return;
    }
    const unit = queue[0]!;
    const rest = queue.slice(1);
    const movingIds = new Set(assigned.map((placement) => placement.unit.id));
    const waiting = new Set([...rest.map((entry) => entry.id), ...next.keys()]);

    interface Option {
      placement: Placement;
      found: SwapUnit[];
      weight: [number, number, number];
    }
    const options: Option[] = [];
    const length = durationOf(unit);
    for (const dayOfWeek of input.days) {
      for (const startMinutes of input.starts) {
        const to: SwapSlot = { dayOfWeek, startMinutes, endMinutes: startMinutes + length };
        if (to.endMinutes > 24 * 60) continue;
        if (slotKey(to) === slotKey(unit.slot)) continue;
        const placement: Placement = { unit, to };
        // No two landings hold the same teacher, room or class at once.
        if (assigned.some((other) => world.landingsClash(placement, other))) continue;
        const way = world.inTheWay(unit, to);
        if (way.closed) continue;
        const holding = unitsOfLessons(way.lessons, input.unitOf);
        // A unit that is already moving (or waits to) is no longer in the way. A lesson the generation keeps is.
        const stays = holding.filter((other) => !movingIds.has(other.id) && other.id !== unit.id);
        if (stays.some((other) => other.locked)) continue;
        const found = stays.filter((other) => !waiting.has(other.id));
        // The units this level and the next hold, with the ones this landing adds: more than the cap says is no proposal.
        const total = assigned.length + 1 + rest.length + new Set([...next.keys(), ...found.map((entry) => entry.id)]).size;
        if (total > maxUnits) continue;
        options.push({
          placement,
          found,
          weight: [found.length, dayOfWeek === unit.slot.dayOfWeek ? 0 : 1, Math.abs(startMinutes - unit.slot.startMinutes)],
        });
      }
    }
    options.sort((a, b) => a.weight[0] - b.weight[0] || a.weight[1] - b.weight[1] || a.weight[2] - b.weight[2] || a.placement.to.dayOfWeek - b.placement.to.dayOfWeek || a.placement.to.startMinutes - b.placement.to.startMinutes);
    const kept = options.length > perUnit ? options.slice(0, perUnit) : options;
    if (kept.length < options.length) landingsCut = true;
    for (const option of kept) {
      if (candidates.length >= maxCandidates) {
        truncated = true;
        return;
      }
      const nextMap = new Map(next);
      for (const other of option.found) nextMap.set(other.id, other);
      lay(level, rest, [...assigned, option.placement], levels, nextMap);
    }
  };

  const firstLevels = new Map<string, number>([[picked.id, 0]]);
  for (const unit of blockers) firstLevels.set(unit.id, 1);
  lay(blockers.length > 0 ? 1 : 0, blockers, [{ unit: picked, to: pickedAt }], firstLevels, new Map());

  // Costed, ordered, then judged in that order until the list is full.
  interface Costed extends Candidate {
    moves: SwapMove[];
    soft: SoftCost[];
    score: number;
  }
  // Costing is the heavy half of the search (soft.evaluate of every set, 0.2 to 0.9 ms a set on a school of some six hundred lessons, so over
  // a second for the 1 200 the cap allows) and it is one stretch of the event loop, which every other request of the process waits for.
  // So it gives the loop back every `costSlice` sets, and stops at the budget like the judging after it (g514).
  const costSlice = Math.max(1, input.costSlice ?? 64);
  const costed: Costed[] = [];
  for (const candidate of candidates) {
    if (costed.length > 0 && costed.length % costSlice === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (now() - started > input.budgetMs) {
        truncated = true;
        break;
      }
    }
    const moves = candidate.placements.flatMap((placement) => movesOfUnit(placement.unit, placement.to));
    const { costs, score } = input.soft(moves);
    costed.push({ ...candidate, moves, soft: costs, score });
  }
  const keyOf = (candidate: Costed): string =>
    [...candidate.moves].map((move) => `${move.lessonId}>${slotKey(move.to)}`).sort().join(';');
  costed.sort((a, b) => a.score - b.score || a.placements.length - b.placements.length || (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));

  const proposals: MakeRoomProposal[] = [];
  const chunk = Math.max(1, input.chunk ?? 24);
  let judged = 0;
  let refused = 0;
  for (let at = 0; at < costed.length && proposals.length < input.limit; at += chunk) {
    // The first chunk is always judged: a slow host gets a short list, never an empty one.
    if (at > 0 && judged >= input.limit && now() - started > input.budgetMs) {
      truncated = true;
      break;
    }
    const slice = costed.slice(at, at + chunk);
    const verdicts = await input.judge(slice.map((candidate) => candidate.moves));
    for (let index = 0; index < slice.length && proposals.length < input.limit; index += 1) {
      const candidate = slice[index]!;
      judged += 1;
      if (!verdicts[index]) {
        refused += 1;
        continue;
      }
      const ordered = [...candidate.placements].sort(
        (a, b) => (candidate.levels.get(a.unit.id) ?? 0) - (candidate.levels.get(b.unit.id) ?? 0) || byId(a.unit, b.unit),
      );
      proposals.push({
        moves: ordered.flatMap((placement) => movesOfUnit(placement.unit, placement.to)),
        levels: Object.fromEntries(candidate.levels),
        depth: Math.max(...candidate.levels.values()),
        soft: candidate.soft,
        score: candidate.score,
        units: ordered.map((placement) => placement.unit),
      });
    }
  }
  return { proposals, candidates: costed.length, judged, refused, truncated, landingsCut, blockers };
}
