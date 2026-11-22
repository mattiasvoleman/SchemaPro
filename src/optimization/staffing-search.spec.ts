import type { AiEngineWeekBoundsResponse, AiEngineWeekBoundsRow } from './interfaces/staffing-search.interface';
import type { Plan, RowPlan, TeacherPlan } from './staffing-proposal.service';
import {
  afterMove,
  compareCells,
  compareVectors,
  cutoffsOf,
  inRoundOrder,
  isNotTight,
  judge,
  judgedYearsOf,
  leftOutOf,
  movableRows,
  moveKey,
  movesOf,
  readEvaluation,
  runSearch,
  searchModelOf,
  tenthsIn,
  tightestOf,
  vectorOf,
  weekKey,
  type Evaluation,
  type Figures,
  type SearchDeps,
  type SearchLimits,
  type SearchModel,
  type SearchRow,
  type WeekCell,
  WaitLedger,
} from './staffing-search';

/*
 * The search's rules, with a made-up week in place of the engine: a week's demand is a base and the most one teacher's
 * posts in it add up to (a teacher is in one room), which is the shape of what the engine counts (teachers who share
 * groups queue) and is easy to read here.
 */

const cell = (demand: number, capacity = 1000): WeekCell => ({ demand, capacity });
const year = (weeks: Record<string, WeekCell>): Map<string, WeekCell> => new Map(Object.entries(weeks));
const figures = (years: Record<number, Record<string, WeekCell>>): Figures =>
  new Map(Object.entries(years).map(([y, weeks]) => [Number(y), year(weeks)]));

const row = (id: string, lead: string, options: string[], years: number[] = [9], chargeTenths = 100): SearchRow => ({
  requirementId: id,
  leadId: lead,
  options: [...options].sort(),
  chargeTenths,
  years,
});

const model = (rows: SearchRow[], teachers: Record<string, { current: number; limit: number | null }> = {}): SearchModel => ({
  rows,
  teachers: new Map(
    Object.entries(teachers).map(([id, t]) => [id, { currentTenths: t.current, limitTenths: t.limit }]),
  ),
});

const LIMITS: SearchLimits = { concurrency: 2, maxRounds: 30, maxEvaluations: 500, batch: 1000 };

// ---------------------------------------------------------------------------
// Figures

describe('figures', () => {
  it('compares two weeks as shares of their own supplies, exactly', () => {
    expect(compareCells(cell(2355, 2350), cell(2350, 2350))).toBeGreaterThan(0);
    expect(compareCells(cell(1100, 2200), cell(1000, 2000))).toBe(0);
    // A week of a larger supply carries more minutes at the same share: 2,400 of 2,400 is 2,350 of 2,350, 2,406 is above it.
    expect(compareCells(cell(2400, 2400), cell(2350, 2350))).toBe(0);
    expect(compareCells(cell(2406, 2400), cell(2350, 2350))).toBeGreaterThan(0);
    expect(compareCells(cell(2405, 2400), cell(2355, 2350))).toBeLessThan(0);
  });

  it('takes the tightest week of a year and lists every week largest share first', () => {
    const f = figures({ 8: { '0:x': cell(500), '1:x': cell(900) }, 9: { '0:x': cell(700) } });

    expect(tightestOf(f.get(8)!)).toEqual(cell(900));
    expect(vectorOf(f).map((c) => c.demand)).toEqual([900, 700, 500]);
  });

  it('orders two lists tightest first: a lower second week is an improvement while the tightest stays', () => {
    const before = vectorOf(figures({ 9: { a: cell(1002), b: cell(990) } }));
    const after = vectorOf(figures({ 9: { a: cell(1002), b: cell(900) } }));
    const worse = vectorOf(figures({ 9: { a: cell(1003), b: cell(100) } }));

    expect(compareVectors(after, before)).toBeLessThan(0);
    expect(compareVectors(worse, before)).toBeGreaterThan(0);
    expect(compareVectors(before, before)).toBe(0);
  });

  it('knows when no judged year is above the engine\'s tight threshold of 85 %', () => {
    expect(isNotTight(figures({ 9: { a: cell(850) } }))).toBe(true);
    expect(isNotTight(figures({ 9: { a: cell(851) } }))).toBe(false);
    expect(isNotTight(figures({ 8: { a: cell(100) }, 9: { a: cell(900) } }))).toBe(false);
  });

  it('names a week by its period and parity', () => {
    expect(weekKey(null, null)).toBe('x:x');
    expect(weekKey(1, 'ODD_WEEKS')).toBe('1:ODD_WEEKS');
  });
});

// ---------------------------------------------------------------------------
// What the engine said

const boundsRow = (patch: Partial<AiEngineWeekBoundsRow> = {}): AiEngineWeekBoundsRow => ({
  year: 9,
  period: 0,
  parity: null,
  demandMinutes: 2355,
  capacityMinutes: 2350,
  over: true,
  converged: true,
  cutoff: false,
  ...patch,
});
const answer = (patch: Partial<AiEngineWeekBoundsResponse> = {}): AiEngineWeekBoundsResponse => ({
  requestId: 'r',
  weeksTotal: 2,
  weeksCounted: 2,
  rows: [boundsRow({ period: 0 }), boundsRow({ period: 1, demandMinutes: 2300, over: false })],
  refusal: null,
  deadlineHit: false,
  elapsedMs: 100,
  ...patch,
});

describe('readEvaluation', () => {
  it('reads every week of an exact answer as a figure, over the supply or not', () => {
    const read = readEvaluation(answer(), [9]);

    expect(read.kind).toBe('FIGURES');
    if (read.kind !== 'FIGURES') return;
    expect(read.figures.get(9)!.get('0:x')).toEqual({ demand: 2355, capacity: 2350 });
    expect(read.figures.get(9)!.get('1:x')).toEqual({ demand: 2300, capacity: 2350 });
  });

  it('is refused by a quick count, with no figures', () => {
    expect(readEvaluation(answer({ rows: [], refusal: { code: 'TEACHER_HOURS_SHORT', params: {} } }), [9])).toEqual({
      kind: 'REFUSED',
      code: 'TEACHER_HOURS_SHORT',
    });
  });

  it.each<[string, Partial<AiEngineWeekBoundsResponse>, string]>([
    ['the seconds ran out', { deadlineHit: true }, 'DEADLINE'],
    ['fewer weeks than the year has were counted', { weeksCounted: 1 }, 'FEWER_WEEKS'],
    ['a pricing step was not proved', { rows: [boundsRow({ converged: false }), boundsRow({ period: 1 })] }, 'NOT_EXACT'],
    ['a year asked for has no figure', { rows: [boundsRow({ year: 8 })] }, 'MISSING_YEAR'],
  ])('ranks nobody when %s', (_name, patch, reason) => {
    expect(readEvaluation(answer(patch), [9])).toEqual({ kind: 'UNRANKED', reason });
  });

  it('reads a figure the cutoff stopped as proved worse, whatever else the answer lacks', () => {
    const stopped = answer({
      deadlineHit: true,
      weeksCounted: 1,
      rows: [boundsRow({ cutoff: true, converged: false })],
    });

    expect(readEvaluation(stopped, [9])).toEqual({ kind: 'WORSE', year: 9 });
  });

  it('leaves a row of a year that was not asked about out', () => {
    const read = readEvaluation(answer({ rows: [boundsRow({ year: 8, converged: false }), boundsRow({ period: 0 }), boundsRow({ period: 1 })] }), [9]);

    expect(read.kind).toBe('FIGURES');
  });

  it('gives the guard as each year\'s tightest week when the search began', () => {
    const start = figures({ 8: { a: cell(500, 2200), b: cell(900, 2200) }, 9: { a: cell(2355, 2350) } });

    expect(cutoffsOf(start, [9, 8])).toEqual([
      { year: 9, demandMinutes: 2355, capacityMinutes: 2350 },
      { year: 8, demandMinutes: 900, capacityMinutes: 2200 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The acceptance rule

describe('judge', () => {
  const start = figures({ 8: { a: cell(600) }, 9: { a: cell(1010), b: cell(990) } });

  const evaluated = (years: Figures): Evaluation => ({ kind: 'FIGURES', figures: years });

  it('keeps a candidate that lowers the weeks, tightest first, and gives the whole state\'s figures', () => {
    const judged = judge(evaluated(figures({ 9: { a: cell(950), b: cell(990) } })), start, start);

    expect(judged.kind).toBe('BETTER');
    if (judged.kind === 'BETTER') {
      expect(judged.figures.get(8)).toEqual(start.get(8));
      expect(judged.figures.get(9)!.get('a')).toEqual(cell(950));
    }
  });

  it('is not better when nothing is lower, and not when one week falls and a higher one rises', () => {
    expect(judge(evaluated(figures({ 9: { a: cell(1010), b: cell(990) } })), start, start).kind).toBe('NOT_BETTER');
    // The tightest week of year 9 is the same, the second falls: better.
    expect(judge(evaluated(figures({ 9: { a: cell(1010), b: cell(800) } })), start, start).kind).toBe('BETTER');
    // The tightest week rises above what the year began with: worse, and a lower second week does not pay for it.
    expect(judge(evaluated(figures({ 9: { a: cell(1011), b: cell(100) } })), start, start)).toEqual({ kind: 'WORSE', year: 9 });
  });

  it('never accepts a year whose tightest week is worse than it was when the search began, whatever it does for another', () => {
    // A candidate that touches both years: year 9 falls a lot, year 8 rises from 600 to 601.
    const both = evaluated(figures({ 8: { a: cell(601) }, 9: { a: cell(500), b: cell(500) } }));

    expect(judge(both, start, start)).toEqual({ kind: 'WORSE', year: 8 });
  });

  it('compares with the year as the search BEGAN, not as the last accepted state has it', () => {
    // The state has improved year 9 from 1010 to 900; a candidate that raises it to 950 is lower than the start's 1010.
    const improved = figures({ 8: { a: cell(600) }, 9: { a: cell(900), b: cell(900) } });
    const rises = evaluated(figures({ 9: { a: cell(950), b: cell(900) } }));

    expect(judge(rises, improved, start).kind).toBe('NOT_BETTER');
  });

  it('passes on what ranks nobody, and a candidate with other weeks than the state it is set against', () => {
    expect(judge({ kind: 'UNRANKED', reason: 'DEADLINE' }, start, start)).toEqual({ kind: 'UNRANKED', reason: 'DEADLINE' });
    expect(judge({ kind: 'REFUSED', code: 'X' }, start, start)).toEqual({ kind: 'REFUSED', code: 'X' });
    expect(judge({ kind: 'WORSE', year: 9 }, start, start)).toEqual({ kind: 'WORSE', year: 9 });
    expect(judge(evaluated(figures({ 9: { a: cell(500), c: cell(500) } })), start, start)).toEqual({
      kind: 'UNRANKED',
      reason: 'INCONSISTENT',
    });
    expect(judge(evaluated(figures({ 7: { a: cell(500) } })), start, start)).toEqual({ kind: 'UNRANKED', reason: 'INCONSISTENT' });
  });
});

// ---------------------------------------------------------------------------
// Moves

describe('movesOf and the ordinance\'s highest level of teaching time (scopeCeilingTenths)', () => {
  const rows = [row('p1', 'A', ['A', 'B']), row('p2', 'B', ['A', 'B'])];
  const judged = new Set([9]);
  const withCeiling = (ceilings: Record<string, number>, current = { A: 300, B: 100 }): SearchModel => ({
    rows,
    teachers: new Map(
      Object.entries(current).map(([id, tenths]) => [
        id,
        { currentTenths: tenths, limitTenths: 1000, ...(ceilings[id] === undefined ? {} : { scopeCeilingTenths: ceilings[id] }) },
      ]),
    ),
  });
  const asked = (m: SearchModel) =>
    movesOf(m, new Map(), judged).map((move) => move.changes.map((c) => `${c.requirementId}>${c.toTeacherId}`).join('+'));

  it('offers a move to a teacher who ends within the ordinance\'s edge, and no more', () => {
    // B is given p1 (100 tenths): 200, within a ceiling of 250; with a ceiling of 150 it is over it, and not offered.
    expect(asked(withCeiling({ B: 250 }))).toContain('p1>B');
    expect(asked(withCeiling({ B: 150 })).filter((entry) => entry.endsWith('>B') && !entry.includes('+'))).toEqual([]);
  });

  it('is the same search for a school that asks nothing: no ceiling, no change', () => {
    expect(asked(withCeiling({}))).toEqual(asked(withCeiling({ A: 10_000, B: 10_000 })));
  });

  it('does not stop a teacher who is already over the ordinance from ending no more over: they begin no worse off', () => {
    // B carries 100 tenths against a ceiling of 50 (over); a swap that leaves them at 100 is no more than they began with.
    expect(asked(withCeiling({ B: 50 }))).toContain('p1>B+p2>A');
  });
});

describe('movesOf', () => {
  const rows = [
    row('p1', 'A', ['A', 'B', 'C']),
    row('p2', 'A', ['A', 'B']),
    row('p3', 'B', ['A', 'B']),
  ];
  const judged = new Set([9]);

  it('gives every post to every other teacher who may lead it and has room, in a stable order', () => {
    const open = model(rows, { A: { current: 300, limit: 1000 }, B: { current: 100, limit: 1000 }, C: { current: 0, limit: 1000 } });

    const moves = movesOf(open, new Map(), judged);

    expect(moves.map((move) => move.changes.map((c) => `${c.requirementId}>${c.toTeacherId}`))).toEqual([
      ['p1>B'],
      ['p1>C'],
      ['p2>B'],
      ['p3>A'],
    ]);
    expect(movesOf(open, new Map(), judged)).toEqual(moves);
  });

  it('gives nothing to a teacher without room for it, and swaps where room is all that stops it', () => {
    // B has room for nothing more; A cannot take two. p1 (A to B) is blocked by B's room: B gives p3 back, which A may take.
    const tight = model(rows, { A: { current: 300, limit: 400 }, B: { current: 100, limit: 100 }, C: { current: 0, limit: null } });

    const moves = movesOf(tight, new Map(), judged).map((move) => move.changes.map((c) => `${c.requirementId}>${c.toTeacherId}`));

    // C has no limit (room unknown): never a receiver. B is full, so a post to B is a swap with B's own post p3 (equal charge):
    // p1 and p2 each can be swapped for it. A has room for exactly one more post, so p3 may also go to A on its own.
    expect(moves.flat().every((entry) => !entry.endsWith('>C'))).toBe(true);
    expect(moves).toEqual([['p1>B', 'p3>A'], ['p2>B', 'p3>A'], ['p3>A']]);
  });

  it('lets a post go back to the lead it started with whatever that lead\'s room, and never to nobody', () => {
    const full = model([row('p1', 'A', ['A', 'B'])], { A: { current: 100, limit: 0 }, B: { current: 0, limit: 1000 } });
    const moved = new Map([['p1', 'B']]);

    const back = movesOf(full, moved, judged).map((move) => move.changes);

    expect(back).toEqual([[{ requirementId: 'p1', toTeacherId: 'A' }]]);
  });

  it('lets a post go back to its first lead only while that lead is no busier than they began or within their room (a lead given another post meanwhile is not exempt)', () => {
    // A leads p1 (100 of 150). p1 went to C, and B's p2 went to A, who had room for it while p1 was away. p1 coming back would give A
    // 200 of 150, more than they began with and past their limit: growthRefusal (the write's own question) refuses that state.
    const m = model(
      [row('p1', 'A', ['A', 'B', 'C']), row('p2', 'B', ['A', 'B'])],
      { A: { current: 100, limit: 150 }, B: { current: 100, limit: 100 }, C: { current: 0, limit: 1000 } },
    );
    const state = new Map([['p1', 'C'], ['p2', 'A']]);

    const asked = movesOf(m, state, judged).map((move) => move.changes.map((c) => `${c.requirementId}>${c.toTeacherId}`).join('+'));

    expect(asked).not.toContain('p1>A');
    // The same post back to A when A has nothing else is still allowed, whatever A's room: it is what they began with.
    const over = model([row('p1', 'A', ['A', 'B'])], { A: { current: 100, limit: 0 }, B: { current: 0, limit: 1000 } });
    expect(movesOf(over, new Map([['p1', 'B']]), judged)).toHaveLength(1);
  });

  it('does not swap a post back to its first lead when that lead holds more by now than their room allows', () => {
    // A began with o (200 of 250). o went to C, and z and r (100 each) came to A meanwhile: 200 of 250. C is full (o, 200 of 200), so
    // r to C is a swap with o, which A "may take back": but A would then hold z and o, 300 of 250, more than they began with.
    const m = model(
      [row('o', 'A', ['A', 'C'], [9], 200), row('z', 'D', ['A', 'D']), row('r', 'B', ['A', 'B', 'C'])],
      { A: { current: 200, limit: 250 }, B: { current: 100, limit: 100 }, C: { current: 0, limit: 200 }, D: { current: 100, limit: 100 } },
    );
    const state = new Map([['o', 'C'], ['z', 'A'], ['r', 'A']]);

    const asked = movesOf(m, state, judged);

    for (const move of asked) {
      const after = tenthsIn(m, afterMove(m, state, move));
      for (const [id, teacher] of m.teachers) {
        const held = after.get(id) ?? 0;
        // growthRefusal's question: nobody who ends with more than they began with ends over their limit.
        expect(held > teacher.currentTenths && teacher.limitTenths !== null && held > teacher.limitTenths).toBe(false);
      }
    }
  });

  it('keeps a post out of a move when a year it spans is not judged', () => {
    const wide = model([row('p1', 'A', ['A', 'B'], [8, 9])], { A: { current: 100, limit: 1000 }, B: { current: 0, limit: 1000 } });

    expect(movesOf(wide, new Map(), new Set([9]))).toEqual([]);
    expect(movesOf(wide, new Map(), new Set([8, 9]))).toHaveLength(1);
    expect(movableRows(wide, new Set([9]))).toEqual({ rows: [], skipped: 1 });
  });

  it('counts what each teacher leads after moves, and drops a post that is back where it started', () => {
    const open = model(rows, { A: { current: 300, limit: 1000 }, B: { current: 100, limit: 1000 }, C: { current: 0, limit: 1000 } });
    const state = afterMove(open, new Map(), { changes: [{ requirementId: 'p1', toTeacherId: 'C' }], years: [9] });

    expect(Object.fromEntries(tenthsIn(open, state))).toEqual({ A: 200, B: 100, C: 100 });
    expect(afterMove(open, state, { changes: [{ requirementId: 'p1', toTeacherId: 'A' }], years: [9] }).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The time spent waiting for the engine

describe('WaitLedger', () => {
  const immediately = async (): Promise<void> => undefined;

  it('credits each slice it waited, and no more than the wait it was asked for', async () => {
    const ledger = new WaitLedger();

    await ledger.wait(2500, 1000, immediately, () => false);

    // Slices of 1,000, 1,000 and 500.
    expect(ledger.credited).toBe(2500);
  });

  it('stops at the slice it is in when it is told to stop: a cancel is heard inside a wait', async () => {
    const ledger = new WaitLedger();
    let slices = 0;

    await ledger.wait(10_000, 1000, async () => { slices += 1; }, () => slices >= 2);

    expect(slices).toBe(2);
    expect(ledger.credited).toBe(2000);
  });

  it('counts the time several waiters wait together once, not once each: more workers do not buy more time', async () => {
    const ledger = new WaitLedger();
    // Two waiters begin together and wait three slices each; their slices end in the same moments.
    await Promise.all([ledger.wait(3000, 1000, immediately, () => false), ledger.wait(3000, 1000, immediately, () => false)]);

    expect(ledger.credited).toBe(3000);

    // A wait on its own afterwards is credited in full again.
    await ledger.wait(1000, 1000, immediately, () => false);
    expect(ledger.credited).toBe(4000);
  });

  it('keeps crediting while one waiter is left of two: the later one is credited when the first has gone', async () => {
    const ledger = new WaitLedger();

    await Promise.all([ledger.wait(1000, 1000, immediately, () => false), ledger.wait(4000, 1000, immediately, () => false)]);

    // One slice together, three of the longer one alone: 4,000 of wall time, not 5,000.
    expect(ledger.credited).toBe(4000);
  });
});

// ---------------------------------------------------------------------------
// What the search leaves, said

describe('leftOutOf', () => {
  const none = { notFree: 0, unstaffed: 0, noChoice: 0, notInWeek: 0 };
  const teachers = { A: { current: 100, limit: 1000 }, B: { current: 0, limit: 1000 } };

  it('says nothing when every post a search could move is moved and the plan holds nothing else', () => {
    const open = model([row('p1', 'A', ['A', 'B'], [9])], teachers);

    expect(leftOutOf(open, none, figures({ 9: { '0:x': cell(900) } }), [9])).toEqual({ posts: [], years: [] });
  });

  it('counts the posts the plan holds that a search does not look at, each under its reason and in a fixed order', () => {
    const open = model([row('p1', 'A', ['A', 'B'], [9])], teachers);

    const said = leftOutOf(open, { notFree: 5, unstaffed: 3, noChoice: 2, notInWeek: 1 }, figures({ 9: { '0:x': cell(900) } }), [9]);

    expect(said.posts).toEqual([
      { reason: 'NOT_FREE', count: 5 },
      { reason: 'UNSTAFFED', count: 3 },
      { reason: 'NO_CHOICE', count: 2 },
      { reason: 'NOT_IN_WEEK', count: 1 },
    ]);
    expect(said.years).toEqual([]);
  });

  it('names a year past the limit and the posts that span it: five years with a figure, four judged', () => {
    const wide = model(
      [
        row('p1', 'A', ['A', 'B'], [5]),
        row('p2', 'A', ['A', 'B'], [9]),
        row('p3', 'A', ['A', 'B'], [8, 9]),
        row('p4', 'A', ['A', 'B'], [5, 9]),
        row('p5', 'A', ['A', 'B'], [6]),
        row('p6', 'A', ['A', 'B'], [7]),
      ],
      teachers,
    );
    const start = figures({ 5: { '0:x': cell(100) }, 6: { '0:x': cell(300) }, 7: { '0:x': cell(500) }, 8: { '0:x': cell(700) }, 9: { '0:x': cell(900) } });
    const judged = judgedYearsOf(wide, start, 4);

    const said = leftOutOf(wide, none, start, judged);

    // The four tightest are judged (9, 8, 7, 6); year 5, the slackest, is named, and so are the two posts that span it.
    expect(judged).toEqual([9, 8, 7, 6]);
    expect(said.years).toEqual([{ year: 5, reason: 'YEAR_LIMIT' }]);
    expect(said.posts).toEqual([{ reason: 'YEAR_LIMIT', count: 2 }]);
  });

  it('says a year whose figure was not counted to the end, and counts its posts under that reason before the limit', () => {
    const wide = model(
      [row('p1', 'A', ['A', 'B'], [8]), row('p2', 'A', ['A', 'B'], [9]), row('p3', 'A', ['A', 'B'], [8, 9]), row('p4', 'A', ['A', 'B'], [7])],
      teachers,
    );
    // Years 8 and 9 were counted exactly; 7 was not (no figure): its post is "not counted", the others are judged.
    const start = figures({ 8: { '0:x': cell(700) }, 9: { '0:x': cell(900) } });

    const said = leftOutOf(wide, none, start, judgedYearsOf(wide, start, 4));

    expect(said.years).toEqual([{ year: 7, reason: 'YEAR_NOT_COUNTED' }]);
    expect(said.posts).toEqual([{ reason: 'YEAR_NOT_COUNTED', count: 1 }]);
  });

  it('counts a post under YEAR_NOT_COUNTED when one of its years was not counted and another is past the limit', () => {
    const wide = model([row('p1', 'A', ['A', 'B'], [5, 6, 7])], teachers);
    // 5 has a figure but the limit is 1 and 6 is tighter; 7 has no figure.
    const start = figures({ 5: { '0:x': cell(100) }, 6: { '0:x': cell(900) } });

    const said = leftOutOf(wide, none, start, judgedYearsOf(wide, start, 1));

    expect(said.years).toEqual([
      { year: 5, reason: 'YEAR_LIMIT' },
      { year: 7, reason: 'YEAR_NOT_COUNTED' },
    ]);
    expect(said.posts).toEqual([{ reason: 'YEAR_NOT_COUNTED', count: 1 }]);
  });

  it('says every year of a search that could count none: all of them not counted, and every post with a choice', () => {
    const wide = model([row('p1', 'A', ['A', 'B'], [8]), row('p2', 'A', ['A', 'B'], [9])], teachers);

    const said = leftOutOf(wide, { ...none, unstaffed: 2 }, new Map(), []);

    expect(said.years).toEqual([
      { year: 8, reason: 'YEAR_NOT_COUNTED' },
      { year: 9, reason: 'YEAR_NOT_COUNTED' },
    ]);
    expect(said.posts).toEqual([
      { reason: 'UNSTAFFED', count: 2 },
      { reason: 'YEAR_NOT_COUNTED', count: 2 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The model from a plan

describe('searchModelOf', () => {
  const teacher = (userId: string, patch: Partial<TeacherPlan> = {}): TeacherPlan =>
    ({ userId, target: 1000, targetTenths: 10000, limitTenths: 11000, floorTenths: 0, fixedTenths: 0, currentTenths: 500, keepOrShed: false, ...patch }) as TeacherPlan;
  const planned = (id: string, patch: Partial<RowPlan> = {}): RowPlan =>
    ({
      row: { id },
      kind: 'KEPT',
      inconsistent: false,
      vacated: false,
      current: 'A',
      co: null,
      chargeExact: 10,
      chargeTenths: 100,
      lessonMinutes: 100,
      eligible: ['A', 'B', 'C'],
      lastYear: [],
      excluded: [],
      ...patch,
    }) as RowPlan;
  const planOf = (rows: RowPlan[], teachers: TeacherPlan[]): Plan =>
    ({
      recorded: true,
      respect: true,
      respectForcedByPolicy: false,
      tolerance: 10,
      staff: new Set(teachers.map((t) => t.userId)),
      candidates: new Set(teachers.map((t) => t.userId)),
      teachers,
      teacherById: new Map(teachers.map((t) => [t.userId, t])),
      rows,
      rowById: new Map(rows.map((r) => [r.row.id, r])),
      pinned: [],
    }) as Plan;

  it('offers a released post to the teachers the plan lets lead it, and leaves out those it does not', () => {
    const plan = planOf(
      [planned('p1', { excluded: ['C'] }), planned('p2', { eligible: ['A'] }), planned('p3', { kind: 'FIXED' }), planned('p4', { kind: 'OPEN', current: null })],
      [teacher('A'), teacher('B'), teacher('C', { keepOrShed: true })],
    );

    const { model: built, excluded } = searchModelOf(plan, () => [9]);

    // p1: A (keeps) and B; C is excluded. p2: only A is eligible, so nobody to move it to. p3 is fixed and p4 has nobody to move.
    expect(built.rows.map((r) => [r.requirementId, r.options])).toEqual([['p1', ['A', 'B']]]);
    // Every post the search does not look at is counted under its own reason: none is left out in silence.
    expect(excluded).toEqual({ notFree: 1, unstaffed: 1, noChoice: 1, notInWeek: 0 });
    expect(built.teachers.get('A')).toEqual({ currentTenths: 500, limitTenths: 11000 });
  });

  it('leaves a post that is not in the week, or whose years are not known, out of the search', () => {
    const plan = planOf([planned('p1'), planned('p2'), planned('p3')], [teacher('A'), teacher('B')]);

    const { model: built, excluded } = searchModelOf(plan, (id) => (id === 'p1' ? [9] : id === 'p2' ? null : []));

    expect(built.rows.map((r) => r.requirementId)).toEqual(['p1']);
    expect(excluded).toEqual({ notFree: 0, unstaffed: 0, noChoice: 0, notInWeek: 2 });
  });

  it('counts a free post nobody leads as unstaffed, a post the school keeps as not free, and a staffed one in a year no week carries as not in the week (a post of every kind is counted once)', () => {
    const plan = planOf(
      [
        planned('free-a'),
        planned('free-b', { kind: 'FIXED' }),
        planned('free-c', { kind: 'FIXED' }),
        planned('open-a', { kind: 'OPEN', current: null }),
        planned('open-b', { kind: 'OPEN', current: null }),
        planned('open-c', { kind: 'OPEN', current: null }),
        planned('kept-no-lead', { current: null }),
        planned('lonely', { eligible: ['A'] }),
        planned('no-week'),
      ],
      [teacher('A'), teacher('B')],
    );

    const { model: built, excluded } = searchModelOf(plan, (id) => (id === 'no-week' ? null : [9]));

    expect(built.rows.map((r) => r.requirementId)).toEqual(['free-a']);
    expect(excluded).toEqual({ notFree: 2, unstaffed: 4, noChoice: 1, notInWeek: 1 });
  });

  it('never offers a post to its co-teacher', () => {
    const plan = planOf([planned('p1', { co: 'B' })], [teacher('A'), teacher('B'), teacher('C')]);

    expect(searchModelOf(plan, () => [9]).model.rows[0]!.options).toEqual(['A', 'C']);
  });
});

// ---------------------------------------------------------------------------
// Judged years

describe('judgedYearsOf', () => {
  it('takes the tightest years that a post with a choice spans, at most the limit', () => {
    const m = model([row('p1', 'A', ['A', 'B'], [9]), row('p2', 'A', ['A', 'B'], [8]), row('p3', 'A', ['A', 'B'], [7])]);
    const baseline = figures({ 6: { a: cell(990) }, 7: { a: cell(700) }, 8: { a: cell(900) }, 9: { a: cell(1005) } });

    // Year 6 has no post to move: it is not judged however tight it is.
    expect(judgedYearsOf(m, baseline, 2)).toEqual([9, 8]);
    expect(judgedYearsOf(m, baseline, 5)).toEqual([9, 8, 7]);
  });
});

// ---------------------------------------------------------------------------
// The search, against a made-up week

/** A week of year 9: a base plus what the busiest teacher's posts in it add. `posts`: id -> minutes, `weeks`: which weeks a post runs in. */
function oracle(posts: Record<string, { minutes: number; weeks: string[]; years?: number[] }>, base: Record<string, number>) {
  const calls: { leads: ReadonlyMap<string, string>; years: readonly number[] }[] = [];
  const figuresOf = (model_: SearchModel, leads: ReadonlyMap<string, string>, years: readonly number[]): Figures => {
    const out = new Map<number, Map<string, WeekCell>>();
    for (const y of years) {
      const weeks = new Map<string, WeekCell>();
      for (const [week, b] of Object.entries(base)) {
        const perTeacher = new Map<string, number>();
        for (const r of model_.rows) {
          const post = posts[r.requirementId]!;
          if (!post.weeks.includes(week) || !(post.years ?? [9]).includes(y)) continue;
          const lead = leads.get(r.requirementId) ?? r.leadId;
          perTeacher.set(lead, (perTeacher.get(lead) ?? 0) + post.minutes);
        }
        weeks.set(week, cell(b + Math.max(0, ...perTeacher.values())));
      }
      out.set(y, weeks);
    }
    return out;
  };
  return { calls, figuresOf };
}

describe('runSearch', () => {
  const posts = {
    p1: { minutes: 200, weeks: ['a', 'b'] },
    p2: { minutes: 200, weeks: ['a', 'b'] },
    p3: { minutes: 200, weeks: ['a'] },
    p4: { minutes: 100, weeks: ['b'] },
  };
  const rows = [
    row('p1', 'A', ['A', 'B', 'C']),
    row('p2', 'A', ['A', 'B', 'C']),
    row('p3', 'A', ['A', 'B', 'C']),
    row('p4', 'A', ['A', 'B', 'C']),
  ];
  const open = model(rows, { A: { current: 700, limit: 100000 }, B: { current: 0, limit: 100000 }, C: { current: 0, limit: 100000 } });
  const base = { a: 700, b: 680 };

  function deps(overrides: Partial<SearchDeps> = {}) {
    const { calls, figuresOf } = oracle(posts, base);
    const accepted: number[] = [];
    const d: SearchDeps = {
      evaluate: async (leads, years) => {
        calls.push({ leads: new Map(leads), years });
        return { kind: 'FIGURES', figures: figuresOf(open, leads, years) };
      },
      stopped: () => null,
      accepted: (progress) => {
        accepted.push(progress.accepted);
      },
      ...overrides,
    };
    return { d, calls, accepted, figuresOf };
  }

  it('spreads the posts of the busiest teacher until no single move eases the week, and never ends worse than it began', async () => {
    const { d, figuresOf, accepted } = deps();
    const start = figuresOf(open, new Map(), [9]);

    const outcome = await runSearch(open, start, LIMITS, d);

    expect(outcome.stop).toBe('LOCAL_OPTIMUM');
    // Week a: A carries 600 of the three posts in it at the start (1,300 of 1,000); at best the posts allow 200 each (900).
    expect(tightestOf(start.get(9)!)).toEqual(cell(1300));
    expect(tightestOf(outcome.figures.get(9)!).demand).toBeLessThan(1300);
    expect(compareVectors(vectorOf(outcome.figures), vectorOf(start))).toBeLessThan(0);
    // The leads it ends with, taken as the oracle sees them, are the figures it says.
    expect(outcome.figures).toEqual(figuresOf(open, outcome.leads, [9]));
    expect(accepted).toEqual(Array.from({ length: outcome.accepted }, (_, index) => index + 1));
    // Posts that stayed are not in the leads.
    for (const [id, lead] of outcome.leads) expect(lead).not.toBe(rows.find((r) => r.requirementId === id)!.leadId);
  });

  it('is the same search every time', async () => {
    const first = await runSearch(open, oracle(posts, base).figuresOf(open, new Map(), [9]), LIMITS, deps().d);
    const second = await runSearch(open, oracle(posts, base).figuresOf(open, new Map(), [9]), LIMITS, deps().d);

    expect([...first.leads]).toEqual([...second.leads]);
    expect(first.evaluations).toBe(second.evaluations);
  });

  it('asks nothing of a week that is not tight', async () => {
    const roomy = figures({ 9: { a: cell(500), b: cell(400) } });
    const { d, calls } = deps();

    const outcome = await runSearch(open, roomy, LIMITS, d);

    expect(outcome.stop).toBe('NOT_TIGHT');
    expect(calls).toEqual([]);
  });

  it('has nothing to do when no post has anywhere to go', async () => {
    const empty = model([], {});
    const { d, calls } = deps();

    const outcome = await runSearch(empty, figures({ 9: { a: cell(1100) } }), LIMITS, d);

    expect(outcome.stop).toBe('NO_MOVES');
    expect(calls).toEqual([]);
  });

  it('never takes a move the engine could not count to the end, however good its figure looks', async () => {
    const { figuresOf } = oracle(posts, base);
    const start = figuresOf(open, new Map(), [9]);
    const tell = [
      { kind: 'UNRANKED', reason: 'DEADLINE' },
      { kind: 'UNRANKED', reason: 'NOT_EXACT' },
      { kind: 'UNRANKED', reason: 'FEWER_WEEKS' },
      { kind: 'REFUSED', code: 'X' },
      { kind: 'WORSE', year: 9 },
    ] as const satisfies readonly Evaluation[];
    let turn = 0;
    const d: SearchDeps = {
      evaluate: async () => tell[turn++ % tell.length]!,
      stopped: () => null,
    };

    const outcome = await runSearch(open, start, LIMITS, d);

    expect(outcome.accepted).toBe(0);
    expect(outcome.leads.size).toBe(0);
    expect(outcome.figures).toBe(start);
    // Not a local optimum: some of what was asked could not be counted, and a move that was not counted was not shown not to help.
    expect(outcome.stop).toBe('NOT_ALL_COUNTED');
    expect(outcome.tally.unranked.DEADLINE + outcome.tally.unranked.NOT_EXACT + outcome.tally.unranked.FEWER_WEEKS).toBeGreaterThan(0);
    expect(outcome.tally.refused).toBeGreaterThan(0);
    expect(outcome.tally.worse).toBeGreaterThan(0);
  });

  it('says a local optimum only when every move of the last round was counted to the end', async () => {
    const { figuresOf } = oracle(posts, base);
    const start = figuresOf(open, new Map(), [9]);
    const worse = (leads: ReadonlyMap<string, string>, years: readonly number[]): Evaluation => ({
      kind: 'FIGURES',
      figures: new Map([...figuresOf(open, leads, years)].map(([y, weeks]) => [y, new Map([...weeks].map(([k, c]) => [k, cell(c.demand + 10_000)]))])),
    });
    const allCounted = await runSearch(open, start, LIMITS, { evaluate: async (leads, years) => worse(leads, years), stopped: () => null });
    expect(allCounted.stop).toBe('LOCAL_OPTIMUM');
    expect(allCounted.tally.better).toBe(0);
    // The same, but one move of the round is one the engine could not count to the end, whatever the reason it gives.
    for (const reason of ['DEADLINE', 'NOT_EXACT', 'FEWER_WEEKS', 'MISSING_YEAR', 'INCONSISTENT', 'ENGINE_ERROR'] as const) {
      let asked = 0;
      const oneUncounted = await runSearch(open, start, LIMITS, {
        evaluate: async (leads, years) => (asked++ === 3 ? { kind: 'UNRANKED', reason } : worse(leads, years)),
        stopped: () => null,
      });

      expect([reason, oneUncounted.stop]).toEqual([reason, 'NOT_ALL_COUNTED']);
      expect([reason, oneUncounted.tally.unranked[reason]]).toEqual([reason, 1]);
    }
  });

  it('keeps the best state so far when the school cancels, and says so', async () => {
    const { figuresOf } = oracle(posts, base);
    const start = figuresOf(open, new Map(), [9]);
    let accepted = 0;
    const { d } = deps({
      stopped: () => (accepted >= 1 ? 'CANCELLED' : null),
      accepted: (progress) => {
        accepted = progress.accepted;
      },
    });

    const outcome = await runSearch(open, start, LIMITS, d);

    expect(outcome.stop).toBe('CANCELLED');
    expect(outcome.accepted).toBe(1);
    expect(outcome.leads.size).toBeGreaterThan(0);
    expect(compareVectors(vectorOf(outcome.figures), vectorOf(start))).toBeLessThan(0);
  });

  it('stops at once, with what it has, when the budget is out before it begins', async () => {
    const { figuresOf } = oracle(posts, base);
    const { d, calls } = deps({ stopped: () => 'BUDGET' });

    const outcome = await runSearch(open, figuresOf(open, new Map(), [9]), LIMITS, d);

    // Not even a round is begun: the stop is asked before it, and not only before each evaluation.
    expect(outcome).toMatchObject({ stop: 'BUDGET', accepted: 0, evaluations: 0, round: 0 });
    expect(calls).toEqual([]);
  });

  it('gives up on an engine that has no such route, and on one that fails again and again', async () => {
    const { figuresOf } = oracle(posts, base);
    const start = figuresOf(open, new Map(), [9]);

    const older = await runSearch(open, start, { ...LIMITS, concurrency: 1 }, {
      evaluate: async () => ({ kind: 'UNRANKED', reason: 'ENGINE_OLDER' }),
      stopped: () => null,
    });
    const failing = await runSearch(open, start, { ...LIMITS, concurrency: 1 }, {
      evaluate: async () => {
        throw new Error('boom');
      },
      stopped: () => null,
    });

    expect(older.stop).toBe('ENGINE_OLDER');
    expect(older.evaluations).toBe(1);
    expect(failing.stop).toBe('ENGINE_FAILING');
    expect(failing.evaluations).toBe(6);
    expect(failing.accepted).toBe(0);
  });

  it('ends at once, with what it has, when the engine stays too busy to count (not as a failure, and not after six tries)', async () => {
    const { figuresOf } = oracle(posts, base);
    const start = figuresOf(open, new Map(), [9]);

    const busy = await runSearch(open, start, { ...LIMITS, concurrency: 1 }, {
      evaluate: async () => ({ kind: 'UNRANKED', reason: 'ENGINE_BUSY' }),
      stopped: () => null,
    });

    expect(busy.stop).toBe('ENGINE_BUSY');
    expect(busy.evaluations).toBe(1);
    expect(busy.accepted).toBe(0);
    expect(busy.tally.unranked.ENGINE_BUSY).toBe(1);
  });

  it('stops at the number of evaluations it was given', async () => {
    const { figuresOf } = oracle(posts, base);

    const outcome = await runSearch(open, figuresOf(open, new Map(), [9]), { ...LIMITS, maxEvaluations: 3, concurrency: 1 }, deps().d);

    expect(outcome.evaluations).toBeLessThanOrEqual(3);
    expect(['MAX_EVALUATIONS', 'LOCAL_OPTIMUM', 'NOT_TIGHT']).toContain(outcome.stop);
  });

  it('does not ask for the rest of a round once a batch has found an improvement', async () => {
    const { figuresOf } = oracle(posts, base);
    const start = figuresOf(open, new Map(), [9]);
    const all = deps();
    const batched = deps();

    await runSearch(open, start, { ...LIMITS, concurrency: 1, batch: 1000 }, all.d);
    await runSearch(open, start, { ...LIMITS, concurrency: 1, batch: 2 }, batched.d);

    expect(batched.calls.length).toBeLessThan(all.calls.length);
  });

  it('begins each round after the move the last round took, so that the moves that did not help are not asked first again and again', async () => {
    const { figuresOf } = oracle(posts, base);
    const start = figuresOf(open, new Map(), [9]);
    const rounds: string[][] = [];
    let seen = 0;
    const { d } = deps({
      evaluate: async (leads, years) => {
        const key = [...leads].sort().map(([post, to]) => `${post}>${to}`).join('+');
        if (seen === 0) rounds.push([]);
        rounds.at(-1)!.push(key);
        seen += 1;
        return { kind: 'FIGURES', figures: figuresOf(open, leads, years) };
      },
      accepted: () => {
        seen = 0;
      },
    });

    await runSearch(open, start, { ...LIMITS, concurrency: 1, batch: 3 }, d);

    expect(rounds.length).toBeGreaterThan(1);
    // The first round begins with the first move of the list; the second does not begin with it again.
    const first = rounds[0]![0]!;
    expect(rounds[1]![0]).not.toBe(first);
  });

  it('puts the moves in order by key, and goes round from the one after the last taken', () => {
    const move = (post: string, to: string) => ({ changes: [{ requirementId: post, toTeacherId: to }], years: [9] });
    const moves = [move('p3', 'B'), move('p1', 'B'), move('p2', 'C'), move('p2', 'B')];

    expect(inRoundOrder(moves, null).map(moveKey)).toEqual(['p1>B', 'p2>B', 'p2>C', 'p3>B']);
    expect(inRoundOrder(moves, 'p2>B').map(moveKey)).toEqual(['p2>C', 'p3>B', 'p1>B', 'p2>B']);
    // After the last of them it goes round to the first, and a key not in the list is found by where it would be.
    expect(inRoundOrder(moves, 'p3>B').map(moveKey)).toEqual(['p1>B', 'p2>B', 'p2>C', 'p3>B']);
    expect(inRoundOrder(moves, 'p2>BB').map(moveKey)).toEqual(['p2>C', 'p3>B', 'p1>B', 'p2>B']);
  });

  it('asks only the years a move touches, and each candidate state once', async () => {
    const { figuresOf } = oracle(posts, base);
    const { d, calls } = deps();

    await runSearch(open, figuresOf(open, new Map(), [9]), LIMITS, d);

    expect(calls.every((call) => call.years.length === 1 && call.years[0] === 9)).toBe(true);
    const seen = calls.map((call) => [...call.leads].sort().join(';'));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('does not take a move that eases year 9 by making year 8 worse than it began', async () => {
    // p1 spans years 8 and 9. B already carries year 8 posts, so giving B the post helps 9 and hurts 8.
    const wide = model(
      [row('p1', 'A', ['A', 'B'], [8, 9]), row('p2', 'A', ['A', 'B'], [9]), row('q1', 'B', ['A', 'B'], [8])],
      { A: { current: 0, limit: 100000 }, B: { current: 0, limit: 100000 } },
    );
    const spec = {
      p1: { minutes: 300, weeks: ['a'], years: [8, 9] },
      p2: { minutes: 300, weeks: ['a'], years: [9] },
      q1: { minutes: 300, weeks: ['a'], years: [8] },
    };
    const { figuresOf } = oracle(spec, { a: 500 });
    const start = figuresOf(wide, new Map(), [8, 9]);
    const d: SearchDeps = {
      evaluate: async (leads, years) => ({ kind: 'FIGURES', figures: figuresOf(wide, leads, years) }),
      stopped: () => null,
    };

    const outcome = await runSearch(wide, start, LIMITS, d);

    // Year 9: A carries p1 and p2 (1100). Moving p2 to B eases it and touches nothing of year 8: taken.
    // Moving p1 to B would make year 8 worse (B would carry q1 and p1): never taken.
    expect(outcome.leads.get('p1')).toBeUndefined();
    expect(tightestOf(outcome.figures.get(8)!).demand).toBeLessThanOrEqual(tightestOf(start.get(8)!).demand);
    expect(tightestOf(outcome.figures.get(9)!).demand).toBeLessThan(tightestOf(start.get(9)!).demand);
    expect(outcome.leads.get('p2')).toBe('B');
    expect(outcome.tally.worse).toBeGreaterThan(0);
  });

  it('finds a swap when room is all that stops a move', async () => {
    // Two posts each at A and at B, equal charge, and both teachers at their limit: only a swap changes anything.
    const full = model(
      [row('p1', 'A', ['A', 'B']), row('p2', 'A', ['A', 'B']), row('q1', 'B', ['A', 'B']), row('q2', 'B', ['A', 'B'])],
      { A: { current: 200, limit: 200 }, B: { current: 200, limit: 200 } },
    );
    const spec = {
      p1: { minutes: 300, weeks: ['a'] },
      p2: { minutes: 300, weeks: ['b'] },
      q1: { minutes: 300, weeks: ['a'] },
      q2: { minutes: 300, weeks: ['b'] },
    };
    const { figuresOf } = oracle(spec, { a: 500, b: 500 });
    // A leads a and b (600 in each: p1 in a, p2 in b: 300 each) - make A busier in a, B busier in b so that a swap eases both.
    const start = figuresOf(full, new Map(), [9]);
    const moves = movesOf(full, new Map(), new Set([9]));

    expect(moves.every((move) => move.changes.length === 2)).toBe(true);
    expect(moves.length).toBeGreaterThan(0);
    // The swap keeps both teachers where they were in charge.
    const state = afterMove(full, new Map(), moves[0]!);
    expect(Object.fromEntries(tenthsIn(full, state))).toEqual({ A: 200, B: 200 });
    expect(start.get(9)!.size).toBe(2);
  });
});
