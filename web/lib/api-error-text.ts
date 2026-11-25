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
 * What is written here, each from a key of the `common` catalogue (`common.problem*`, `common.validation*`), and nothing else is:
 *
 *   - a request that got no answer (NETWORK_FAILURE, made by api.ts);
 *   - a 400 whose validation sentences the gateway sent (`problems`), class-validator's English said again in the reader's language
 *     (lib/validation-problems.ts);
 *   - a refusal with no `code` whose sentence is only a log's: Nest's, Prisma's and the filter's own English (GATEWAY_LOG, pinned
 *     against the gateway's sources by api-error-text.contract.test.ts), a bare status ("Not Found", "HTTP 502", "Cannot GET /x"),
 *     and, for a 404, a 429 and a 5xx, any English sentence: a thrower writes the reader's sentences in Swedish;
 *   - a 401, which says the sign-in has gone, except the one that says there is no person behind it.
 *
 * What a thrower wrote for the reader is left as it is: a Swedish 404 or 503 ("Läraren har ingen tjänst det läsåret. Lägg in tjänsten
 * först."), a 400, 403 or 409 whose service worded it, and a problem WITH a `code` the web has no sentence of its own for (a refusal the
 * gateway worded for the reader, or one a page words itself from the code). So is an error that is not the gateway's.
 *
 * A problem with a code the web HAS a sentence for (lib/problem-codes.ts: `common.codes.<CODE>`, with the params the gateway sends) is
 * said from that sentence in the reader's language. A page that words a code itself, through engineMessage, asks first; this is the
 * last resort of the pages that fall back to apiErrorText. ownWords has no translator and so never gets such a sentence.
 *
 * It asks the translator for a key and never for `has`: the page tests replace
 * next-intl with a stub that only echoes (web-page-tests-mock-next-intl), and
 * the keys are not optional. It does not import api.ts either, so a test that
 * mocks "@/lib/api" without ApiError still reaches it.
 */

import { fieldSentence, readValidation, validationSentence } from "@/lib/validation-problems";

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
  method?: unknown;
}

/** The sentences of a failure's `problems`, the strings among them. */
function validationOf(error: unknown): string[] {
  const problems = (error as Problem | null)?.problems;
  return Array.isArray(problems) ? problems.filter((sentence): sentence is string => typeof sentence === "string") : [];
}

/**
 * The gateway's own sentences for a log, by what they say: what the filter writes (src/common/filters/http-exception.filter.ts), what
 * a Nest guard throws, and what a service says about a sign-in. None of them is a sentence for a reader, and a code-less 400, 403,
 * 409, 413 or 415 that is one of them said "A resource with the same unique identifier already exists." to a Swedish principal.
 * api-error-text.contract.test.ts reads each against the gateway's sources, so that a sentence the gateway rewords is a failing test
 * here and not a sentence that falls out of this list.
 */
export const GATEWAY_LOG: Readonly<Record<string, ProblemKey>> = {
  // The filter's, by Prisma's code and by the body parser's type.
  "A resource with the same unique identifier already exists.": "problemConflict",
  "The requested resource does not exist.": "problemNotFound",
  "The request references a resource that does not exist.": "problemNotFound",
  "The request could not be processed.": "problemBadRequest",
  "An unexpected database error occurred.": "problemServer",
  "An unexpected error occurred. Please try again later.": "problemServer",
  "The request body is too large. Split the import into smaller files and upload them one at a time.": "problemTooLarge",
  "The request body is not valid JSON.": "problemBadRequest",
  "The request body uses an unsupported content encoding.": "problemBadRequest",
  // Nest's guards: a role the route does not let in, and a guard that said no.
  "You do not have permission to perform this action.": "problemForbidden",
  "Forbidden resource": "problemForbidden",
  // The login holds a token and no person: the one 401 that is not "sign in again".
  "No active user profile is linked to this account.": "problemNoProfile",
};

/** The general sentence for a status, when the sentence the gateway gave for it is only a log's. */
const BY_STATUS: Readonly<Record<number, ProblemKey>> = {
  400: "problemBadRequest",
  401: "problemSignedOut",
  403: "problemForbidden",
  404: "problemNotFound",
  409: "problemConflict",
  413: "problemTooLarge",
  415: "problemBadRequest",
  429: "problemTooMany",
};

/** The keys of `common` that say a failure in general. */
export type ProblemKey =
  | "problemNetwork"
  | "problemSignedOut"
  | "problemNoProfile"
  | "problemNotFound"
  | "problemTooMany"
  | "problemServer"
  | "problemForbidden"
  | "problemConflict"
  | "problemTooLarge"
  | "problemBadRequest";

/** A bare status as Nest and api.ts write it: "Not Found", "Too Many Requests", "HTTP 502", "Cannot GET /api/v1/x". */
const BARE_STATUS =
  /^(?:HTTP \d{3}|Cannot (?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \S*|(?:Bad Request|Unauthorized|Forbidden|Not Found|Conflict|Payload Too Large|Unsupported Media Type|Too Many Requests|Bad Gateway|Service Unavailable|Gateway Timeout|Internal Server Error)|ThrottlerException: .*|Not authenticated\.|Invalid authentication token\.)$/;

/**
 * Whether a sentence is Swedish, as far as a few letters and the commonest words say: the gateway's throwers write what a reader is
 * to read in Swedish and what a log is to read in English (a convention of src/, read across the 128 code-less 404s and 503s it
 * throws: the 40 with a Swedish sentence are told Swedish here and the 88 in English are not). A sentence this takes for English is
 * replaced by a general one; a Swedish one it misses gets the general sentence it got before, so a miss costs a detail and no more.
 */
const SWEDISH = /[åäöÅÄÖ]|\b(?:och|inte|är|finns|saknas|måste|eller|från|redan|ska|kan|har|för|med|som|att|det|på|ett|den|du|din|ditt|bara|alla|ingen|inga|vid|inom|ogiltig)\b/i;

/**
 * What a failure is said as, in general, or null when the gateway's own sentence is the one to show: a thrower's, a coded one's, a
 * failure that is not the gateway's. The one place that decides it; apiErrorText says the key and ownWords says what is left.
 */
export function generalKey(error: unknown): ProblemKey | null {
  if (!(error instanceof Error)) return null;
  const { status, code } = error as Error & Problem;
  if (typeof status !== "number") return null;
  if (code === NETWORK_FAILURE) return "problemNetwork";
  if (validationOf(error).length > 0) return null;
  const sentence = error.message.trim();
  // The filter's own sentences are a log's whatever code they carry: the body parser's 413, 415 and unreadable JSON are given codes
  // (REQUEST_BODY_TOO_LARGE and the others) and keep their English `detail`, which a code-first rule would show to the reader as it is.
  const logged = GATEWAY_LOG[sentence];
  if (logged) return logged;
  if (typeof code === "string") return null;
  if (status === 401) return "problemSignedOut";
  // A status and nothing else to say: the general sentence of the status, where there is one.
  if (sentence === "" || BARE_STATUS.test(sentence)) return BY_STATUS[status] ?? (status >= 500 ? "problemServer" : null);
  // A 404, a 429 and a 5xx are the statuses a log's English reaches a reader with; a Swedish sentence there is a thrower's own.
  if (status === 404 || status === 429 || status >= 500) {
    return SWEDISH.test(sentence) ? null : BY_STATUS[status] ?? "problemServer";
  }
  return null;
}

export function apiErrorText(error: unknown, t: ProblemLookup): string {
  if (!(error instanceof Error)) return t("error");
  const sentences = validationOf(error);
  const { status, code, method } = error as Error & Problem;
  if (sentences.length > 0 && typeof status === "number" && typeof code !== "string") {
    const said = sentences.map((sentence) => asSentence(validationSentence(readValidation(sentence), t)));
    const shown = said.slice(0, SHOWN).join(" ");
    const more = said.length - SHOWN;
    // A refused read says the read, not that something was not saved: the gateway checks a query's parameters with a DTO too.
    const kind = method === "GET" ? "read" : "write";
    return more > 0 ? t("problemValidationMore", { problems: shown, count: more, kind }) : t("problemValidation", { problems: shown, kind });
  }
  const key = generalKey(error);
  if (key) return t(key);
  const coded = typeof code === "string" ? problemCodeText(error, code, t) : undefined;
  if (coded !== undefined) return coded;
  // Its own words, and the generic sentence where there are none.
  return error.message === "" ? t("error") : error.message;
}

/**
 * What of a failure's own sentence is for a reader: the gateway's words when a thrower wrote them, and "" when it is a log's or when
 * the failure is not a sentence at all (no answer, a validation list). For a classifier that has no translator and hands a notice
 * the words it may show, and the notice says its general sentence for the rest.
 */
export function ownWords(error: unknown): string {
  if (!(error instanceof Error)) return "";
  if (generalKey(error) !== null || validationOf(error).length > 0) return "";
  return error.message;
}

/**
 * The sentence the gateway's validation gave for one property, for the form field that holds it ("Får inte vara tomt." beside the
 * name): undefined when the failure is no validation, or names no sentence for the property.
 */
export function fieldProblem(error: unknown, field: string, t: ProblemLookup): string | undefined {
  for (const sentence of validationOf(error)) {
    const problem = readValidation(sentence);
    if (problem.field === field && !problem.each) return fieldSentence(problem, t);
  }
  return undefined;
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
