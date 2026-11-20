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
  | 'LOCAL_OPTIMUM' // no single move or swap eases the weeks any further
  | 'NO_MOVES' // no released post has a teacher to move to
  | 'CANCELLED' // the school stopped it
  | 'BUDGET' // the time it was given ran out
  | 'MAX_ROUNDS'
  | 'MAX_EVALUATIONS'
  | 'ENGINE_OLDER' // the engine has no such route yet
  | 'ENGINE_FAILING'; // the engine failed several evaluations in a row

/** One week's figure, in minutes of the week's own supply. */
export interface StaffingSearchWeek {
  /** The first day of the period the week is in, as a refusal names it, when the year has periods; null otherwise. */
  period: number | null;
  parity: 'ODD_WEEKS' | 'EVEN_WEEKS' | null;
  demandMinutes: number;
  capacityMinutes: number;
}

/** A judged year's figures: its tightest week and every week. In the school's numbering (the proposal's own). */
export interface StaffingSearchYear {
  year: number;
  /** As the search began (the week as it stands), and as it ended (the best it found). */
  before: StaffingSearchWeek[];
  after: StaffingSearchWeek[];
}

export interface StaffingSearchFigures {
  years: StaffingSearchYear[];
  /** The years a released post could have moved in that the search did not judge (past the cap), so those posts were left. */
  skippedPosts: number;
  /** Posts that were not searched because nobody but their lead may take them. */
  immovablePosts: number;
}
