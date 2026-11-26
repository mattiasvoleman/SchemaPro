/*
 * Ett schema som start (omgång 15, M9): the types of Generera's choice of where to start, and of what a run says it did with it.
 * Types only, so that the page and the query module can name them for nothing: what draws the choice and the sentence about it is
 * app/[locale]/(app)/admin/generate/start-from.tsx, behind a lazy import.
 *
 * The shapes are the gateway's (src/optimization/start-schedule.ts): the request's `startFrom` and the job's `startedFrom`.
 */

/** Where a run starts from: this year's grundschema as it stands, last year's, or a saved version of this year. */
export type StartSource = "CURRENT" | "PREVIOUS_YEAR" | "VERSION";

/** The request's choice. Absent starts from nothing, as Generera always did. */
export interface StartFrom {
  source: StartSource;
  /** The saved version, for VERSION and for no other source. */
  versionId?: string;
}

/** Why a lesson of the schedule was not given as a start (a closed set, each with a sentence in the catalogue). */
export type StartDropReason =
  | "NO_SUCCESSOR"
  | "NO_POST"
  | "NOT_IN_WEEK"
  | "OTHER_WEEKS"
  | "AMBIGUOUS"
  | "NOT_STARTABLE"
  | "MORE_THAN_ASKED";

/**
 * What a finished run did with the schedule it was asked to start from. `held`, `moved` and `laid` are null when the run laid no
 * timetable (a refusal, a TIMEOUT) and when the engine was older than the field (`engine` OLDER): the week was then laid from
 * nothing and the page says so. Absent from a gateway before M9, and null for a run that started from nothing.
 */
export interface StartedFrom {
  source: StartSource;
  versionName: string | null;
  engine: "USED" | "OLDER";
  offered: number;
  used: number;
  held: number | null;
  moved: number | null;
  laid: number | null;
  dropped: Partial<Record<StartDropReason, number>>;
}
