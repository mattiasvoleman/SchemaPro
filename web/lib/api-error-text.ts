import { problemCodeText } from "@/lib/problem-codes";

/**
 * The sentence a failed request is shown as, in the reader's language.
 *
 * The gateway answers a refusal with a problem (RFC 7807, src/common/filters/
 * http-exception.filter.ts) whose `detail` is a sentence written for a log:
 * English for a 404, a 429 or a 500 ("The requested resource does not exist.",
 * "ThrottlerException: Too Many Requests"), and the constant "One or more
 * fields failed validation." for a 400 from a DTO, with the sentences that say
 * which field in `errors`, which api.ts used to drop. A handler that showed
 * `error.message` showed those.
 *
 * Three kinds of answer are written here, each from a key of the `common`
 * catalogue (`common.problem*`), and nothing else is:
 *
 *   - a request that got no answer (NETWORK_FAILURE, made by api.ts);
 *   - a refusal with no `code` whose status says what happened and whose
 *     sentence is only a log's: 401, 404, 429 and any 5xx;
 *   - a 400 whose validation sentences the gateway sent (`problems`).
 *
 * A problem WITH a `code` is a refusal the gateway worded for the reader (in
 * Swedish, by its thrower) or one a page words itself from the code, and it is
 * left as it is. So is an error that is not the gateway's.
 *
 * It asks the translator for a key and never for `has`: the page tests replace
 * next-intl with a stub that only echoes (web-page-tests-mock-next-intl), and
 * the keys are not optional. It does not import api.ts either, so a test that
 * mocks "@/lib/api" without ApiError still reaches it.
 */

/**
 * The `code` api.ts gives a request that never got an answer. Minted by the
 * client, not by the gateway, whose codes are upper-case names of its own; the
 * prefix keeps the two apart.
 */
export const NETWORK_FAILURE = "CLIENT_NETWORK_FAILURE";

/**
 * Whether a request got no answer at all. api.ts throws that as an ApiError (status 0) so that the sinks that were converted tell it
 * in the reader's language, which makes it an ApiError that is NOT the gateway's: a branch that reads "an ApiError" as "the gateway
 * answered" has to ask this first. Before api.ts named the failure it was a bare TypeError and fell to such a branch's "anything
 * else": the krisläge's "no contact with the server", the generic sentence of a notice with no sentence of the gateway's to show.
 */
export function isNetworkFailure(error: unknown): boolean {
  return error instanceof Error && (error as Error & { code?: unknown }).code === NETWORK_FAILURE;
}

/** The half of next-intl's translator for `common` this needs, so a test can pass a stub. */
export type ProblemLookup = (key: string, values?: Record<string, string | number>) => string;

/** How many validation sentences are shown; the rest are counted. */
const SHOWN = 3;

/**
 * A validation sentence as a sentence in a row of them. The ones a DTO words itself end in a full stop ("Nivån kan vara högst 1500
 * timmar."); class-validator's own, which most of the gateway's decorators use, do not ("name should not be empty"), and joined with a
 * space they run into one another.
 */
const asSentence = (sentence: string): string => (/[.!?…]\s*$/.test(sentence) ? sentence.trim() : `${sentence.trim()}.`);

/** What of an ApiError (lib/api.ts) is read, as a shape: the class is not imported. */
interface Problem {
  status?: unknown;
  code?: unknown;
  problems?: unknown;
}

export function apiErrorText(error: unknown, t: ProblemLookup): string {
  if (!(error instanceof Error)) return t("error");
  const { status, code, problems } = error as Error & Problem;
  // Its own words, and the generic sentence where there are none.
  const own = error.message === "" ? t("error") : error.message;
  // Not the gateway's: what it says, as every handler did before.
  if (typeof status !== "number") return own;
  if (code === NETWORK_FAILURE) return t("problemNetwork");
  // The gateway named the case: the web's own sentence for the code when it has one (lib/problem-codes.ts), else its thrower's.
  if (typeof code === "string") return problemCodeText(error, code, t) ?? own;
  if (Array.isArray(problems) && problems.length > 0) {
    const sentences = problems.filter((sentence): sentence is string => typeof sentence === "string");
    if (sentences.length > 0) {
      const shown = sentences.slice(0, SHOWN).map(asSentence).join(" ");
      const more = sentences.length - SHOWN;
      return more > 0 ? t("problemValidationMore", { problems: shown, count: more }) : t("problemValidation", { problems: shown });
    }
  }
  if (status === 401) return t("problemSignedOut");
  if (status === 404) return t("problemNotFound");
  if (status === 429) return t("problemTooMany");
  if (status >= 500) return t("problemServer");
  return own;
}

/**
 * The same, for the helpers that word a page's own refusals from the gateway's code (lib/publication-messages.ts, the rollover's,
 * the integrations') and fall back to what the gateway said for any other. They were given the sentence for a thrown value that is
 * no error, `tCommon("error")`; given `tCommon` itself they speak for a 404, a 429, a 5xx and a lost connection as well. A string is
 * still taken, for a caller that has its own sentence and no translator for `common`.
 */
export function failureText(error: unknown, fallback: string | ProblemLookup): string {
  if (typeof fallback === "function") return apiErrorText(error, fallback);
  return error instanceof Error && error.message !== "" ? error.message : fallback;
}
