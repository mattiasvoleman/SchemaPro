import { useMutation } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";

/*
 * Kontrollera veckan, med lärarval: what the week would be if teachers could be
 * chosen (POST /optimization/week-check/choice). Its own file and not part of
 * lib/week-check.ts, which Generera's page carries: this is loaded only with the
 * panel (components/schedule/week-check-choice.tsx, behind the panel's own lazy
 * import), when somebody asks for it.
 *
 * EVERY FIGURE IS A LOWER BOUND ON THE TIGHTEST PERIOD OF A YEAR. The gateway
 * asks the engine's own check about copies of the week in which some posts have
 * another teacher (src/optimization/week-check-choice.ts), and the engine counts
 * each period of the läsår on its own and keeps the heaviest. `atLeast` says a
 * count was stopped by its seconds: it is then never "the value" and ranks nobody.
 * Mirrored by hand in src/optimization/interfaces/week-check-choice.interface.ts.
 */

/**
 * The gateway's code for an engine that does not know the check yet: the constant of lib/week-check.ts, written out
 * here because that module is in Generera's route chunk and this one is loaded with the panel, and a runtime import
 * from one into the other would make a new edge in the chunk graph (lib/week-check-choice.test.tsx holds the two equal).
 */
const ENGINE_LACKS_WEEK_CHECK = "ENGINE_LACKS_WEEK_CHECK";

/** Which part of the läsår a figure was counted in: the first stretch of days, and whether the period has more. */
export interface ChoicePeriod {
  /** YYYY-MM-DD. */
  from: string;
  to: string;
  more: boolean;
}

export type ChoiceCount =
  | {
      kind: "LOAD";
      demandMinutes: number;
      capacityMinutes: number;
      /** Whole percent, rounded down. */
      percent: number;
      /**
       * Proved above the supply: no timetable exists, whichever teachers are chosen. The figure is then only a lower bound
       * of the tightest period's (the engine stops counting at the first period it refuses): said "at least", ranked never.
       */
      over: boolean;
      /** The count's seconds ran out: a lower bound at the deadline, never the value. */
      atLeast: boolean;
      period: ChoicePeriod | null;
    }
  | { kind: "UNDER"; below: number }
  | { kind: "UNKNOWN" }
  | { kind: "REFUSED"; code: string; params: Record<string, string | number> };

export interface ChoiceWhatIf {
  /** The school's own name for the subject. Never a person. */
  subject: string;
  /** Teachers qualified for the subject in this year, today. */
  qualified: number;
  /** The posts that went to the second teacher, of the teacher's `of` posts. */
  moved: number;
  of: number;
  count: ChoiceCount;
  /** False when this figure is a bound (cut, unknown or over the supply) or the week as it stands has no value to compare it with: listed, never ranked. */
  ranked: boolean;
}

export interface ChoiceYear {
  /** In the läsår's own numbering. */
  year: number;
  today: ChoiceCount;
  /** Null when nothing could be released. */
  floor: ChoiceCount | null;
  /** Best week first. */
  whatIf: ChoiceWhatIf[];
}

export interface WeekCheckChoiceView {
  status: "DONE" | "NO_TIGHT_YEAR" | "NOT_ASKED";
  years: ChoiceYear[];
  qualificationsRecorded: boolean;
  releasedPosts: number;
  notRun: number;
  calls: number;
  elapsedMs: number;
}

/**
 * What an ask came to. Never an exception: the analysis is an addition to a check that has already answered, and
 * its failure must not take the check's answer with it.
 */
export type WeekCheckChoiceOutcome =
  | { kind: "result"; view: WeekCheckChoiceView }
  | { kind: "unavailable"; reason: "ENGINE_OLDER" | "THROTTLED" | "ERROR" };

/**
 * The longest the analysis is waited for. The gateway gives it a budget of twenty-four seconds (up to twelve checks
 * in a row, WEEK_CHECK_CHOICE_BUDGET_MS) and begins none it could not finish inside it; this is a little over that,
 * and well under a minute: the person asked for it, and is looking at the button.
 */
export const WEEK_CHECK_CHOICE_WAIT_MS = 35_000;

function waitOf(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(ms)
    : undefined;
}

export function classifyChoiceError(error: unknown): WeekCheckChoiceOutcome {
  if (error instanceof ApiError) {
    if (error.code === ENGINE_LACKS_WEEK_CHECK) return { kind: "unavailable", reason: "ENGINE_OLDER" };
    // An API that predates the route answers Nest's own 404 (this page can be deployed first).
    if (error.status === 404 && /^Cannot POST /.test(error.message)) return { kind: "unavailable", reason: "ENGINE_OLDER" };
    if (error.status === 429) return { kind: "unavailable", reason: "THROTTLED" };
  }
  return { kind: "unavailable", reason: "ERROR" };
}

export async function askWeekCheckChoice(academicYearId: string): Promise<WeekCheckChoiceOutcome> {
  try {
    const view = await api.post<WeekCheckChoiceView>(
      "/api/v1/optimization/week-check/choice",
      { academicYearId },
      waitOf(WEEK_CHECK_CHOICE_WAIT_MS),
    );
    return { kind: "result", view };
  } catch (error) {
    return classifyChoiceError(error);
  }
}

/** askWeekCheckChoice as a mutation: asked by a button, never retried (the route is throttled and costs the engine up to twelve checks). */
export function useWeekCheckChoice() {
  const mutation = useMutation<WeekCheckChoiceOutcome, never, string>({
    retry: false,
    mutationFn: askWeekCheckChoice,
  });
  return {
    outcome: mutation.data ?? null,
    isPending: mutation.isPending,
    ask: mutation.mutate,
    reset: mutation.reset,
  };
}
