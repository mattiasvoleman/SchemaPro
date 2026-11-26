/*
 * HOW A RUN THAT GAVE NO ANSWER IS SAID (omgång 13, M2 Förklaringen när tiden tar slut).
 *
 * A Generera that ends without an answer from the engine used to say one of four things, and two of them were
 * the gateway's English on a Swedish page. Each ending now has a code and the figures the gateway knows, and this
 * picks the sentence that says as much of them as it has:
 *
 *   ENGINE_TIMED_OUT     the engine's own ceiling fell: its longest wait, and the step its solve was in
 *   ENGINE_WAIT_EXPIRED  the API's own wait ran out: for how long, and what the engine says it can need
 *   ENGINE_NOT_REACHED   the call never arrived (the engine was down or restarted)
 *   ENGINE_PATH_CLOSED   the road between the service and the engine closed the call: after how long, and what the road holds
 *   ENGINE_RUN_ABANDONED the process that held the run went away: how long it had gone on when last heard from
 *
 * And the three refusals of a schedule to start from (Ett schema som start, M9), which the gateway answers at the click (a
 * version that is not the year's, a year with none before it) or in the run, before the engine (a schedule with no lesson that
 * belongs to a post of the week), each said as what the school can do next:
 *
 *   START_NO_PREVIOUS_YEAR, START_VERSION_NOT_FOUND, START_NOTHING_TO_START_FROM (one of three sentences, by what it says of why)
 *
 * A run stored before the figures existed, and an engine older than the field, carry none of them: the sentence is
 * then the one each ending always had. A figure that is not a finite number of seconds is not said, and the figures
 * of a step are said together or not at all (a step with no seconds is not a sentence).
 *
 * Its own file, beside the page, so that a test can read it without rendering the page.
 */

type Params = Record<string, string | number> | null | undefined;

/** The keys of `scheduleCandidates.jobErrors` this file chooses between. */
export type RunEndingKey =
  | "ENGINE_TIMED_OUT"
  | "ENGINE_TIMED_OUT_CEILING"
  | "ENGINE_TIMED_OUT_AT"
  | "ENGINE_WAIT_EXPIRED"
  | "ENGINE_WAIT_EXPIRED_AFTER"
  | "ENGINE_WAIT_EXPIRED_SHORT"
  | "ENGINE_NOT_REACHED"
  | "ENGINE_PATH_CLOSED"
  | "ENGINE_PATH_CLOSED_AFTER"
  | "ENGINE_RUN_ABANDONED"
  | "ENGINE_RUN_ABANDONED_AFTER"
  | "START_NO_PREVIOUS_YEAR"
  | "START_VERSION_NOT_FOUND"
  | "START_NOTHING_EMPTY"
  | "START_NOTHING_NO_SUCCESSOR"
  | "START_NOTHING_USABLE";

export interface RunEnding {
  key: RunEndingKey;
  /** The figures the sentence says, in the order it says them; absent for the plain sentence. */
  values?: Record<string, string | number>;
}

/** The engine's own names for the steps of a solve (the gateway carries only these through). */
const STAGES: readonly string[] = ["PRECHECKS", "BUILD", "SITES", "SEARCH_CLEAN", "SEARCH_CLONE", "PROBE"];

const seconds = (params: Params, key: string): number | null => {
  const value = params?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
};

/** The sentence for a failed run's code and params, or null for a code that is not one of these endings. */
export function runEnding(code: string | null, params: Params): RunEnding | null {
  switch (code) {
    case "ENGINE_TIMED_OUT": {
      const ceilingSeconds = seconds(params, "ceilingSeconds");
      const stage = params?.stage;
      const stageSeconds = seconds(params, "stageSeconds");
      const elapsedSeconds = seconds(params, "elapsedSeconds");
      if (
        ceilingSeconds !== null &&
        typeof stage === "string" &&
        STAGES.includes(stage) &&
        stageSeconds !== null &&
        elapsedSeconds !== null
      ) {
        return { key: "ENGINE_TIMED_OUT_AT", values: { ceilingSeconds, stage, stageSeconds, elapsedSeconds } };
      }
      return ceilingSeconds !== null
        ? { key: "ENGINE_TIMED_OUT_CEILING", values: { ceilingSeconds } }
        : { key: "ENGINE_TIMED_OUT" };
    }
    case "ENGINE_WAIT_EXPIRED": {
      const waitSeconds = seconds(params, "waitSeconds");
      if (waitSeconds === null) return { key: "ENGINE_WAIT_EXPIRED" };
      const engineCeilingSeconds = seconds(params, "engineCeilingSeconds");
      // A wait that is shorter than the engine says it can need is said with both figures and left to whoever runs the service. The
      // sentence does not say the wait is the cause: since the engine is sent the caller's deadline, a wait that ran out is as likely an
      // engine or a network that hung (it is the whole explanation only for an older engine, which does not take the deadline).
      return engineCeilingSeconds !== null && waitSeconds < engineCeilingSeconds
        ? { key: "ENGINE_WAIT_EXPIRED_SHORT", values: { waitSeconds, engineCeilingSeconds } }
        : { key: "ENGINE_WAIT_EXPIRED_AFTER", values: { waitSeconds } };
    }
    case "ENGINE_NOT_REACHED":
      return { key: "ENGINE_NOT_REACHED" };
    case "ENGINE_PATH_CLOSED": {
      // The two figures go together or not at all: "closed after N s" with no limit, or a limit with no time, is not a sentence.
      const elapsedSeconds = seconds(params, "elapsedSeconds");
      const pathLimitSeconds = seconds(params, "pathLimitSeconds");
      return elapsedSeconds !== null && pathLimitSeconds !== null
        ? { key: "ENGINE_PATH_CLOSED_AFTER", values: { elapsedSeconds, pathLimitSeconds } }
        : { key: "ENGINE_PATH_CLOSED" };
    }
    case "ENGINE_RUN_ABANDONED": {
      const lastSeenSeconds = seconds(params, "lastSeenSeconds");
      return lastSeenSeconds === null
        ? { key: "ENGINE_RUN_ABANDONED" }
        : { key: "ENGINE_RUN_ABANDONED_AFTER", values: { lastSeenSeconds } };
    }
    case "START_NO_PREVIOUS_YEAR":
    case "START_VERSION_NOT_FOUND":
      return { key: code };
    case "START_NOTHING_TO_START_FROM": {
      // How many lessons the schedule held, and how many of them belonged to a class with no successor: none held is "nothing yet",
      // all of them a class that left is that, and anything else is lessons that match no post of the week.
      const offered = seconds(params, "offered");
      if (offered === null || offered === 0) return { key: "START_NOTHING_EMPTY" };
      return seconds(params, "noSuccessor") === offered
        ? { key: "START_NOTHING_NO_SUCCESSOR" }
        : { key: "START_NOTHING_USABLE", values: { offered } };
    }
    default:
      return null;
  }
}
