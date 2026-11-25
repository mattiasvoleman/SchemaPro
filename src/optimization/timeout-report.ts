/*
 * WHERE A TIMED-OUT RUN'S TIME WENT (omgång 13, M2 Förklaringen när tiden tar slut).
 *
 * The engine answers a TIMEOUT with a `report` (optimization-engine/app/schemas/schedule.py,
 * TimeoutReport): the seconds of each step of the solve, what the search was given and had done, and
 * whether the week load was cut short. The gateway keeps it on the run (OptimizationJobs."report") and the
 * page reads it back.
 *
 * WHITELISTED ON THE WAY IN AND AGAIN ON THE WAY OUT. The engine's reply is read through a bare generic with
 * no runtime validation, and the column is a jsonb the page trusts, so every value is rebuilt here from the
 * closed set of names and the finite numbers it may hold, never spread from what arrived. A report that is not
 * wholly well formed is NOT shown in part: a half-read account of where the time went is worse than none, and
 * the page then says what a TIMEOUT has always said.
 *
 * A NAME THE GATEWAY DOES NOT KNOW IS NOT A MALFORMED REPORT. The engine deploys with every merge, ahead of the
 * gateway, and a step it adds (M8's YEARS and START, the second year of the design note's drivers) used to turn
 * every report into null until the gateway followed: the whole account gone for a name (g425, L-2). A step whose
 * name is well formed (a word in capitals) but not in TIMEOUT_STAGES is skipped, and the others are kept in
 * their order. The steps then add up to less than `totalSeconds`, by the skipped step's seconds, and the total
 * is still the engine's: the page says what it knows and does not say what it does not. A step that is not
 * an object, has no readable seconds or a name that is no word is still a malformed report.
 *
 * MEASURED, NEVER A RULE. Nothing here is a limit, and the figures are what the solve's own clock and CP-SAT
 * counted: `conflicts` and `branches` are effort and not progress, and a satisfaction search has no bound, so
 * none is carried. No id and no name is in it: the engine knows only anonymous ids, and none is read.
 */

/**
 * The steps of a solve the gateway has a sentence for, in the engine's order (TimeoutStageName). The engine may
 * have more: a step it names that is not here is skipped on the way in (see the head of this file), and
 * timeout-report.spec.ts holds this list to being the engine's, in its order, with nothing the engine has dropped.
 */
export const TIMEOUT_STAGES = ['PRECHECKS', 'BUILD', 'SITES', 'SEARCH_CLEAN', 'SEARCH_CLONE', 'PROBE'] as const;
export type TimeoutStage = (typeof TIMEOUT_STAGES)[number];

/** The satisfaction searches that report their effort (TimeoutPhaseName). */
export const TIMEOUT_PHASES = ['CLEAN', 'CLONE'] as const;
export type TimeoutPhase = (typeof TIMEOUT_PHASES)[number];

export interface TimeoutStageTime {
  stage: TimeoutStage;
  seconds: number;
}

export interface TimeoutSearchPhase {
  phase: TimeoutPhase;
  seconds: number;
  /** What CP-SAT counted; null when it had no response to read (the solve threw and the guard answered UNKNOWN). */
  conflicts: number | null;
  branches: number | null;
}

/** What a school's page reads of a run that ran out of time. */
export interface TimeoutReportView {
  /**
   * From the solver's entry (`solve()`, after the request is parsed and the thread has started) to the
   * answer, builds and the probe included. Not the route's entry: the wall time of the call can be a
   * few tenths longer, and more for a large body. The total and each step are rounded to a tenth on
   * their own, so the steps may not add up to it exactly (by up to 0.05 s a step).
   */
  totalSeconds: number;
  /** What the search was given, in whole seconds. */
  budgetSeconds: number;
  /** What the engine is set to search for a request of this kind: less than it was given only when the clock cut it. */
  configuredBudgetSeconds: number;
  /** How long the caller said it waits; null when it did not say. */
  callerWaitSeconds: number | null;
  stages: TimeoutStageTime[];
  search: {
    /** A TIMEOUT is the answer of a solve that found none. */
    solutions: number;
    phases: TimeoutSearchPhase[];
  };
  /** The year's week load stopped at its deadline: a year with no row among the conflicts was NOT counted. */
  weekLoadCut: boolean;
}

/** A day; no solve is longer, and a figure past it is a reader's mistake rather than a measurement. */
const MAX_SECONDS = 86_400;
const MAX_COUNT = 1_000_000_000_000;
const MAX_STAGES = 12;
const MAX_PHASES = 6;
/** What a step's name looks like: a word in capitals, as the engine's Literal writes them. */
const STEP_WORD = /^[A-Z][A-Z0-9_]{0,39}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A finite number of seconds, rounded to the tenth the engine measures in; undefined for anything else. */
const secondsOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_SECONDS
    ? Math.round(value * 10) / 10
    : undefined;

const wholeOf = (value: unknown, max: number): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max ? value : undefined;

/** A count CP-SAT made, or null where the engine said it had none; undefined where the value is neither. */
const countOrNull = (value: unknown): number | null | undefined =>
  value === null || value === undefined ? null : wholeOf(value, MAX_COUNT);

/**
 * The report as a page may read it, or null when what arrived is not wholly well formed.
 * Idempotent: the value it returns is accepted by it again unchanged, which is what lets the stored column
 * be read through the same door it was written through.
 */
export function timeoutReportOf(value: unknown): TimeoutReportView | null {
  if (!isRecord(value)) return null;
  const totalSeconds = secondsOf(value.totalSeconds);
  const budgetSeconds = wholeOf(value.budgetSeconds, MAX_SECONDS);
  const configuredBudgetSeconds = wholeOf(value.configuredBudgetSeconds, MAX_SECONDS);
  const callerWait = value.callerWaitSeconds === null || value.callerWaitSeconds === undefined ? null : secondsOf(value.callerWaitSeconds);
  if (totalSeconds === undefined || budgetSeconds === undefined || configuredBudgetSeconds === undefined) return null;
  if (callerWait === undefined) return null;
  if (!Array.isArray(value.stages) || value.stages.length > MAX_STAGES) return null;
  if (!isRecord(value.search) || !Array.isArray(value.search.phases) || value.search.phases.length > MAX_PHASES) return null;
  if (value.weekLoadCut !== undefined && typeof value.weekLoadCut !== 'boolean') return null;

  const stages: TimeoutStageTime[] = [];
  for (const entry of value.stages as unknown[]) {
    if (!isRecord(entry)) return null;
    const seconds = secondsOf(entry.seconds);
    if (typeof entry.stage !== 'string' || !STEP_WORD.test(entry.stage) || seconds === undefined) return null;
    // A step of the engine's that this gateway does not know yet: not shown, and not a reason to show nothing.
    if (!(TIMEOUT_STAGES as readonly string[]).includes(entry.stage)) continue;
    stages.push({ stage: entry.stage as TimeoutStage, seconds });
  }

  const phases: TimeoutSearchPhase[] = [];
  for (const entry of value.search.phases as unknown[]) {
    if (!isRecord(entry)) return null;
    const seconds = secondsOf(entry.seconds);
    const conflicts = countOrNull(entry.conflicts);
    const branches = countOrNull(entry.branches);
    if (
      typeof entry.phase !== 'string' ||
      !(TIMEOUT_PHASES as readonly string[]).includes(entry.phase) ||
      seconds === undefined ||
      conflicts === undefined ||
      branches === undefined
    ) {
      return null;
    }
    phases.push({ phase: entry.phase as TimeoutPhase, seconds, conflicts, branches });
  }

  const solutions = value.search.solutions === undefined ? 0 : wholeOf(value.search.solutions, MAX_COUNT);
  if (solutions === undefined) return null;

  return {
    totalSeconds,
    budgetSeconds,
    configuredBudgetSeconds,
    callerWaitSeconds: callerWait,
    stages,
    search: { solutions, phases },
    weekLoadCut: value.weekLoadCut === true,
  };
}
