import type { AiEngineConflictAnalysis } from './ai-engine-payload.interface';
import type { ConflictView } from '../stored-conflicts';

/*
 * KONTROLLERA VECKAN: the engine's quick checks on a week, before any timetable
 * is searched for (optimization-engine/app/schemas/week_check.py). Mirrored by
 * hand there and in ai-engine-contract.spec.ts; the engine's models forbid
 * extra fields, so a name changed on one side only is a missing key here.
 */

/**
 * `IMPOSSIBLE`: a count or the year's week load PROVES no timetable exists
 * (the analysis is the one Generera would be answered INFEASIBLE with).
 * `TIGHT`: nothing is proved impossible, but a year needs at least 85 % of the
 * time its frames offer. `OK`: neither, which is NOT "a timetable exists".
 */
export type WeekCheckVerdict = 'OK' | 'TIGHT' | 'IMPOSSIBLE';
export const WEEK_CHECK_VERDICTS: readonly WeekCheckVerdict[] = ['OK', 'TIGHT', 'IMPOSSIBLE'];

/**
 * What the check did not run: the lunch stage always, the question whether the
 * förläggningar are why on an impossible week that carries some, a week load
 * whose seconds ran out; and, from the gateway, the engine itself when every
 * post is hand-placed.
 */
export type WeekCheckSkipped = 'LUNCH_STAGE' | 'PLACEMENTS_PROBE' | 'WEEK_LOAD_DEADLINE' | 'ENGINE';
export const WEEK_CHECK_SKIPPED: readonly WeekCheckSkipped[] = [
  'LUNCH_STAGE',
  'PLACEMENTS_PROBE',
  'WEEK_LOAD_DEADLINE',
  'ENGINE',
];

/** One year's least week against what its frames offer. */
export interface WeekCheckYear {
  /** The year, or null for the entries whose years are unknown. */
  year: number | null;
  demandMinutes: number;
  capacityMinutes: number;
  /** Whole percent, rounded down. */
  percent: number;
  /** Proved above the supply: no timetable exists. */
  over: boolean;
}

/** POST /api/v1/check-week, as the engine answers it. */
export interface AiEngineWeekCheckResponse {
  requestId: string;
  verdict: WeekCheckVerdict;
  years: WeekCheckYear[];
  conflicts?: AiEngineConflictAnalysis | null;
  skipped: string[];
  elapsedMs: number;
}

/**
 * The answer as the school's administrator is shown it: a whitelist, built
 * field by field. The sentences are the engine's catalogue's (`code` and
 * `params`), realised to the school's own names, and carry no id and nothing a
 * reader's HR-läs would decide (a post's days reach no view of this route).
 */
export interface WeekCheckView {
  verdict: WeekCheckVerdict;
  years: WeekCheckYear[];
  conflicts: {
    summary: string;
    summaryCode: string;
    summaryParams: Record<string, string | number>;
    conflicts: ConflictView[];
  } | null;
  skipped: WeekCheckSkipped[];
  elapsedMs: number;
  /** The gateway's own pre-flight answered (a post without a teacher), or the engine did. */
  checkedBy: 'ENGINE' | 'GATEWAY';
}
