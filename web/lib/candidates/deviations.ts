import type { CandidateCheck, CandidateConflict, CandidateView } from "./types";

/*
 * Bästa möjliga schema, as the compare page reads a candidate: which rules gave
 * way, and what an apply of it has to have accepted. Beside labels.ts and not
 * in it, because the generate page imports labels.ts and has no use for these:
 * a module shared by two routes is carried whole by both.
 */

/**
 * The avsteg a candidate marks: the list the mode stored, when it has an
 * entry. NULL (the candidate did not come from the mode, or an older gateway
 * sent no field) and EMPTY (the mode ran and nothing gave way) are both no
 * deviation, so neither is marked "Med avsteg".
 */
export function deviationsOf(candidate: Pick<CandidateView, "deviations">): readonly CandidateConflict[] {
  return candidate.deviations ?? [];
}

/** Whether the candidate came from the mode at all: a list, even an empty one, says it ran. */
export function ranBestEffort(candidate: Pick<CandidateView, "deviations">): boolean {
  return candidate.deviations !== null && candidate.deviations !== undefined;
}

/**
 * What an apply of this candidate has to have accepted. The candidate's own
 * list first: it is stored once and never changes, and a check is the run's.
 * The check's reading is the fallback for a candidate the overview was read
 * without it.
 */
export function deviationsToAccept(
  candidate: Pick<CandidateView, "deviations">,
  check: Pick<CandidateCheck, "deviations"> | null,
): readonly CandidateConflict[] {
  return candidate.deviations ?? check?.deviations ?? [];
}

/**
 * The digest an apply hands back as `acceptedDeviations`, and only for a
 * candidate that has deviations to accept: a candidate without any takes no
 * digest, and one sent regardless is a body the gateway need not accept.
 */
export function acceptedDeviationsOf(
  candidate: Pick<CandidateView, "deviations" | "deviationsDigest">,
  check: Pick<CandidateCheck, "deviations" | "deviationsDigest"> | null,
): string | null {
  if (deviationsToAccept(candidate, check).length === 0) return null;
  return candidate.deviationsDigest ?? check?.deviationsDigest ?? null;
}
