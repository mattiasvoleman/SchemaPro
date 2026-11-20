import type {
  AiEngineWeekBoundsResponse,
  StaffingSearchLeftOut,
  StaffingSearchLeftOutPostReason,
  StaffingSearchStop,
} from './interfaces/staffing-search.interface';
import { leadRefusal, type Plan } from './staffing-proposal.service';

/*
 * LÄRARVAL F3: the pure half of the search for the choice of teachers that eases the week.
 *
 * WHAT IS SEARCHED. The posts the school has released (planOf: staffed by the school, released, not pinned) are
 * re-led, one post or two at a time, and each candidate state is counted by the engine (POST /api/v1/week-bounds:
 * every real week of the year, each year's exact least week). A candidate is kept only if it is a proven improvement:
 * the weeks of the years it touches are all EXACT (no deadline, no unproved pricing, every week counted, no quick
 * count refusing), no year's tightest week is worse than it was when the search began, and the weeks as a whole
 * (leximax: the tightest first, then the next) are lower than before. Anything the engine could not count to the end
 * ranks nobody.
 *
 * WHY THE RULES ARE HERE AND NOT THE ENGINE'S. Who may lead what (behörighet, tjänstgrad, the post's co-teacher and
 * shares, pinned and unreleased posts) is the plan's (staffing-proposal.service.ts planOf), the one rule-book Föreslå
 * bemanning is already judged by, so a move is generated from the plan and the result is judged by the plan's own
 * leadRefusal/growthRefusal again. The engine counts weeks; it never learns who a teacher is.
 *
 * WHAT IT CANNOT SAY (the PR and the dialog say it): the week it counts is each year's own, a lower bound, with a
 * teacher's lessons in other years invisible to it. An eased bound is not a timetable.
 */

/** The engine's tight threshold, as a share: a year at or under it has nothing to win (week-check-choice.ts TIGHT_PERCENT). */
const TIGHT_SHARE_PERCENT = 85;

// ---------------------------------------------------------------------------
// Figures

/** One year's least week in one real week, in the minutes of that week's own supply. */
export interface WeekCell {
  demand: number;
  capacity: number;
}

/** A year's weeks by the week's key (weekKey). */
export type YearFigures = ReadonlyMap<string, WeekCell>;
/** The judged years' weeks. */
export type Figures = ReadonlyMap<number, YearFigures>;

/** The key of a real week within a year: its period and, when it is of one parity, which. */
export function weekKey(period: number | null, parity: 'ODD_WEEKS' | 'EVEN_WEEKS' | null): string {
  return `${period ?? 'x'}:${parity ?? 'x'}`;
}

/** The sign of a - b as shares of the weeks' supplies, exactly (integers, so nothing is rounded). */
export function compareCells(a: WeekCell, b: WeekCell): number {
  return a.demand * b.capacity - b.demand * a.capacity;
}

/** A year's tightest week: the largest share of its supply. */
export function tightestOf(year: YearFigures): WeekCell {
  let best: WeekCell | null = null;
  for (const cell of year.values()) if (best === null || compareCells(cell, best) > 0) best = cell;
  return best ?? { demand: 0, capacity: 1 };
}

/**
 * The weeks of every judged year as one list, the largest share first: the order the search lowers things in. The tightest
 * week of the tightest year first, then the next tightest week of any year, and so on, so that a choice that eases the
 * second tightest week while the tightest stays is an improvement too, and one that raises any week above one it had is not
 * hidden by one that falls.
 */
export function vectorOf(figures: Figures): WeekCell[] {
  const cells: WeekCell[] = [];
  for (const year of figures.values()) cells.push(...year.values());
  return cells.sort((a, b) => compareCells(b, a));
}

/** Lexicographic order of two such lists (<0: `a` is lower). Lists of one length, as a search compares states of one set of weeks. */
export function compareVectors(a: readonly WeekCell[], b: readonly WeekCell[]): number {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const difference = compareCells(left, right);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

/** Whether every judged year's tightest week is at or under the engine's tight threshold. */
export function isNotTight(figures: Figures): boolean {
  for (const year of figures.values()) {
    const tightest = tightestOf(year);
    if (tightest.demand * 100 > TIGHT_SHARE_PERCENT * tightest.capacity) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// What the engine said, read

export type UnrankedReason =
  | 'DEADLINE' // the seconds ran out before every week was counted
  | 'NOT_EXACT' // a pricing step was not proved: the figure is a lower bound that looks exact
  | 'FEWER_WEEKS' // the engine counted fewer weeks than the year has
  | 'MISSING_YEAR' // a year asked for has no figure
  | 'INCONSISTENT' // the weeks counted are not the weeks of the state it is compared with
  | 'ENGINE_ERROR'
  | 'ENGINE_OLDER'
  /** The engine's gate stayed busy (429, or 503 that went on) for as long as the search waits in all: nothing was counted. */
  | 'ENGINE_BUSY';

/** What an evaluation of one candidate came to. Only FIGURES has figures to rank by. */
export type Evaluation =
  | { kind: 'FIGURES'; figures: Figures }
  /** Proved above the guard: some week of `year` is above the share of its supply the year's tightest week had when the search began. */
  | { kind: 'WORSE'; year: number }
  /** A quick count refuses the week (a teacher with more lessons than their days hold, a class over its hours). */
  | { kind: 'REFUSED'; code: string }
  | { kind: 'UNRANKED'; reason: UnrankedReason };

/**
 * One answer of the engine, as an evaluation of the years that were asked. In this order:
 *
 *  - a quick count refuses the week: REFUSED (no figures);
 *  - a figure the cutoff stopped: WORSE. It is a PROVED lower bound above the guard, whatever else the answer lacks;
 *  - fewer weeks counted than the year has, the seconds out, a pricing step not proved, a year without a figure: UNRANKED.
 *    These are the figures that look like values and are not, and a figure that is not a value ranks nobody
 *    (the over-supply figure of /check-week is the first refused period's, a deadline's is a bound at the deadline).
 *  - otherwise every figure is exact: FIGURES.
 */
export function readEvaluation(answer: AiEngineWeekBoundsResponse, asked: readonly number[]): Evaluation {
  if (answer.refusal !== null) return { kind: 'REFUSED', code: answer.refusal.code };
  const wanted = new Set(asked);
  const rows = answer.rows.filter((row) => row.year !== null && wanted.has(row.year));
  const cut = rows.find((row) => row.cutoff);
  if (cut) return { kind: 'WORSE', year: cut.year! };
  if (answer.weeksCounted < answer.weeksTotal) return { kind: 'UNRANKED', reason: 'FEWER_WEEKS' };
  if (answer.deadlineHit) return { kind: 'UNRANKED', reason: 'DEADLINE' };
  if (rows.some((row) => !row.converged)) return { kind: 'UNRANKED', reason: 'NOT_EXACT' };
  const figures = new Map<number, Map<string, WeekCell>>();
  for (const row of rows) {
    const year = figures.get(row.year!) ?? new Map<string, WeekCell>();
    year.set(weekKey(row.period, row.parity), { demand: row.demandMinutes, capacity: row.capacityMinutes });
    figures.set(row.year!, year);
  }
  for (const year of asked) if (!figures.has(year)) return { kind: 'UNRANKED', reason: 'MISSING_YEAR' };
  return { kind: 'FIGURES', figures };
}

/** The cutoffs a candidate is asked with: each judged year's tightest week as the search began (the guard). */
export function cutoffsOf(start: Figures, years: readonly number[]): { year: number; demandMinutes: number; capacityMinutes: number }[] {
  return years.map((year) => {
    const tightest = tightestOf(start.get(year) ?? new Map());
    return { year, demandMinutes: tightest.demand, capacityMinutes: Math.max(1, tightest.capacity) };
  });
}

// ---------------------------------------------------------------------------
// The acceptance rule

export type Judgement =
  /** A proven improvement: the figures of the whole state, the candidate's years in place of the current ones. */
  | { kind: 'BETTER'; figures: Figures }
  | { kind: 'NOT_BETTER' }
  | { kind: 'WORSE'; year: number }
  | { kind: 'REFUSED'; code: string }
  | { kind: 'UNRANKED'; reason: UnrankedReason };

/**
 * Whether a candidate is kept. `candidate` holds the years it touches (they are the only ones the engine counted: a year's
 * week is built from that year's posts alone, so a move cannot change another's); `current` is the state it was made from
 * and `start` the state the search began in, whose tightest week per year is the guard.
 *
 *  1. only a count the engine finished ranks anything (readEvaluation);
 *  2. NO YEAR'S TIGHTEST WEEK IS WORSE THAN IT WAS WHEN THE SEARCH BEGAN. An improvement in one year does not pay for a
 *     worse week in another, however much it helps: that is the school's own year being made harder;
 *  3. the weeks as a whole must be lower than the current state's, tightest first (compareVectors).
 */
export function judge(evaluation: Evaluation, current: Figures, start: Figures): Judgement {
  if (evaluation.kind !== 'FIGURES') return evaluation;
  const merged = new Map(current);
  for (const [year, weeks] of evaluation.figures) {
    const was = current.get(year);
    const began = start.get(year);
    if (!was || !began) return { kind: 'UNRANKED', reason: 'INCONSISTENT' };
    // The same weeks as the state it is set against: a week that has appeared or gone is not a comparison.
    if (weeks.size !== was.size || [...weeks.keys()].some((key) => !was.has(key))) {
      return { kind: 'UNRANKED', reason: 'INCONSISTENT' };
    }
    if (compareCells(tightestOf(weeks), tightestOf(began)) > 0) return { kind: 'WORSE', year };
    merged.set(year, weeks);
  }
  return compareVectors(vectorOf(merged), vectorOf(current)) < 0
    ? { kind: 'BETTER', figures: merged }
    : { kind: 'NOT_BETTER' };
}

// ---------------------------------------------------------------------------
// The model: what may be moved, and to whom

/** A post a search may re-lead. */
export interface SearchRow {
  requirementId: string;
  /** The lead it has today (a real teacher id). */
  leadId: string;
  /** Everybody who may lead it by the plan's rules (leadRefusal), the lead it has today included, sorted. */
  options: readonly string[];
  /** What the post charges its lead, in tenths of a minute (the plan's own). */
  chargeTenths: number;
  /** The years its group spans, in the payload's numbering. */
  years: readonly number[];
}

/** A teacher's room, as the plan counts it. */
export interface SearchTeacher {
  /** What they lead today: their fixed posts and the free posts they keep, in tenths. */
  currentTenths: number;
  /** The most they may lead (limitTenthsOf their target), null when their room is unknown. */
  limitTenths: number | null;
}

export interface SearchModel {
  rows: readonly SearchRow[];
  teachers: ReadonlyMap<string, SearchTeacher>;
}

/** The posts of the plan a search does not look at, and why (the dialog and the proposal say each of them: nothing is left out in silence). */
export interface ExcludedPosts {
  /** Not free: not released for the engine, or pinned in the dialog. They keep their lead. */
  notFree: number;
  /** Free but nobody leads them: Föreslå bemannings question. */
  unstaffed: number;
  /** Released and staffed, with nobody else the plan lets lead them. */
  noChoice: number;
  /** Released and staffed, but the week carries none of their lessons or their years are not known: nothing in the week can change by them. */
  notInWeek: number;
}

/**
 * The model a plan gives: the released posts that have somebody else they may be given to, and every teacher's room. A post
 * the payload does not carry (every lesson of it hand-placed) is not searched, since nothing in the week can change by it;
 * a post whose years are unknown is not either, because a year it may change cannot be judged. `excluded` says how many
 * posts the plan holds that are left out, by the reason (ExcludedPosts).
 */
export function searchModelOf(
  plan: Plan,
  yearsOf: (requirementId: string) => readonly number[] | null,
): { model: SearchModel; excluded: ExcludedPosts } {
  const rows: SearchRow[] = [];
  const excluded: ExcludedPosts = { notFree: 0, unstaffed: 0, noChoice: 0, notInWeek: 0 };
  for (const planned of plan.rows) {
    if (planned.kind === 'FIXED') {
      excluded.notFree += 1;
      continue;
    }
    if (planned.kind === 'OPEN' || planned.current === null) {
      excluded.unstaffed += 1;
      continue;
    }
    const years = yearsOf(planned.row.id);
    if (years === null || years.length === 0) {
      excluded.notInWeek += 1;
      continue;
    }
    const options = plan.teachers
      .map((teacher) => teacher.userId)
      .filter((userId) => leadRefusal(plan, planned, userId) === null);
    if (options.length < 2) {
      excluded.noChoice += 1;
      continue;
    }
    rows.push({
      requirementId: planned.row.id,
      leadId: planned.current,
      options: [...options].sort(),
      chargeTenths: planned.chargeTenths,
      years: [...years].sort((a, b) => a - b),
    });
  }
  rows.sort((a, b) => (a.requirementId < b.requirementId ? -1 : a.requirementId > b.requirementId ? 1 : 0));
  const teachers = new Map<string, SearchTeacher>(
    plan.teachers.map((teacher) => [teacher.userId, { currentTenths: teacher.currentTenths, limitTenths: teacher.limitTenths }]),
  );
  return { model: { rows, teachers }, excluded };
}

/** A post's lead in a state: the one a move gave it, else the one it has today. */
function leadIn(row: SearchRow, leads: ReadonlyMap<string, string>): string {
  return leads.get(row.requirementId) ?? row.leadId;
}

/** What each teacher leads in a state, in tenths: today's room, less what they gave up and plus what they were given. */
export function tenthsIn(model: SearchModel, leads: ReadonlyMap<string, string>): Map<string, number> {
  const tenths = new Map<string, number>([...model.teachers].map(([userId, teacher]) => [userId, teacher.currentTenths]));
  for (const row of model.rows) {
    const lead = leadIn(row, leads);
    if (lead === row.leadId) continue;
    tenths.set(row.leadId, (tenths.get(row.leadId) ?? 0) - row.chargeTenths);
    tenths.set(lead, (tenths.get(lead) ?? 0) + row.chargeTenths);
  }
  return tenths;
}

/** The posts of a model that every year they span is judged: the ones a search may move. */
export function movableRows(model: SearchModel, judged: ReadonlySet<number>): { rows: SearchRow[]; skipped: number } {
  const rows = model.rows.filter((row) => row.years.every((year) => judged.has(year)));
  return { rows: [...rows], skipped: model.rows.length - rows.length };
}

/** One step of a search: the post or two that change lead, in a state. */
export interface Move {
  changes: readonly { requirementId: string; toTeacherId: string }[];
  /** Every year the move can change: the years the moved posts span. */
  years: readonly number[];
}

/**
 * Every move from a state: one post to somebody else who may lead it and has room for it, and, where room is all that
 * stops a move, a SWAP: the receiver's own post (the one nearest in charge) comes back to the giver. Room is the plan's:
 * a teacher who only keeps or sheds is never a receiver (leadRefusal), the rest may lead up to their limit (limitTenths),
 * and a lead may always go back to the post they have today.
 *
 * In a stable order (posts by id, receivers by id), so that a search is the same every time and a test can say what it did.
 */
export function movesOf(
  model: SearchModel,
  leads: ReadonlyMap<string, string>,
  judged: ReadonlySet<number>,
): Move[] {
  const { rows } = movableRows(model, judged);
  const tenths = tenthsIn(model, leads);
  const room = (userId: string, extra: number, row: SearchRow): boolean => {
    if (userId === row.leadId) return true;
    const limit = model.teachers.get(userId)?.limitTenths ?? null;
    return limit !== null && (tenths.get(userId) ?? 0) + extra <= limit;
  };
  const yearsOf = (...posts: SearchRow[]): number[] => [...new Set(posts.flatMap((post) => post.years))].sort((a, b) => a - b);

  const moves: Move[] = [];
  const swapped = new Set<string>();
  for (const row of rows) {
    const lead = leadIn(row, leads);
    for (const to of row.options) {
      if (to === lead) continue;
      if (room(to, row.chargeTenths, row)) {
        moves.push({ changes: [{ requirementId: row.requirementId, toTeacherId: to }], years: yearsOf(row) });
        continue;
      }
      // Room is what stops it: the receiver gives a post back that the giver may lead and that brings both under their limits.
      let partner: SearchRow | null = null;
      for (const other of rows) {
        if (other === row || leadIn(other, leads) !== to || !other.options.includes(lead)) continue;
        const giverFits = room(lead, other.chargeTenths - row.chargeTenths, other) || lead === other.leadId;
        const receiverFits = (() => {
          const limit = model.teachers.get(to)?.limitTenths ?? null;
          return to === row.leadId || (limit !== null && (tenths.get(to) ?? 0) - other.chargeTenths + row.chargeTenths <= limit);
        })();
        if (!giverFits || !receiverFits) continue;
        const gap = Math.abs(other.chargeTenths - row.chargeTenths);
        const best = partner === null ? Number.POSITIVE_INFINITY : Math.abs(partner.chargeTenths - row.chargeTenths);
        if (gap < best) partner = other;
      }
      if (partner === null) continue;
      const key = [row.requirementId, partner.requirementId].sort().join('+');
      if (swapped.has(key)) continue;
      swapped.add(key);
      moves.push({
        changes: [
          { requirementId: row.requirementId, toTeacherId: to },
          { requirementId: partner.requirementId, toTeacherId: lead },
        ],
        years: yearsOf(row, partner),
      });
    }
  }
  return moves;
}

/** A move by what it does, so that moves can be put in order and found again after the state has changed. */
export function moveKey(move: Move): string {
  return move.changes.map((change) => `${change.requirementId}>${change.toTeacherId}`).join('+');
}

/**
 * The moves in the order a round asks them: by key, beginning after `after` (the move the last round took) and going round.
 * A round that asked the same first moves every time would ask the moves that did not help again and again (their state is
 * the one the last move changed, so nothing is remembered of them), and never reach the ones at the end of the list before
 * the budget was spent. Beginning after the last move taken spreads the evaluations over every move in turn, and a round
 * that finds nothing has still asked every one of them.
 */
export function inRoundOrder(moves: readonly Move[], after: string | null): Move[] {
  const sorted = [...moves].sort((a, b) => (moveKey(a) < moveKey(b) ? -1 : moveKey(a) > moveKey(b) ? 1 : 0));
  if (after === null) return sorted;
  const first = sorted.findIndex((move) => moveKey(move) > after);
  return first <= 0 ? sorted : [...sorted.slice(first), ...sorted.slice(0, first)];
}

/** The leads a state has after a move, never carrying a post that is back with the lead it started with. */
export function afterMove(
  model: SearchModel,
  leads: ReadonlyMap<string, string>,
  move: Move,
): Map<string, string> {
  const next = new Map(leads);
  const byId = new Map(model.rows.map((row) => [row.requirementId, row]));
  for (const change of move.changes) {
    const row = byId.get(change.requirementId)!;
    if (change.toTeacherId === row.leadId) next.delete(change.requirementId);
    else next.set(change.requirementId, change.toTeacherId);
  }
  return next;
}

/**
 * The years the search judges: the tightest `limit` of those a post with a choice spans. Of every year of the plan (counted
 * by the caller, each on its own) it keeps the ones with a movable post, heaviest first; a post whose years are not all
 * among them is left (movableRows). Only a year whose count finished is a candidate: one that did not has no figure to
 * guard and is not judged, so nothing in it is moved.
 */
export function judgedYearsOf(model: SearchModel, baseline: Figures, limit: number): number[] {
  const spanned = new Set(model.rows.flatMap((row) => row.years));
  return [...baseline.keys()]
    .filter((year) => spanned.has(year))
    .sort((a, b) => compareCells(tightestOf(baseline.get(b)!), tightestOf(baseline.get(a)!)) || a - b)
    .slice(0, Math.max(0, limit));
}

/**
 * WHAT THE SEARCH LEAVES, SAID. The posts the plan holds that it does not look at (`excluded`), the posts with a choice that it
 * does not move because a year they span is not judged, and those years, each with its reason:
 *
 *  - YEAR_NOT_COUNTED: the year has no exact figure as it stands (the count did not finish in the engine's seconds, or a pricing
 *    step was not proved), so "no tighter than today" cannot be decided there and it is not searched. The figure of today is
 *    never a bound or a first refused period's: week-bounds counts every week to the end and says per figure whether it is exact;
 *  - YEAR_LIMIT: the year has a figure but is not among the `judged` (the tightest MAX_JUDGED_YEARS).
 *
 * A post is counted under the first reason that applies (a year not counted before a year past the limit).
 */
export function leftOutOf(
  model: SearchModel,
  excluded: ExcludedPosts,
  baseline: Figures,
  judged: readonly number[],
): StaffingSearchLeftOut {
  const judgedSet = new Set(judged);
  const years = [...new Set(model.rows.flatMap((row) => row.years))]
    .filter((year) => !judgedSet.has(year))
    .sort((a, b) => a - b)
    .map((year) => ({ year, reason: (baseline.has(year) ? 'YEAR_LIMIT' : 'YEAR_NOT_COUNTED') as 'YEAR_LIMIT' | 'YEAR_NOT_COUNTED' }));
  const reasonOfYear = new Map(years.map(({ year, reason }) => [year, reason]));
  const counts: Record<StaffingSearchLeftOutPostReason, number> = {
    NOT_FREE: excluded.notFree,
    UNSTAFFED: excluded.unstaffed,
    NO_CHOICE: excluded.noChoice,
    NOT_IN_WEEK: excluded.notInWeek,
    YEAR_LIMIT: 0,
    YEAR_NOT_COUNTED: 0,
  };
  for (const row of model.rows) {
    const reasons = row.years.map((year) => reasonOfYear.get(year)).filter((reason) => reason !== undefined);
    if (reasons.length === 0) continue;
    counts[reasons.includes('YEAR_NOT_COUNTED') ? 'YEAR_NOT_COUNTED' : 'YEAR_LIMIT'] += 1;
  }
  const order: StaffingSearchLeftOutPostReason[] = ['NOT_FREE', 'UNSTAFFED', 'NO_CHOICE', 'NOT_IN_WEEK', 'YEAR_LIMIT', 'YEAR_NOT_COUNTED'];
  return {
    posts: order.filter((reason) => counts[reason] > 0).map((reason) => ({ reason, count: counts[reason] })),
    years,
  };
}

/**
 * THE TIME A SEARCH SPENDS WAITING FOR THE ENGINE, kept apart from the time it spends searching. A wait is made in slices, so that
 * a cancel is heard inside it (`stopped` is asked before each); the time waited is credited to the search (the budget does not run
 * while it waits). Several workers may wait at once: the first of them in line at the start of a slice is the one credited, so the time they wait together
 * is counted once and a search with more workers than one is not given more time by waiting in more places.
 */
export class WaitLedger {
  private readonly waiting = new Set<symbol>();
  private creditedMs = 0;

  /** The time waited so far, each moment counted once. */
  get credited(): number {
    return this.creditedMs;
  }

  async wait(ms: number, sliceMs: number, pause: (slice: number) => Promise<void>, stopped: () => boolean): Promise<void> {
    const me = Symbol('wait');
    this.waiting.add(me);
    try {
      for (let left = ms; left > 0 && !stopped(); left -= sliceMs) {
        const slice = Math.min(left, sliceMs);
        // First in line when the slice BEGINS: whoever waits beside an earlier waiter for a slice is not credited for it.
        const first = this.waiting.values().next().value === me;
        await pause(slice);
        if (first) this.creditedMs += slice;
      }
    } finally {
      this.waiting.delete(me);
    }
  }
}

// ---------------------------------------------------------------------------
// The search

export interface SearchLimits {
  /** Evaluations asked at once. */
  concurrency: number;
  maxRounds: number;
  maxEvaluations: number;
  /**
   * Moves evaluated before one is taken: the best improvement found among the first `batch` of a round is accepted and the
   * rest of the round is not asked. An exhaustive round (the steepest step) costs as many evaluations as there are moves
   * each time; a local optimum is only known after a round that finds no improvement in ALL of them, so the last round is
   * exhaustive either way. A batch of a few moves takes whatever helps first, in small steps (measured on the study's åk 9:
   * 19 moves and 800 evaluations for what a batch of 24 does in fewer).
   */
  batch: number;
}

/** What the search asks of the world around it. */
export interface SearchDeps {
  /** Count a candidate state: its leads (every post that differs from today) and the years it touches, asked with the guard as cutoffs. */
  evaluate(leads: ReadonlyMap<string, string>, years: readonly number[]): Promise<Evaluation>;
  /** Why the search must stop now (the school cancelled, the budget is out), else null. Asked between evaluations. */
  stopped(): StaffingSearchStop | null;
  /** A better state was accepted: the place to keep it, so that a search that is lost has its best so far. */
  accepted?(progress: SearchProgress): Promise<void> | void;
  /** Counters changed (an evaluation finished). */
  progress?(progress: SearchProgress): void;
}

export interface SearchTally {
  better: number;
  notBetter: number;
  worse: number;
  refused: number;
  unranked: Record<UnrankedReason, number>;
}

export interface SearchProgress {
  round: number;
  evaluations: number;
  accepted: number;
  /** The leads of every post that differs from today, in the best state so far. */
  leads: ReadonlyMap<string, string>;
  figures: Figures;
  tally: SearchTally;
}

export interface SearchOutcome extends SearchProgress {
  stop: StaffingSearchStop;
  start: Figures;
}

function emptyTally(): SearchTally {
  return {
    better: 0,
    notBetter: 0,
    worse: 0,
    refused: 0,
    unranked: {
      DEADLINE: 0,
      NOT_EXACT: 0,
      FEWER_WEEKS: 0,
      MISSING_YEAR: 0,
      INCONSISTENT: 0,
      ENGINE_ERROR: 0,
      ENGINE_OLDER: 0,
      ENGINE_BUSY: 0,
    },
  };
}

/** Failures in a row of the engine itself (not a figure that was not exact) after which the search gives up. */
const ENGINE_FAILURES_IN_A_ROW = 6;

/**
 * Steepest descent over single moves and swaps, with the acceptance rule above. `start` is the judged years' weeks in the
 * state the search begins in, every figure exact; the search never ends in a state worse than it for any year.
 *
 * The best state found so far is always a valid answer (every state the search accepts is a proven improvement on the one
 * before, never worse than the start in any year), so stopping at any moment gives something that may be shown; `stopped`
 * says when to.
 */
export async function runSearch(
  model: SearchModel,
  start: Figures,
  limits: SearchLimits,
  deps: SearchDeps,
): Promise<SearchOutcome> {
  const judged = new Set(start.keys());
  let leads: ReadonlyMap<string, string> = new Map();
  let figures: Figures = start;
  const tally = emptyTally();
  let round = 0;
  let evaluations = 0;
  let accepted = 0;
  let engineFailures = 0;
  const snapshot = (): SearchProgress => ({ round, evaluations, accepted, leads, figures, tally });
  const finish = (stop: StaffingSearchStop): SearchOutcome => ({ ...snapshot(), stop, start });
  const memo = new Map<string, Evaluation>();
  /** The move the last round took: the next round begins after it (inRoundOrder). */
  let resumeAfter: string | null = null;
  const keyOf = (state: ReadonlyMap<string, string>, years: readonly number[]): string =>
    `${years.join(',')}|${[...state].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([post, teacher]) => `${post}>${teacher}`).join(';')}`;

  while (true) {
    const early = deps.stopped();
    if (early !== null) return finish(early);
    if (isNotTight(figures)) return finish('NOT_TIGHT');
    if (round >= limits.maxRounds) return finish('MAX_ROUNDS');
    round += 1;

    const moves = inRoundOrder(movesOf(model, leads, judged), resumeAfter);
    if (moves.length === 0) return finish(accepted === 0 ? 'NO_MOVES' : 'LOCAL_OPTIMUM');

    // Held in objects: the workers below write them, and a `let` written in a closure is narrowed to its first value.
    const round_: { best: { index: number; figures: Figures; changes: number } | null; stop: StaffingSearchStop | null } = {
      best: null,
      stop: null,
    };
    let cursor = 0;

    // A batch at a time; the best improvement of the batches asked so far is taken once a batch has found one.
    while (cursor < moves.length && round_.stop === null) {
      const first = cursor;
      const batch = moves.slice(cursor, cursor + Math.max(1, limits.batch));
      cursor += batch.length;
      const results = new Array<Evaluation | null>(batch.length).fill(null);
      let next = 0;
      const worker = async (): Promise<void> => {
        while (round_.stop === null) {
          const index = next;
          next += 1;
          if (index >= batch.length) return;
          const early = deps.stopped();
          if (early !== null) {
            round_.stop = early;
            return;
          }
          if (evaluations >= limits.maxEvaluations) {
            round_.stop = 'MAX_EVALUATIONS';
            return;
          }
          const move = batch[index]!;
          const state = afterMove(model, leads, move);
          const key = keyOf(state, move.years);
          let evaluation = memo.get(key);
          if (evaluation === undefined) {
            evaluations += 1;
            try {
              evaluation = await deps.evaluate(state, move.years);
            } catch {
              evaluation = { kind: 'UNRANKED', reason: 'ENGINE_ERROR' };
            }
            if (evaluation.kind !== 'UNRANKED') memo.set(key, evaluation);
          }
          results[index] = evaluation;
          if (evaluation.kind === 'UNRANKED' && evaluation.reason === 'ENGINE_OLDER') {
            round_.stop = 'ENGINE_OLDER';
          } else if (evaluation.kind === 'UNRANKED' && evaluation.reason === 'ENGINE_BUSY') {
            // The wait for the engine is over (the service gave it up): the search ends with what it has.
            round_.stop = 'ENGINE_BUSY';
          } else if (evaluation.kind === 'UNRANKED' && evaluation.reason === 'ENGINE_ERROR') {
            engineFailures += 1;
            if (engineFailures >= ENGINE_FAILURES_IN_A_ROW) round_.stop = 'ENGINE_FAILING';
          } else {
            engineFailures = 0;
          }
          deps.progress?.(snapshot());
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, limits.concurrency) }, worker));

      for (let index = 0; index < batch.length; index += 1) {
        const evaluation = results[index];
        if (!evaluation) continue;
        const judgement = judge(evaluation, figures, start);
        if (judgement.kind === 'BETTER') {
          tally.better += 1;
          const candidate = { index: first + index, figures: judgement.figures, changes: batch[index]!.changes.length };
          const held = round_.best;
          const order = held === null ? -1 : compareVectors(vectorOf(candidate.figures), vectorOf(held.figures));
          if (held === null || order < 0 || (order === 0 && candidate.changes < held.changes)) round_.best = candidate;
        } else if (judgement.kind === 'NOT_BETTER') tally.notBetter += 1;
        else if (judgement.kind === 'WORSE') tally.worse += 1;
        else if (judgement.kind === 'REFUSED') tally.refused += 1;
        else tally.unranked[judgement.reason] += 1;
      }
      // A batch that found an improvement ends the round: the best of what has been asked is taken.
      if (round_.best !== null) break;
    }

    const taken = round_.best;
    if (taken !== null) {
      leads = afterMove(model, leads, moves[taken.index]!);
      resumeAfter = moveKey(moves[taken.index]!);
      figures = taken.figures;
      accepted += 1;
      await deps.accepted?.(snapshot());
      if (round_.stop !== null) return finish(round_.stop);
      continue;
    }
    if (round_.stop !== null) return finish(round_.stop);
    // Every move was asked and none improves: the state is a local optimum of single moves and swaps.
    return finish('LOCAL_OPTIMUM');
  }
}
