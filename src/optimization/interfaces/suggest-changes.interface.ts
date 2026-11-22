import type { AiEngineConflictAnalysis } from './ai-engine-payload.interface';

/*
 * ÅTGÄRDSFÖRSLAG VID VÄGRAN: the engine's answer to POST /api/v1/suggest-changes
 * (optimization-engine/app/schemas/suggestions.py). Mirrored by hand there and in
 * ai-engine-contract.spec.ts; the engine's models forbid extra fields, so a name
 * changed on one side only is a missing key here.
 */

/** The five rules that may give way (optimization-engine/app/solver/relaxation.py RELAXABLE_RULES), mildest first. */
export const SUGGESTION_RULES = [
  'SUBJECT_DAYS_APART',
  'SUBJECT_PER_DAY',
  'ROOM_LOCK',
  'TEACHER_DAILY_CAP',
  'TEACHER_WORK_DAYS',
] as const;
export type SuggestionRule = (typeof SUGGESTION_RULES)[number];

/**
 * What the engine has shown of a change. `SOLVED`: it solved the week with exactly this one change. `SOLVED_TOGETHER`: with exactly the
 * changes of the list, together; one of them alone is NOT shown to be enough. `MAY_HELP`: a timetable exists that breaks the rule this
 * much, but the check against the strict model did not finish.
 */
export const SUGGESTION_PROOFS = ['SOLVED', 'SOLVED_TOGETHER', 'MAY_HELP'] as const;
export type SuggestionProof = (typeof SUGGESTION_PROOFS)[number];

/**
 * `CHANGES`: the search laid the week by letting the rules of `changes` give way. `SOLVABLE_AS_IS`: it laid it and nothing gave way
 * (trust it only with `verified`). `NOT_FOUND`: no timetable in the search's time even with the five rules free: NOT a proof that none
 * exists. `HARD_REFUSAL`: a rule that never gives way refuses the week; no change of the five can help.
 */
export const SUGGEST_VERDICTS = ['CHANGES', 'SOLVABLE_AS_IS', 'NOT_FOUND', 'HARD_REFUSAL'] as const;
export type SuggestVerdict = (typeof SUGGEST_VERDICTS)[number];

export interface AiEngineSuggestedChange {
  rule: SuggestionRule;
  /** The engine's own price: the weight of a unit times the units the change removes. */
  cost: number;
  current?: number | null;
  needed?: number | null;
  weekdays: number[];
  requirementIds: string[];
  roomIds: string[];
  resourceIds: string[];
  proof: SuggestionProof;
}

export interface AiEngineSuggestChangesResponse {
  requestId: string;
  verdict: SuggestVerdict;
  /** Ranked by the engine: the cheapest first. */
  changes: AiEngineSuggestedChange[];
  verified: boolean;
  searchSeconds: number;
  verifySeconds?: number | null;
  elapsedMs: number;
  /** The strict explanation, for HARD_REFUSAL only. */
  conflicts?: AiEngineConflictAnalysis | null;
}
