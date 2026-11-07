import { proposalId, searchSwaps, type SwapSearchInput } from './swap-search';
import { buildUnits } from './swap-units';
import type { SoftCost, SwapLesson, SwapMove, SwapSlot, SwapUnit } from './swap-types';

const lesson = (id: string, day: number, start: number, over: Partial<SwapLesson> = {}): SwapLesson => ({
  id,
  subjectId: `s-${id}`,
  subjectName: id,
  studentGroupId: `g-${id}`,
  groupName: id,
  teacherId: null,
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

const unitsOf = (lessons: SwapLesson[], blockOf: (l: SwapLesson) => string | null = () => null) =>
  buildUnits(lessons, { blockOf, sameTimesOf: () => null, groupFacts: new Map(), sharesPupils: () => false });

const NO_COST: SoftCost[] = [];

/** A search over `lessons` where every move is free, judged ok, costing what `score` says. */
function search(lessons: SwapLesson[], over: Partial<SwapSearchInput> = {}, blockOf?: (l: SwapLesson) => string | null) {
  return searchSwaps({
    lessonId: lessons[0]!.id,
    unitOf: unitsOf(lessons, blockOf),
    mayStand: () => true,
    soft: (moves) => ({ costs: NO_COST, score: moves.length }),
    judge: async () => true,
    limit: 1000,
    budgetMs: 10_000,
    ...over,
  });
}

describe('searchSwaps', () => {
  const a = lesson('a', 1, 480);
  const b = lesson('b', 1, 600);
  const c = lesson('c', 2, 480);
  const d = lesson('d', 3, 480);

  it('finds a swap with every partner and a chain through every ordered pair of the others', async () => {
    const result = await search([a, b, c, d]);
    const swaps = result.proposals.filter((p) => p.kind === 'SWAP');
    const chains = result.proposals.filter((p) => p.kind === 'CHAIN');
    expect(swaps).toHaveLength(3);
    // a -> v -> w -> a for the ordered pairs of three partners.
    expect(chains).toHaveLength(6);
    expect(result.candidates).toBe(9);
    expect(result.judged).toBe(9);
    expect(result.refused).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('moves the picked unit to the partner’s slot and the partner to the picked unit’s, each keeping its length', async () => {
    const short = lesson('short', 2, 600, { endMinutes: 600 + 60 });
    const [swap] = (await search([a, short])).proposals;
    expect(swap!.kind).toBe('SWAP');
    expect(swap!.moves).toEqual([
      { lessonId: 'a', from: { dayOfWeek: 1, startMinutes: 480, endMinutes: 540 }, to: { dayOfWeek: 2, startMinutes: 600, endMinutes: 660 } },
      { lessonId: 'short', from: { dayOfWeek: 2, startMinutes: 600, endMinutes: 660 }, to: { dayOfWeek: 1, startMinutes: 480, endMinutes: 540 } },
    ]);
  });

  it('leaves out a partner of another length, one that stands in the same slot, and a locked one', async () => {
    const longer = lesson('longer', 2, 600, { endMinutes: 600 + 90 });
    const same = lesson('same', 1, 480);
    const locked = lesson('locked', 3, 600, { isLocked: true });
    const result = await search([a, longer, same, locked, b]);
    const partners = new Set(result.proposals.flatMap((p) => p.moves.map((m) => m.lessonId)));
    expect([...partners].sort()).toEqual(['a', 'b']);
  });

  it('lets the picked lesson itself be locked: the schemaläggare chose it', async () => {
    const result = await search([lesson('a', 1, 480, { isLocked: true }), b]);
    expect(result.proposals).toHaveLength(1);
  });

  it('answers a lesson that is not placed with nothing and says why', async () => {
    const result = await search([a, b], { lessonId: 'ghost' });
    expect(result).toMatchObject({ proposals: [], immovable: 'NOT_PLACED', candidates: 0 });
  });

  it('prunes with mayStand, asking each unit about the slot it would take, the two gone from where they were', async () => {
    const asked: Array<{ unit: string; to: SwapSlot; vacating: string[] }> = [];
    await search([a, b], {
      mayStand: (unit: SwapUnit, to, vacating) => {
        asked.push({ unit: unit.id, to, vacating: [...vacating].sort() });
        return true;
      },
    });
    expect(asked).toEqual([
      { unit: 'a', to: { dayOfWeek: 1, startMinutes: 600, endMinutes: 660 }, vacating: ['a', 'b'] },
      { unit: 'b', to: { dayOfWeek: 1, startMinutes: 480, endMinutes: 540 }, vacating: ['a', 'b'] },
    ]);
    const none = await search([a, b, c], { mayStand: () => false });
    expect(none).toMatchObject({ proposals: [], candidates: 0 });
  });

  it('offers a swap only when both can stand, and a chain only when all three edges can', async () => {
    // a may take b's slot and c's, b may take a's, c may not take a's.
    const allowed = new Set(['a>b', 'a>c', 'b>a', 'b>c', 'c>b']);
    const result = await search([a, b, c], {
      mayStand: (unit, to) => {
        const target = [b, c].concat(a).find((l) => l.dayOfWeek === to.dayOfWeek && l.startMinutes === to.startMinutes)!;
        return allowed.has(`${unit.id}>${target.id}`);
      },
    });
    // Swap a<->b: a>b and b>a both stand. Swap a<->c: c>a does not.
    expect(result.proposals.filter((p) => p.kind === 'SWAP').map((p) => p.moves[1]!.lessonId)).toEqual(['b']);
    // Chain a>b, b>c, c>a: c>a does not. Chain a>c, c>b, b>a: all three do.
    const chains = result.proposals.filter((p) => p.kind === 'CHAIN');
    expect(chains.map((p) => p.moves.map((m) => m.lessonId))).toEqual([['a', 'c', 'b']]);
  });

  it('orders by score, a swap before a chain of the same score, and names a proposal by its moves', async () => {
    const result = await search([a, b, c], { soft: (moves) => ({ costs: NO_COST, score: moves.length === 2 ? 5 : 1 }) });
    expect(result.proposals.map((p) => p.kind)).toEqual(['CHAIN', 'CHAIN', 'SWAP', 'SWAP']);
    const tied = await search([a, b, c], { soft: () => ({ costs: NO_COST, score: 0 }) });
    expect(tied.proposals.map((p) => p.kind)).toEqual(['SWAP', 'SWAP', 'CHAIN', 'CHAIN']);
    const [first] = result.proposals;
    expect(proposalId(first!.moves)).toBe(proposalId([...first!.moves].reverse()));
    expect(proposalId(first!.moves)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('judges in order until the list is full, counting the refusals', async () => {
    const judged: string[] = [];
    const result = await search([a, b, c, d], {
      limit: 2,
      soft: (moves) => ({ costs: NO_COST, score: moves.length }),
      judge: async (moves: readonly SwapMove[]) => {
        judged.push(proposalId(moves));
        // Refuse the first candidate it is asked about.
        return judged.length > 1;
      },
    });
    expect(result.proposals).toHaveLength(2);
    expect(result.judged).toBe(3);
    expect(result.refused).toBe(1);
  });

  it('stops judging when the time is out, but never before it has judged as many as it was asked for', async () => {
    let clock = 0;
    const result = await search([a, b, c, d], {
      limit: 3,
      budgetMs: 100,
      now: () => (clock += 60),
      judge: async () => false,
    });
    expect(result.truncated).toBe(true);
    expect(result.judged).toBeGreaterThanOrEqual(3);
    expect(result.judged).toBeLessThan(result.candidates);
    expect(result.proposals).toEqual([]);
  });

  it('costs no more than maxCandidates candidates, the swaps first, and says so', async () => {
    const result = await search([a, b, c, d], { maxCandidates: 4 });
    expect(result.candidates).toBe(4);
    expect(result.truncated).toBe(true);
    expect(result.proposals.filter((p) => p.kind === 'SWAP')).toHaveLength(3);
  });

  it('cuts the chains to the cheapest edges on each side, and says so apart from a shortfall', async () => {
    const many = [a, ...Array.from({ length: 6 }, (_, i) => lesson(`p${i}`, 2 + (i % 4), 480 + 60 * Math.floor(i / 4)))];
    const cut = await search(many, { maxEdges: 2 });
    const full = await search(many, { maxEdges: 100 });
    expect(cut.chainsCut).toBe(true);
    expect(cut.truncated).toBe(false);
    expect(full.chainsCut).toBe(false);
    expect(cut.proposals.filter((p) => p.kind === 'CHAIN').length).toBeLessThan(full.proposals.filter((p) => p.kind === 'CHAIN').length);
    // Every swap survives the cut: only chains are bounded.
    expect(cut.proposals.filter((p) => p.kind === 'SWAP')).toHaveLength(full.proposals.filter((p) => p.kind === 'SWAP').length);
  });

  it('moves a whole unit, and names the lessons that go along', async () => {
    const m1 = lesson('m1', 1, 480);
    const m2 = lesson('m2', 1, 480);
    const result = await search([m1, m2, b], {}, (l) => (l.id === 'm1' || l.id === 'm2' ? 'B' : null));
    const swap = result.proposals.find((p) => p.kind === 'SWAP')!;
    expect(swap.moves.map((m) => m.lessonId).sort()).toEqual(['b', 'm1', 'm2']);
    expect(swap.parallels).toEqual([{ kind: 'BLOCK', lessonId: 'm2', viaLessonId: 'm1', outcome: 'FOLLOWS' }]);
    // The block's two lessons land in one slot.
    const landing = swap.moves.filter((m) => m.lessonId !== 'b').map((m) => m.to);
    expect(landing[0]).toEqual(landing[1]);
  });
});
