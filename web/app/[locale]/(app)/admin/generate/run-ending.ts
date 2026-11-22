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
 *   ENGINE_RUN_ABANDONED the process that held the run went away: how long it had gone on when last heard from
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
  | "ENGINE_RUN_ABANDONED"
  | "ENGINE_RUN_ABANDONED_AFTER";

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
      // A wait that is shorter than the engine says it can need is the whole explanation, and not the school's to fix.
      return engineCeilingSeconds !== null && waitSeconds < engineCeilingSeconds
        ? { key: "ENGINE_WAIT_EXPIRED_SHORT", values: { waitSeconds, engineCeilingSeconds } }
        : { key: "ENGINE_WAIT_EXPIRED_AFTER", values: { waitSeconds } };
    }
    case "ENGINE_NOT_REACHED":
      return { key: "ENGINE_NOT_REACHED" };
    case "ENGINE_RUN_ABANDONED": {
      const lastSeenSeconds = seconds(params, "lastSeenSeconds");
      return lastSeenSeconds === null
        ? { key: "ENGINE_RUN_ABANDONED" }
        : { key: "ENGINE_RUN_ABANDONED_AFTER", values: { lastSeenSeconds } };
    }
    default:
      return null;
  }
}
