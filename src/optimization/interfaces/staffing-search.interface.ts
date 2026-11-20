/*
 * LÄRARVAL F3: the wire shapes of POST /api/v1/week-bounds (the engine's answer), which src/optimization/ai-engine-contract.spec.ts
 * lists by hand beside optimization-engine/tests/test_week_bounds.py, and what the gateway's own routes answer.
 */

/** One year's least week in one real week, as the engine counts it to the end (week_load.Exactness). */
export interface AiEngineWeekBoundsRow {
  /** In the payload's numbering (NIOARIG); null for entries whose years are unknown. */
  year: number | null;
  /** The period the week is in, counted from 0; null for a year without periods. */
  period: number | null;
  /** The parity the week is of, null when it is of both (and for a school without alternating weeks). */
  parity: 'ODD_WEEKS' | 'EVEN_WEEKS' | null;
  /** The proved lower bound in minutes, rounded up; exact when `converged`. */
  demandMinutes: number;
  capacityMinutes: number;
  over: boolean;
  /** Every pricing step was proved and nothing stopped the count: `demandMinutes` is the value itself. */
  converged: boolean;
  /** Stopped because the bound passed the cutoff it was given: only "above the cutoff". */
  cutoff: boolean;
}

export interface AiEngineWeekBoundsResponse {
  requestId: string;
  weeksTotal: number;
  weeksCounted: number;
  rows: AiEngineWeekBoundsRow[];
  /** A quick count that refuses the week: no figures then. */
  refusal: { code: string; params: Record<string, string | number> } | null;
  deadlineHit: boolean;
  elapsedMs: number;
}

/** What the engine is asked besides Generera's payload. */
export interface AiEngineWeekBoundsExtra {
  years?: number[];
  cutoffs?: { year: number; demandMinutes: number; capacityMinutes: number }[];
  seconds?: number;
}

/** The names of the response and of a row, by hand: a field renamed on one side only is a missing key on the other. */
export const WEEK_BOUNDS_RESPONSE_KEYS = ['requestId', 'weeksTotal', 'weeksCounted', 'rows', 'refusal', 'deadlineHit', 'elapsedMs'] as const;
export const WEEK_BOUNDS_ROW_KEYS = ['year', 'period', 'parity', 'demandMinutes', 'capacityMinutes', 'over', 'converged', 'cutoff'] as const;
export const WEEK_BOUNDS_EXTRA_KEYS = ['years', 'cutoffs', 'seconds'] as const;

// ---------------------------------------------------------------------------
// What the gateway answers the dialog

export type StaffingSearchStatus = 'PENDING' | 'RUNNING' | 'CANCELLING' | 'SUCCEEDED' | 'CANCELLED' | 'FAILED';

/** Why a search stopped, in the order the search checks them. */
export type StaffingSearchStop =
  | 'NOT_TIGHT' // every year it judged is under the engine's tight threshold: nothing is left to win
  | 'LOCAL_OPTIMUM' // no single move or swap eases the weeks any further, and every one of them was counted to the end
  | 'NOT_ALL_COUNTED' // no counted move or swap eases the weeks, but some could not be counted to the end (the seconds, a pricing not proved, the engine failing): not shown to be a local optimum
  | 'NO_MOVES' // no released post has a teacher to move to
  | 'CANCELLED' // the school stopped it
  | 'BUDGET' // the time it was given ran out
  | 'MAX_ROUNDS'
  | 'MAX_EVALUATIONS'
  | 'ENGINE_OLDER' // the engine has no such route yet
  | 'ENGINE_BUSY' // the engine was too busy to take a count for too long (the school's own wait is not counted in the budget)
  | 'ENGINE_FAILING'; // the engine failed several evaluations in a row

// ---------------------------------------------------------------------------
// The run and its proposal, as the dialog reads them

/** One real week's figure in a judged year, before the search and as far as it has come. */
export interface StaffingSearchWeekFigure {
  /** Index of the period, null for a year without periods. */
  period: number | null;
  parity: 'ODD_WEEKS' | 'EVEN_WEEKS' | null;
  /** The week's first stretch of days, as a refusal names its period; null when the year has no periods. */
  from: string | null;
  to: string | null;
  before: { demandMinutes: number; capacityMinutes: number };
  after: { demandMinutes: number; capacityMinutes: number };
}

export interface StaffingSearchYearFigures {
  /** In the payload's numbering (NIOARIG): the view turns it into the school's. */
  year: number;
  weeks: StaffingSearchWeekFigure[];
}

/**
 * WHAT THE SEARCH DID NOT MOVE, AND WHY. Nothing it leaves out is left out in silence: a post is counted under the one reason
 * that kept it from being searched, and a year a post with a choice spans that was not judged is named, with its reason.
 */
export type StaffingSearchLeftOutPostReason =
  | 'NOT_FREE' // not released for the engine, or pinned in the dialog: it keeps its lead
  | 'UNSTAFFED' // nobody leads it: Föreslå bemanning's question, not this search's
  | 'NO_CHOICE' // nobody else may lead it by the plan's rules (behörighet, tjänstgrad, medlärare, excluded)
  | 'NOT_IN_WEEK' // the week carries none of its lessons (all hand-placed), or its years are not known: nothing in the week can change by it
  | 'YEAR_LIMIT' // a year it spans is not among the (at most four) tightest, which are the years judged
  | 'YEAR_NOT_COUNTED'; // a year it spans could not be counted to the end as it stands, so "no tighter than today" cannot be decided there

export type StaffingSearchLeftOutYearReason = 'YEAR_LIMIT' | 'YEAR_NOT_COUNTED';

export interface StaffingSearchLeftOut {
  /** Only the reasons that have posts, in the order of the type above. */
  posts: { reason: StaffingSearchLeftOutPostReason; count: number }[];
  /** The years a post with a choice spans that were not judged, ascending, in the payload's numbering (NIOARIG): the view turns it into the school's. */
  years: { year: number; reason: StaffingSearchLeftOutYearReason }[];
}

/** What the run stores of its figures, and what a poll gives back: only minutes, week keys and counts. */
export interface StaffingSearchFiguresDoc {
  years: StaffingSearchYearFigures[];
  leftOut: StaffingSearchLeftOut;
}

export interface StaffingSearchTally {
  better: number;
  notBetter: number;
  worse: number;
  refused: number;
  /** Evaluations the engine could not count to the end, which rank nothing. */
  unranked: number;
}

export interface StaffingSearchCheckpoint {
  changes: { requirementId: string; fromTeacherId: string; toTeacherId: string }[];
  tally: StaffingSearchTally;
}

/** The run as a poll reads it (no proposal: that is its own route, read once when the run has ended). */
export interface StaffingSearchView {
  id: string;
  academicYearId: string;
  status: StaffingSearchStatus;
  stopReason: StaffingSearchStop | null;
  /** The search's own time budget in milliseconds, and how much of it has been used (waiting for a Generera run is not counted). */
  budgetMs: number;
  elapsedMs: number;
  round: number;
  evaluations: number;
  acceptedMoves: number;
  figures: StaffingSearchFiguresDoc | null;
  tally: StaffingSearchTally | null;
  /** A failed run's code (SEARCH_ABANDONED, SEARCH_INTERRUPTED, ...), its values and its English. */
  errorCode: string | null;
  errorParams: Record<string, string | number> | null;
  error: string | null;
  /** Whether a proposal can be read: at least one move was accepted and the run has ended. */
  hasProposal: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
