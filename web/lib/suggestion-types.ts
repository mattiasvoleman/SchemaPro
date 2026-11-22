/*
 * ÅTGÄRDSFÖRSLAG VID VÄGRAN (omgång 13, G6): what the gateway sends of the analysis of a run that ended without a timetable
 * (src/optimization/suggestions.ts, OptimizationJobView.suggestions). Types only, mirrored by hand: the gateway builds the value
 * through a whitelist and this file only says what it holds. A cap's teacher arrives as a NAME (the Users id never leaves the
 * server), and a part-timer's days arrive in their hidden form for every reader: the rule, the price and the proof, nothing else.
 */

/** The five rules that may give way (the engine's relaxation.py), mildest first. */
export type SuggestionRule = "SUBJECT_DAYS_APART" | "SUBJECT_PER_DAY" | "ROOM_LOCK" | "TEACHER_DAILY_CAP" | "TEACHER_WORK_DAYS";

/**
 * What the engine has shown of a change. SOLVED: it solved the week with exactly this one change. SOLVED_TOGETHER: with exactly the
 * changes of the list, together; one of them alone is NOT shown to be enough. MAY_HELP: a timetable exists that breaks the rule this
 * much, but the check against the strict model did not finish.
 */
export type SuggestionProof = "SOLVED" | "SOLVED_TOGETHER" | "MAY_HELP";

/** CHANGES; SOLVABLE_AS_IS (the week was laid with nothing giving way: said only with `verified`); NOT_FOUND (no timetable in the time: not a proof that none exists); HARD_REFUSAL (a rule that never gives way refuses). */
export type SuggestionVerdict = "CHANGES" | "SOLVABLE_AS_IS" | "NOT_FOUND" | "HARD_REFUSAL";

export type SuggestionsFailure = "ENGINE_LACKS_SUGGESTIONS" | "ENGINE_BUSY" | "ENGINE_FAILED" | "NOTHING_TO_PLACE" | "ABANDONED";

export interface SuggestionChange {
  rule: SuggestionRule;
  proof: SuggestionProof;
  /** The engine's own price; only compares within one answer. */
  cost: number;
  current: number | null;
  needed: number | null;
  /** ISO weekdays 1 to 7. */
  weekdays: number[];
  requirementIds: string[];
  requirementNames: string[];
  roomIds: string[];
  roomNames: string[];
  /** The rows the change is about, in real ids: a work rule, or the room rules of a lock. Never a post. */
  resourceIds: string[];
  /** The teacher a cap is about, named by whom this reader may see: empty for a protected identity. */
  teacherNames: string[];
  /** A part-timer's days: nothing but the rule, the price and the proof. */
  hidden: boolean;
}

export interface Suggestions {
  version: 1;
  state: "RUNNING" | "DONE" | "FAILED";
  startedAt: string;
  finishedAt: string | null;
  verdict: SuggestionVerdict | null;
  /** The strict model accepted the engine's timetable with every change of the list applied. */
  verified: boolean;
  /** How many changes the engine's list had; `changes` holds the first of them (at most six). */
  total: number;
  searchSeconds: number | null;
  verifySeconds: number | null;
  changes: SuggestionChange[];
  failure: SuggestionsFailure | null;
}
