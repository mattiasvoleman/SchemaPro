import { createHash } from 'node:crypto';
import { slotKey } from './swap-units';
import type {
  ParallelTouch,
  SoftCost,
  SwapMove,
  SwapProposal,
  SwapSlot,
  SwapUnit,
} from './swap-types';

/*
 * THE SEARCH: which lessons can trade places with this one, and which three
 * can go round.
 *
 * A SWAP is two units that exchange slots; a CHAIN of three is A to B's slot, B
 * to C's, C to A's. A unit is a lesson and the lessons the school laid beside
 * it (swap-units.ts), so what moves is whole. Slots must be of one length:
 * the day then keeps its shape, and a chain is a rotation of places, not a
 * reshuffle of the clock.
 *
 * THE SEARCH HOLDS NO RULE. Three things stand between a candidate and the
 * list, and only the last is a verdict:
 *
 *   1. `mayStand` prunes. It answers a question the clash rule also answers —
 *      teacher, room and class at the new time, the unit's own lessons and the
 *      lessons of the slot it takes left out — so it is a SUBSET of what the
 *      judge refuses. It can therefore only lose a proposal (a chain whose
 *      third unit clears a half-overlapping slot is one), never admit one.
 *   2. `soft` orders the survivors by what they cost.
 *   3. `judge` decides, in that order, until the list is full. It is the one
 *      rule of the write path (MasterLessonsService.findConflicts) and the
 *      grid's other hard kinds, asked of the moves as ONE move, as the card
 *      of a block is. A candidate it refuses is not a proposal.
 *
 * The cheap passes are bounded so that a school with thousands of lessons
 * still answers: `maxEdges` units per direction for chains, and a time budget
 * after which the list is what has been judged so far and says so.
 */

export interface SwapSearchInput {
  /** The lesson the schemaläggare picked. */
  lessonId: string;
  /** lesson id -> its unit. */
  unitOf: ReadonlyMap<string, SwapUnit>;
  /** Necessary condition only; see the module note. `vacating` are the lesson ids that leave. */
  mayStand: (unit: SwapUnit, to: SwapSlot, vacating: ReadonlySet<string>) => boolean;
  /** The soft figures of these moves. */
  soft: (moves: readonly SwapMove[]) => { costs: SoftCost[]; score: number };
  /** The hard verdict of these moves, as one move. True: every hard rule holds. */
  judge: (moves: readonly SwapMove[]) => Promise<boolean>;
  /** How many proposals to return. */
  limit: number;
  /** Stop judging after this many milliseconds. */
  budgetMs: number;
  /** Units to try per direction when building chains (the cheapest ones). */
  maxEdges?: number;
  now?: () => number;
}

export interface SwapSearchResult {
  proposals: Array<Pick<SwapProposal, 'kind' | 'moves' | 'parallels' | 'soft' | 'score'>>;
  /** Candidates that passed the prune. */
  candidates: number;
  /** Candidates the judge was asked about. */
  judged: number;
  /** The judge refused this many of them. */
  refused: number;
  /** The time budget ended the search, or a cap cut the chains short. */
  truncated: boolean;
  /** The picked lesson's unit cannot be moved at all, and why. */
  immovable?: 'NOT_PLACED';
}

const durationOf = (unit: SwapUnit): number => unit.slot.endMinutes - unit.slot.startMinutes;

const lessonIdsOf = (...units: SwapUnit[]): Set<string> => new Set(units.flatMap((unit) => unit.members.map((m) => m.id)));

/** A unit's members to a slot, each keeping its own length. */
function movesOf(unit: SwapUnit, to: SwapSlot): SwapMove[] {
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

/** The parallel lessons each moved unit takes along, named by the lesson they stand beside. */
function parallelsOf(units: readonly SwapUnit[]): ParallelTouch[] {
  return units.flatMap((unit) => unit.links.map((link) => ({ ...link, outcome: 'FOLLOWS' as const })));
}

/** A proposal's name: the same moves, the same name. */
export function proposalId(moves: readonly SwapMove[]): string {
  const canonical = [...moves]
    .sort((a, b) => (a.lessonId < b.lessonId ? -1 : a.lessonId > b.lessonId ? 1 : 0))
    .map((move) => `${move.lessonId}>${slotKey(move.to)}`)
    .join(';');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

interface Candidate {
  kind: 'SWAP' | 'CHAIN';
  units: SwapUnit[];
  moves: SwapMove[];
  soft: SoftCost[];
  score: number;
}

export async function searchSwaps(input: SwapSearchInput): Promise<SwapSearchResult> {
  const now = input.now ?? Date.now;
  const started = now();
  const picked = input.unitOf.get(input.lessonId);
  if (!picked) {
    return { proposals: [], candidates: 0, judged: 0, refused: 0, truncated: false, immovable: 'NOT_PLACED' };
  }
  const maxEdges = input.maxEdges ?? 40;
  let truncated = false;

  // Partners: distinct units of one length, free to move, standing elsewhere.
  const seen = new Set<string>();
  const partners: SwapUnit[] = [];
  for (const unit of input.unitOf.values()) {
    if (seen.has(unit.id)) continue;
    seen.add(unit.id);
    if (unit.id === picked.id || unit.locked) continue;
    if (durationOf(unit) !== durationOf(picked)) continue;
    if (slotKey(unit.slot) === slotKey(picked.slot)) continue;
    partners.push(unit);
  }
  partners.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // An edge: `unit` may stand at the slot of `target`, the two of them gone from where they were.
  const edges = new Map<string, boolean>();
  const stands = (unit: SwapUnit, target: SwapUnit): boolean => {
    const key = `${unit.id}>${target.id}`;
    let answer = edges.get(key);
    if (answer === undefined) {
      answer = input.mayStand(unit, target.slot, lessonIdsOf(unit, target));
      edges.set(key, answer);
    }
    return answer;
  };

  const candidates: Candidate[] = [];
  const add = (kind: Candidate['kind'], units: SwapUnit[], targets: SwapUnit[]) => {
    const moves = units.flatMap((unit, index) => movesOf(unit, targets[index]!.slot));
    const { costs, score } = input.soft(moves);
    candidates.push({ kind, units, moves, soft: costs, score });
  };

  // Swaps: U to V's slot and V to U's.
  const reachable: SwapUnit[] = [];
  const reaching: SwapUnit[] = [];
  for (const partner of partners) {
    const goes = stands(picked, partner);
    const comes = stands(partner, picked);
    if (goes && comes) add('SWAP', [picked, partner], [partner, picked]);
    if (goes) reachable.push(partner);
    if (comes) reaching.push(partner);
  }

  // Chains: U to V's slot, V to W's, W to U's. The pairs of (V, W) are many, so
  // each side is cut to the units whose own half of the chain costs least: V by
  // what U pays at V's slot, W by what W pays at U's. The cut is said in
  // `truncated`, and every chain that survives it is judged whole.
  const cheapest = (units: SwapUnit[], cost: (unit: SwapUnit) => number): SwapUnit[] =>
    units
      .map((unit) => ({ unit, cost: cost(unit) }))
      .sort((a, b) => a.cost - b.cost || (a.unit.id < b.unit.id ? -1 : 1))
      .slice(0, maxEdges)
      .map((entry) => entry.unit);
  const from = cheapest(reachable, (v) => input.soft(movesOf(picked, v.slot)).score);
  const into = cheapest(reaching, (w) => input.soft(movesOf(w, picked.slot)).score);
  if (reachable.length > from.length || reaching.length > into.length) truncated = true;
  for (const v of from) {
    for (const w of into) {
      if (v.id === w.id || slotKey(v.slot) === slotKey(w.slot)) continue;
      if (!stands(v, w)) continue;
      add('CHAIN', [picked, v, w], [v, w, picked]);
    }
  }

  candidates.sort((a, b) => a.score - b.score || (a.kind === b.kind ? 0 : a.kind === 'SWAP' ? -1 : 1) || (proposalId(a.moves) < proposalId(b.moves) ? -1 : 1));

  const proposals: SwapSearchResult['proposals'] = [];
  let judged = 0;
  let refused = 0;
  for (const candidate of candidates) {
    if (proposals.length >= input.limit) break;
    if (now() - started > input.budgetMs) {
      truncated = true;
      break;
    }
    judged += 1;
    if (!(await input.judge(candidate.moves))) {
      refused += 1;
      continue;
    }
    proposals.push({
      kind: candidate.kind,
      moves: candidate.moves,
      parallels: parallelsOf(candidate.units),
      soft: candidate.soft,
      score: candidate.score,
    });
  }
  return { proposals, candidates: candidates.length, judged, refused, truncated };
}
