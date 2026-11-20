import { useMutation } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";

/*
 * Kontrollera veckan: what the engine's quick checks find out about a week
 * BEFORE any timetable is searched for (POST /optimization/week-check). Its
 * own file, beside lib/queries.ts, which is in every route's chunk graph and
 * has nothing to spare. Shared by every page that asks the question: Generera
 * (useWeekCheck) and Förlägg i veckan, which loads this module with import()
 * when somebody presses the button (askWeekCheck).
 *
 * AN `OK` IS NOT "A TIMETABLE EXISTS". The checks can prove a week impossible
 * and say that it is tight; they cannot prove it possible. `skipped` says what
 * did not run, and the panel says it in words (components/schedule/week-check).
 */

export type WeekCheckVerdict = "OK" | "TIGHT" | "IMPOSSIBLE";

/**
 * What the check did not run: the lunch stage always, the question whether the
 * förläggningar are why on an impossible week that carries some, a week load
 * whose seconds ran out (a year without a row is then NOT counted), and the
 * engine itself when every post is hand-placed.
 */
export type WeekCheckSkipped = "LUNCH_STAGE" | "PLACEMENTS_PROBE" | "WEEK_LOAD_DEADLINE" | "ENGINE";

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

/** One cause, the way a refused run's rows have it: the same sentences, through the engine catalogue. */
export interface WeekCheckConflict {
  category: string;
  code: string | null;
  message: string;
  params: Record<string, string | number> | null;
  resourceNames?: string[];
}

export interface WeekCheckResult {
  verdict: WeekCheckVerdict;
  /** The years at or above 85 % of their frame time, heaviest first. A year not here is not said anything of. */
  years: WeekCheckYear[];
  conflicts: {
    summary: string;
    summaryCode: string;
    summaryParams: Record<string, string | number> | null;
    conflicts: WeekCheckConflict[];
  } | null;
  skipped: WeekCheckSkipped[];
  elapsedMs: number;
  /** The gateway's own pre-flight refuses before the engine is asked (a post without a teacher). */
  checkedBy: "ENGINE" | "GATEWAY";
}

/**
 * What a check came to. Never an exception: a check that cannot answer must
 * not stop the run it was asked before, so every failure is an outcome the
 * caller reads.
 */
export type WeekCheckOutcome =
  /**
   * The engine's (or the gateway's) answer. `academicYearId` is the year it is about, so that a follow-up question
   * (what the week would be with teacher choice, components/schedule/week-check-choice.tsx) is asked about the same
   * year without the page having to pass it on.
   */
  | { kind: "result"; result: WeekCheckResult; academicYearId?: string }
  /** The payload itself is refused, in the sentence a Generera is refused with ("locked lessons leave 7A no lunch"). */
  | { kind: "refused"; code: string | null; message: string; params: Record<string, string | number> | null }
  /** No answer: the engine is older than the API, the API older than this page, or something failed. */
  | { kind: "unavailable"; reason: "ENGINE_OLDER" | "ERROR"; message: string };

/**
 * The longest a check is waited for. It answers in a few seconds; the gateway's own wait for the engine is thirty,
 * and a Generera that waits longer than that for a check is held by the one thing that was asked to cost it nothing.
 * A check that has not answered by then is one that cannot (`unavailable`), and the run goes on.
 */
export const WEEK_CHECK_WAIT_MS = 15_000;

/** A signal that ends the wait; none in a browser that has no AbortSignal.timeout, where the check waits as it did. */
function waitOf(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(ms)
    : undefined;
}

/** The gateway's code for an engine that does not know the route yet (deploys are minutes apart). */
export const ENGINE_LACKS_WEEK_CHECK = "ENGINE_LACKS_WEEK_CHECK";

/** Whether the week is one to ask about before a run: tight, impossible, or refused by name. */
export function warnsBeforeRun(outcome: WeekCheckOutcome | null | undefined): boolean {
  if (!outcome) return false;
  if (outcome.kind === "refused") return true;
  return outcome.kind === "result" && outcome.result.verdict !== "OK";
}

export function classifyWeekCheckError(error: unknown): WeekCheckOutcome {
  if (error instanceof ApiError) {
    // A refusal of the payload is the 400 Generera gives, with the engine's code
    // and values; the status alone is a malformed request and has no code.
    if (error.status === 400 && error.code) {
      return { kind: "refused", code: error.code, message: error.message, params: error.params ?? null };
    }
    if (error.code === ENGINE_LACKS_WEEK_CHECK) {
      return { kind: "unavailable", reason: "ENGINE_OLDER", message: error.message };
    }
    // An API that predates the route answers Nest's own 404, "Cannot POST /…" (this page can be deployed first). A 404
    // with another sentence is the gateway saying something is not there ("the läsår does not exist"), which is no
    // function that is coming.
    if (error.status === 404 && /^Cannot POST /.test(error.message)) {
      return { kind: "unavailable", reason: "ENGINE_OLDER", message: error.message };
    }
    return { kind: "unavailable", reason: "ERROR", message: error.message };
  }
  return { kind: "unavailable", reason: "ERROR", message: error instanceof Error ? error.message : "" };
}

/**
 * POST week-check for a year, as an outcome whatever happened: it never throws.
 * A plain function, so that a page near its bundle budget can load this module
 * when somebody asks (Förlägg i veckan) instead of carrying it.
 */
export async function askWeekCheck(academicYearId: string): Promise<WeekCheckOutcome> {
  try {
    const result = await api.post<WeekCheckResult>(
      "/api/v1/optimization/week-check",
      { academicYearId },
      waitOf(WEEK_CHECK_WAIT_MS),
    );
    return { kind: "result", result, academicYearId };
  } catch (error) {
    return classifyWeekCheckError(error);
  }
}

/**
 * askWeekCheck as a mutation, for the page that asks before a run. Never
 * retried: it is read-only, but a second ask is the person's to make, and the
 * route is throttled. `check` resolves with the outcome whatever happened, so a
 * caller that goes on to a run does not need a catch.
 */
export function useWeekCheck() {
  const mutation = useMutation<WeekCheckOutcome, never, string>({
    retry: false,
    mutationFn: askWeekCheck,
  });
  return {
    outcome: mutation.data ?? null,
    isPending: mutation.isPending,
    check: mutation.mutateAsync,
    reset: mutation.reset,
  };
}
