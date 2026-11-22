import type { ConflictDetail, OptimizationJob } from "@/lib/queries";
import type { SuggestionRule } from "@/lib/suggestion-types";

/*
 * WHAT IS ALREADY KNOWN OF A REFUSED OR TIMED-OUT WEEK, BEFORE THE ENGINE IS ASKED (omgång 13, G6 Åtgärdsförslag vid vägran).
 *
 * Two kinds of thing, each said as what it is and neither as a solution:
 *
 *   AT_LEAST   A refusal that names a teacher's cap and the arithmetic behind it. The least the cap can be is a NECESSARY condition: the
 *              lessons the week owes the teacher have to fit the days at that cap. It is not sufficient, so it is "at least": locked
 *              lessons, the rest of the week and everything else the engine holds it to only raise it.
 *   MEASURED   A timeout's probe: a rule switched off, the week solved in a short search. The probe measures that the rule is in the way
 *              of THAT search, not that raising it to any value is enough, and says no figure; a card made of it says "may help".
 *
 * A figure here is computed from what the run itself said (its refusal's params), never from anything else, and a refusal this reader
 * cannot place is left out rather than guessed at. Pure, and in a file of its own so that a test can read it without rendering the card.
 */

/** The figures of a cap's refusal: the least the cap can be, and why. */
export interface CapAtLeast {
  kind: "CAP_AT_LEAST";
  /** The teacher's work rule, as the refusal names it: a row the link can name, or null when the refusal gave none. */
  workRuleId: string | null;
  minutes: number;
  /** A lesson longer than the cap, or the week's minutes against the days the cap can hold. */
  because: "LESSON" | "WEEK";
}

/** A rule a probe found in the way. */
export interface MeasuredRule {
  kind: "MEASURED";
  rule: SuggestionRule | "SUBJECT_SPREAD";
}

export type Hint = CapAtLeast | MeasuredRule;

/** The grid a cap is written in: minutes in fives. */
const CAP_STEP = 5;

const whole = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 100_000 ? value : null;

const roundedUp = (minutes: number): number => Math.ceil(minutes / CAP_STEP) * CAP_STEP;

/** The cap a refusal says is too small, and the least it could be. */
function capAtLeastOf(code: string | null, params: Record<string, string | number> | null): CapAtLeast | null {
  if (code === null || params === null) return null;
  const rule = typeof params.rule === "string" ? params.rule : null;
  if (code === "TEACHER_LESSON_LONGER_THAN_DAILY_CAP") {
    const lesson = whole(params.lessonMinutes);
    // A cap that is shorter than one of the teacher's own lessons: the lesson is the least it can be, and it is exact.
    return lesson === null ? null : { kind: "CAP_AT_LEAST", workRuleId: rule, minutes: lesson, because: "LESSON" };
  }
  if (code === "TEACHER_DAILY_CAP_TOO_SMALL_FOR_WEEK") {
    const week = whole(params.weekMinutes);
    const days = whole(params.days);
    if (week === null || days === null) return null;
    // The week's minutes spread over the days the school teaches, rounded up to the grid. Locked lessons already use some of each day,
    // so this is a floor and the page says so.
    return { kind: "CAP_AT_LEAST", workRuleId: rule, minutes: roundedUp(week / days), because: "WEEK" };
  }
  return null;
}

/** What a probe's finding is a finding about. */
const RULE_OF_PROBE: Record<string, MeasuredRule["rule"]> = {
  PROBE_SOLVED_WITHOUT_TEACHER_DAILY_CAP: "TEACHER_DAILY_CAP",
  PROBE_SOLVED_WITHOUT_TEACHER_DAY_LIMITS: "TEACHER_WORK_DAYS",
  PROBE_SOLVED_WITHOUT_DISTRIBUTION: "SUBJECT_SPREAD",
};

function measuredOf(conflicts: readonly ConflictDetail[]): MeasuredRule[] {
  const seen = new Set<MeasuredRule["rule"]>();
  for (const row of conflicts) {
    if (row.category !== "TIMEOUT_PROBE") continue;
    const rule = RULE_OF_PROBE[row.code ?? ""];
    if (rule !== undefined) seen.add(rule);
  }
  return [...seen].map((rule) => ({ kind: "MEASURED", rule }));
}

/** What the run already says, in the order it is said: the refusal's figure, then what the probe measured. */
export function hintsOf(job: Pick<OptimizationJob, "errorCode" | "errorParams" | "conflicts" | "solverStatus">): Hint[] {
  const hints: Hint[] = [];
  const cap = capAtLeastOf(job.errorCode ?? null, job.errorParams ?? null);
  if (cap !== null) hints.push(cap);
  if (job.solverStatus === "TIMEOUT") hints.push(...measuredOf(job.conflicts ?? []));
  return hints;
}
