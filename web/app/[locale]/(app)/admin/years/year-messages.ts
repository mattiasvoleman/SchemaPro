import { ApiError } from "@/lib/api";
import { engineMessage, type MessageLookup } from "@/lib/engine-message";
import { messageValues } from "@/lib/year-rollover-form";
import type { RolloverProblem } from "@/lib/types";

/*
 * The läsår pages' sentences from the gateway's codes.
 *
 * The rollover and the activation answer every refusal and every finding with
 * a CODE and flat PARAMS beside a Swedish message (src/year-rollover). The
 * pages render the reader's language from years.errors.* and
 * years.problems.*, through lib/engine-message.ts's fallback: a code the web
 * has not translated yet, or a param a sentence needs and the gateway did not
 * send (YEAR_HAS_SUCCESSOR names the successor only when it could read it),
 * shows the gateway's own sentence instead of throwing inside the render.
 */

/** A failed rollover or activation call, as one sentence. */
export function yearErrorText(t: MessageLookup, error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    // next-intl in the browser does not throw on a missing argument — it
    // prints the key path — so the one code whose param is optional picks
    // its sentence by whether the param came.
    const code =
      error.code === "YEAR_HAS_SUCCESSOR" && error.params?.successor === undefined
        ? "YEAR_HAS_SUCCESSOR_UNNAMED"
        : error.code;
    return engineMessage(t, {
      code: code ?? null,
      message: error.message,
      params: error.params ?? null,
    });
  }
  return error instanceof Error ? error.message : fallback;
}

/** A finding of a preview, as one sentence; the code itself when untranslated. */
export function problemText(t: MessageLookup, problem: Pick<RolloverProblem, "code" | "params">): string {
  return engineMessage(t, {
    code: problem.code,
    message: problem.code,
    params: messageValues(problem.params),
  });
}
