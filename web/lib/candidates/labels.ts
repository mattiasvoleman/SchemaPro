import type { CandidateRun, CandidateRunStatus, CandidateSolverStatus, CandidateView } from "./types";

/*
 * The words of Schemaförslag: which message each state, code and part is
 * said with. Keys of the `scheduleCandidates` namespace, never sentences, so
 * the pages translate and the tests here can assert the choice with an echo.
 * labels.test.ts holds every key these maps can return to both message files.
 *
 * Light on purpose: the generate page imports this for isActiveRun, and that
 * route has a budget to keep.
 */

/** next-intl's translator, as far as these helpers need it. */
export type Translate = (key: string, values?: Record<string, string | number>) => string;

/** A run the gateway is still working on: the page polls it, and Generera waits for it. */
export function isActiveRun(status: CandidateRunStatus | null | undefined): boolean {
  return status === "PENDING" || status === "RUNNING" || status === "CANCELLING";
}

/** A candidate with a timetable the apply can write. */
export function isApplicable(candidate: Pick<CandidateView, "solverStatus">): boolean {
  return candidate.solverStatus === "OPTIMAL" || candidate.solverStatus === "FEASIBLE";
}

/** The emphasis each variant is named by (design §1). Seeds are never shown. */
export const VARIANT_KEYS: Readonly<Record<string, string>> = {
  KEEP: "variant.KEEP",
  TEACHER_GAPS: "variant.TEACHER_GAPS",
  SPREAD: "variant.SPREAD",
  FREE: "variant.FREE",
};

/**
 * A candidate's name. A variant this build does not know — the engine's
 * benchmarks may add one before the web ships its words — is "Förslag N",
 * never its code.
 */
export function variantLabel(t: Translate, candidate: Pick<CandidateView, "variant" | "ordinal">): string {
  const key = VARIANT_KEYS[candidate.variant];
  return key ? t(key) : t("variant.unknown", { ordinal: candidate.ordinal });
}

/**
 * The gateway's name for the safety version an apply saves ("Före
 * schemaförslag 2 – Färre håltimmar för lärarna", design §4 step 7). It is
 * stored in Swedish whatever the reader's language, so it is repeated here
 * in Swedish rather than translated: the toast must name the version the
 * list under Versioner shows.
 */
const SWEDISH_VARIANT_NAMES: Readonly<Record<string, string>> = {
  KEEP: "Behåll mest",
  TEACHER_GAPS: "Färre håltimmar för lärarna",
  SPREAD: "Jämnare veckor",
  FREE: "Friare placering",
};

export function safetyVersionName(candidate: Pick<CandidateView, "variant" | "ordinal">): string {
  const label = SWEDISH_VARIANT_NAMES[candidate.variant] ?? candidate.variant;
  return `Före schemaförslag ${candidate.ordinal} – ${label}`;
}

/** Why a candidate has no timetable to compare, said in its column's head. */
export const SOLVER_KEYS: Readonly<Record<string, string>> = {
  INFEASIBLE: "solver.INFEASIBLE",
  TIMEOUT: "solver.TIMEOUT",
  REJECTED: "solver.REJECTED",
};

export function solverKey(status: CandidateSolverStatus | null): string {
  return (status && SOLVER_KEYS[status]) || "solver.unknown";
}

/** The basis parts /check may name (design §5), as the nouns a sentence lists them by. */
export const PART_KEYS: Readonly<Record<string, string>> = {
  requirements: "parts.requirements",
  preserved: "parts.preserved",
  draft: "parts.draft",
  rooms: "parts.rooms",
  rules: "parts.rules",
  rosters: "parts.rosters",
};

/**
 * "timplanen, salarna och skolans regler". A part this build has no word for
 * is listed by its own name: a sentence that drops one would tell the reader
 * less changed than did.
 */
export function changedPartsText(t: Translate, changed: readonly string[], locale: string): string {
  const names = changed.map((part) => (PART_KEYS[part] ? t(PART_KEYS[part]) : part));
  return new Intl.ListFormat(locale === "en" ? "en-GB" : "sv-SE", { style: "long", type: "conjunction" }).format(names);
}

/**
 * A run that ended without a batch, by the code the gateway stored. The
 * pages say a CANDIDATES_FIRST_FAILED by firstFailedKey, which also reads
 * the run's first candidate.
 */
export const RUN_ERROR_KEYS: Readonly<Record<string, string>> = {
  CANDIDATE_RUN_CANCELLED: "runErrors.CANDIDATE_RUN_CANCELLED",
  CANDIDATE_ENGINE_TIMEOUT: "runErrors.CANDIDATE_ENGINE_TIMEOUT",
  CANDIDATE_ENGINE_FAILED: "runErrors.CANDIDATE_ENGINE_FAILED",
  ENGINE_LACKS_CANDIDATES: "runErrors.ENGINE_LACKS_CANDIDATES",
  CANDIDATES_FIRST_FAILED: "runErrors.CANDIDATES_FIRST_FAILED",
  CANDIDATES_NONE_APPLICABLE: "runErrors.CANDIDATES_NONE_APPLICABLE",
  CANDIDATE_RUN_INTERRUPTED: "runErrors.CANDIDATE_RUN_INTERRUPTED",
  CANDIDATE_RUN_ABANDONED: "runErrors.CANDIDATE_RUN_ABANDONED",
};

/** The half of next-intl's translator engineMessage needs (lib/engine-message.ts). */
export interface EngineLookup {
  (key: string, values?: Record<string, string | number>): string;
  has(key: string): boolean;
}

/**
 * The sentence for a failed run: one of this feature's own codes, then a
 * sentence the engine named (a refusal it or the gateway's pre-flight sent,
 * such as unstaffed posts), then the English the gateway stored, then a
 * plain "could not". The same ladder lib/engine-message.ts climbs, one rung
 * higher, so a code nobody here has translated still reads as something.
 */
export function runErrorText(
  t: Translate,
  tEngine: EngineLookup,
  run: Pick<CandidateRun, "errorCode" | "errorParams" | "error">,
): string {
  const code = run.errorCode;
  if (code && RUN_ERROR_KEYS[code]) return t(RUN_ERROR_KEYS[code]);
  if (code && tEngine.has(code)) {
    try {
      return tEngine(code, run.errorParams ?? {});
    } catch {
      // A param the sentence names and the gateway did not send: fall through.
    }
  }
  return run.error ?? t("runErrors.generic");
}

/**
 * The sentence for a CANDIDATES_FIRST_FAILED run, by its first candidate.
 * One that ran out of time met no hard rule, so "the others would have met
 * the same obstacle" would be false of it; and "what stopped it is below"
 * holds only when something is: the engine's summary or a conflict.
 */
export const FIRST_FAILED_KEYS = {
  timeout: "runErrors.CANDIDATES_FIRST_TIMEOUT",
  named: "runErrors.CANDIDATES_FIRST_FAILED",
  unnamed: "runErrors.CANDIDATES_FIRST_FAILED_UNNAMED",
} as const;

export function firstFailedKey(
  first: Pick<CandidateView, "solverStatus"> | undefined,
  somethingListed: boolean,
): string {
  if (first?.solverStatus === "TIMEOUT") return FIRST_FAILED_KEYS.timeout;
  return somethingListed ? FIRST_FAILED_KEYS.named : FIRST_FAILED_KEYS.unnamed;
}

/** A refusal today's basis would meet, by the code /check names. */
export const REFUSAL_KEYS: Readonly<Record<string, string>> = {
  STAFF_UNSTAFFED_REQUIREMENTS: "refusal.STAFF_UNSTAFFED_REQUIREMENTS",
  BLOCK_PARTLY_LOCKED_SUMMARY: "refusal.BLOCK_PARTLY_LOCKED_SUMMARY",
};

export function refusalKey(code: string): string {
  return REFUSAL_KEYS[code] ?? "refusal.other";
}

/**
 * Every refusal of the routes, by status and code (design §3 and §4), as
 * the key of its sentence. The status matters as much as the code: a 404 on
 * the start is "the batch to refresh is gone", on the apply "the candidate
 * is gone", and neither carries a code to tell them apart.
 */
export const REQUEST_ERROR_KEYS: Readonly<Record<string, string>> = {
  CANDIDATES_RUNNING: "errors.CANDIDATES_RUNNING",
  GENERATE_RUNNING: "errors.GENERATE_RUNNING",
  CANDIDATES_BUSY: "errors.CANDIDATES_BUSY",
  CANDIDATES_NEED_A_DRAFT: "errors.CANDIDATES_NEED_A_DRAFT",
  // The start, while an apply, a restore or a Generera rewrites the year.
  SCHEDULE_BUSY: "errors.SCHEDULE_BUSY",
  PUBLISH_MODE_CHANGED: "errors.PUBLISH_MODE_CHANGED",
  // The apply, while a publish (or a draft's discard or refill) holds the publication lock.
  PUBLISH_IN_PROGRESS: "errors.PUBLISH_IN_PROGRESS",
  SCHEDULE_CANDIDATE_BUSY: "errors.SCHEDULE_CANDIDATE_BUSY",
  SCHEDULE_CANDIDATE_NOT_APPLICABLE: "errors.SCHEDULE_CANDIDATE_NOT_APPLICABLE",
  SCHEDULE_CANDIDATE_STALE: "errors.SCHEDULE_CANDIDATE_STALE",
};

export function requestErrorKey(
  error: { status?: number; code?: string } | null | undefined,
  route: "start" | "apply" | "discard",
): string {
  if (!error) return "errors.generic";
  if (error.code && REQUEST_ERROR_KEYS[error.code]) return REQUEST_ERROR_KEYS[error.code]!;
  if (error.status === 429) return "errors.TOO_MANY";
  if (error.status === 404) return route === "apply" ? "errors.CANDIDATE_GONE" : route === "start" ? "errors.REFRESH_GONE" : "errors.generic";
  return "errors.generic";
}

/**
 * The parts a SCHEDULE_CANDIDATE_STALE names, if it named them. The gateway
 * forwards a refusal's params as it sent them, so a list may arrive as an
 * array or, flattened, as one comma-joined string.
 */
export function staleParts(params: Record<string, unknown> | null | undefined): string[] {
  const changed = params?.changed;
  if (Array.isArray(changed)) return changed.filter((part): part is string => typeof part === "string");
  if (typeof changed === "string" && changed.trim() !== "") return changed.split(",").map((part) => part.trim());
  return [];
}

/**
 * "+12", "−5" (a real minus), "±0": a delta that says which way it went in
 * characters, not colour. Judged on what the format prints, so a change of
 * 0.04 minutes shown to one decimal is "±0", never "+0".
 */
export function signed(value: number, format: (value: number) => string): string {
  const text = format(Math.abs(value));
  if (value === 0 || text === format(0)) return `±${format(0)}`;
  return value > 0 ? `+${text}` : `−${text}`;
}
