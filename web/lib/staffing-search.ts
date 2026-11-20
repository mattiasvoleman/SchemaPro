import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import type { StaffingProposal } from "@/app/[locale]/(app)/admin/staffing/use-staffing-proposal";

/*
 * Föreslå bemanning, sökningen efter lärarval (lärarval F3): the gateway's staffing-search.controller.ts, routes under
 * /api/v1/optimization/staffing/search. Its own file, loaded with the panel (components/staffing/staffing-search.tsx,
 * behind the dialog's own lazy import): nothing of it is in the staffing page's chunk, and nothing here is in lib/queries.ts.
 * The shapes are mirrored by hand from src/optimization/interfaces/staffing-search.interface.ts, and the codes from
 * src/optimization/staffing-search.service.ts: a field or a code renamed on one side only is a missing sentence here.
 *
 * A SEARCH IS A JOB, NOT A REQUEST. It takes minutes, in the API process that took the start, and its row is durable: the
 * page starts it, reads it, can stop it, and reads the proposal it gave once it has ended. It is read through
 * `GET .../latest` and not by id: one search is active per year, the year's newest run is the only one the dialog
 * ever asks about, and a finished run that a newer start has replaced is then never a 404 mid-poll.
 *
 * THE POLL IS BOUNDED THREE WAYS. It runs only while the run is PENDING, RUNNING or CANCELLING; it stops for good when the
 * run has ended (nothing is read again but by the admin); and a read that failed does not turn into a loop: a failure is
 * retried twice, a second apart, and then the poll waits for the admin (the panel's "Försök igen", or the window's
 * focus). react-query drops the interval with the last observer, so a panel that is closed polls nothing, and the
 * search goes on at the gateway without it.
 */

export type StaffingSearchStatus = "PENDING" | "RUNNING" | "CANCELLING" | "SUCCEEDED" | "CANCELLED" | "FAILED";

/** Why a search stopped (the gateway's StaffingSearchStop). */
export type StaffingSearchStop =
  | "NOT_TIGHT"
  | "LOCAL_OPTIMUM"
  | "NO_MOVES"
  | "CANCELLED"
  | "BUDGET"
  | "MAX_ROUNDS"
  | "MAX_EVALUATIONS"
  | "ENGINE_OLDER"
  | "ENGINE_BUSY"
  | "ENGINE_FAILING";

export interface StaffingSearchCell {
  demandMinutes: number;
  capacityMinutes: number;
}

/** One real week's figure in a judged year, before the search and as far as it has come. Minutes and week keys only. */
export interface StaffingSearchWeekFigure {
  period: number | null;
  parity: "ODD_WEEKS" | "EVEN_WEEKS" | null;
  from: string | null;
  to: string | null;
  before: StaffingSearchCell;
  after: StaffingSearchCell;
}

export interface StaffingSearchYearFigures {
  /** In the läsår's own numbering: the gateway has turned the engine's. */
  year: number;
  weeks: StaffingSearchWeekFigure[];
}

/**
 * Why a post was not searched (the gateway's StaffingSearchLeftOutPostReason), each post under the one reason that kept it:
 * NOT_FREE (not released for the engine, or pinned in the dialog), UNSTAFFED (nobody leads it: Föreslå bemannings fråga),
 * NO_CHOICE (nobody else may lead it), NOT_IN_WEEK (the week holds none of its lessons, or its years are unknown),
 * YEAR_LIMIT (a year it spans is not among the four tightest) and YEAR_NOT_COUNTED (a year it spans could not be counted to
 * the end as it stands).
 */
export type StaffingSearchLeftOutPostReason = "NOT_FREE" | "UNSTAFFED" | "NO_CHOICE" | "NOT_IN_WEEK" | "YEAR_LIMIT" | "YEAR_NOT_COUNTED";
export type StaffingSearchLeftOutYearReason = "YEAR_LIMIT" | "YEAR_NOT_COUNTED";

/** What the search did not move, and why: nothing it leaves out is left out in silence. */
export interface StaffingSearchLeftOut {
  /** Only the reasons that have posts, in the gateway's order. */
  posts: { reason: StaffingSearchLeftOutPostReason; count: number }[];
  /** The years a post with a choice spans that were not judged, ascending, in the läsår's own numbering (as `StaffingSearchYearFigures.year`). */
  years: { year: number; reason: StaffingSearchLeftOutYearReason }[];
}

export interface StaffingSearchFiguresDoc {
  years: StaffingSearchYearFigures[];
  leftOut: StaffingSearchLeftOut;
}

export interface StaffingSearchTally {
  better: number;
  notBetter: number;
  worse: number;
  refused: number;
  unranked: number;
}

/** The run as a poll reads it: no proposal, which is its own route, read once when the run has ended. */
export interface StaffingSearchView {
  id: string;
  academicYearId: string;
  status: StaffingSearchStatus;
  stopReason: StaffingSearchStop | null;
  /** The search's own time budget and how much of it has been used (waiting for a Generera run is not counted). */
  budgetMs: number;
  elapsedMs: number;
  round: number;
  evaluations: number;
  acceptedMoves: number;
  figures: StaffingSearchFiguresDoc | null;
  tally: StaffingSearchTally | null;
  errorCode: string | null;
  errorParams: Record<string, string | number> | null;
  /** The gateway's English: a log line, never what the page says. */
  error: string | null;
  /** At least one move was accepted AND the run has ended: never true while it goes on. */
  hasProposal: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface StartStaffingSearchRequest {
  academicYearId: string;
  /** Posts the admin asked the dialog to keep as they are; left out when there are none. */
  pinnedRequirementIds?: string[];
}

/** An ordinary proposal, and the figures the run kept: the proposal is the dialog's to show, apply and ask the week about. */
export interface StaffingSearchProposal {
  proposal: StaffingProposal;
  figures: StaffingSearchFiguresDoc | null;
}

/** The gateway's refusals of a start (409, src/optimization/staffing-search.service.ts). */
export const STAFFING_SEARCH_ALREADY_RUNNING = "STAFFING_SEARCH_ALREADY_RUNNING";
export const STAFFING_SEARCH_NO_QUALIFICATIONS = "STAFFING_SEARCH_NO_QUALIFICATIONS";
export const STAFFING_SEARCH_NOT_READY = "STAFFING_SEARCH_NOT_READY";
export const STAFFING_SEARCH_NO_POSTS = "STAFFING_SEARCH_NO_POSTS";
/** The run is gone (404), a proposal read before the run has ended (409), and a run that found nothing to propose (404). */
export const STAFFING_SEARCH_GONE = "STAFFING_SEARCH_GONE";
export const STAFFING_SEARCH_NOT_DONE = "STAFFING_SEARCH_NOT_DONE";
export const STAFFING_SEARCH_NO_PROPOSAL = "STAFFING_SEARCH_NO_PROPOSAL";
/** A proposal gone old: the tjänstefördelning, the releases or the week has changed since the search read them (the apply's own code). */
export const STAFF_PROPOSAL_STALE = "STAFF_PROPOSAL_STALE";

/** How a failed run is worded (its `errorCode`). */
export const SEARCH_ABANDONED = "SEARCH_ABANDONED";
export const SEARCH_INTERRUPTED = "SEARCH_INTERRUPTED";
export const SEARCH_START_REFUSED = "SEARCH_START_REFUSED";
export const SEARCH_START_NOT_EXACT = "SEARCH_START_NOT_EXACT";
export const SEARCH_ENGINE_OLDER = "SEARCH_ENGINE_OLDER";
export const SEARCH_ENGINE_FAILING = "SEARCH_ENGINE_FAILING";
export const SEARCH_ENGINE_BUSY = "SEARCH_ENGINE_BUSY";
export const SEARCH_FAILED = "SEARCH_FAILED";

/** How often an active run is read: a search is minutes, and a figure moves only when a move is accepted. */
export const STAFFING_SEARCH_POLL_MS = 3_000;
/** A failed read is tried again this soon, twice, and then waits for the admin. */
const RETRY_DELAY_MS = 1_500;
const MAX_READ_RETRIES = 2;

/** Every query of this feature starts with it. */
export const STAFFING_SEARCH_KEY = ["staffingSearch"] as const;
export const latestSearchKey = (academicYearId: string | null) => [...STAFFING_SEARCH_KEY, "latest", academicYearId] as const;

const SEARCH_PATH = "/api/v1/optimization/staffing/search";

/** A run the task still holds: read it again. Every other status is an end. */
export function isActiveSearch(status: StaffingSearchStatus | null | undefined): boolean {
  return status === "PENDING" || status === "RUNNING" || status === "CANCELLING";
}

/**
 * The year's newest search, or null when it has none. Polled while that search is active and only then, and never after a
 * read has failed through its retries: the admin's "Försök igen" (or the window coming back into focus) reads it again, and a
 * read that succeeds takes the poll up where it was.
 */
export function useLatestStaffingSearch(academicYearId: string | null) {
  return useQuery({
    queryKey: latestSearchKey(academicYearId),
    enabled: academicYearId !== null,
    queryFn: async () =>
      // A handler that returns null leaves Nest a 200 with no body, which api reads as undefined: "no search yet" is null here.
      (await api.get<StaffingSearchView | null>(`${SEARCH_PATH}/latest?academicYearId=${encodeURIComponent(academicYearId!)}`)) ?? null,
    refetchInterval: (query) =>
      query.state.status !== "error" && isActiveSearch(query.state.data?.status) ? STAFFING_SEARCH_POLL_MS : false,
    // A 4xx is an answer (a year that is gone, a refused login), never a blip: not asked again.
    retry: (failures, error) => failures < MAX_READ_RETRIES && !(error instanceof ApiError && error.status >= 400 && error.status < 500),
    retryDelay: RETRY_DELAY_MS,
  });
}

/**
 * POST staffing/search: a run, and its id. Never retried: a 409 is an answer, and the route is throttled to three a minute.
 * Whatever the outcome the year's newest run is read again: a start that went through is the run the panel shows, and one
 * refused because a search is already going (409) is how the panel finds that one.
 */
export function useStartStaffingSearch() {
  const queryClient = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: (body: StartStaffingSearchRequest) => api.post<{ runId: string }>(SEARCH_PATH, body),
    onSettled: (_data, _error, body) => queryClient.invalidateQueries({ queryKey: latestSearchKey(body.academicYearId) }),
  });
}

/**
 * POST staffing/search/:id/cancel: the run as it stands (CANCELLING, until its task sees it a few seconds on), put where the
 * poll reads it so that the panel says so at once and the poll goes on until the run has ended. A cancel that failed leaves
 * the panel to read the run again.
 */
export function useCancelStaffingSearch() {
  const queryClient = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: (runId: string) => api.post<StaffingSearchView>(`${SEARCH_PATH}/${encodeURIComponent(runId)}/cancel`),
    onSuccess: (view) => queryClient.setQueryData(latestSearchKey(view.academicYearId), view),
    onError: () => queryClient.invalidateQueries({ queryKey: STAFFING_SEARCH_KEY }),
  });
}

/**
 * GET staffing/search/:id/proposal: read when the admin asks, once the run has ended. A mutation and not a query: it is
 * an act with an answer to hand over (the dialog takes the proposal), never something to keep fresh, and a second press
 * is the admin's to make.
 */
export function useStaffingSearchProposal() {
  return useMutation({
    retry: false,
    mutationFn: (runId: string) => api.get<StaffingSearchProposal>(`${SEARCH_PATH}/${encodeURIComponent(runId)}/proposal`),
  });
}

/** What stopped a start: the refusals the panel words each in a sentence of its own, and the rest by what the gateway said. */
export type StartProblem =
  | { kind: "ALREADY_RUNNING" | "NO_QUALIFICATIONS" | "NOT_READY" | "NO_POSTS" | "THROTTLED" | "UNAVAILABLE" }
  | { kind: "OTHER"; message: string; code: string | null; params: Record<string, string | number> | null };

export function classifyStartError(error: unknown): StartProblem {
  if (error instanceof ApiError) {
    if (error.code === STAFFING_SEARCH_ALREADY_RUNNING) return { kind: "ALREADY_RUNNING" };
    if (error.code === STAFFING_SEARCH_NO_QUALIFICATIONS) return { kind: "NO_QUALIFICATIONS" };
    if (error.code === STAFFING_SEARCH_NOT_READY) return { kind: "NOT_READY" };
    if (error.code === STAFFING_SEARCH_NO_POSTS) return { kind: "NO_POSTS" };
    if (error.status === 429) return { kind: "THROTTLED" };
    if (error.status === 502 || error.status === 503) return { kind: "UNAVAILABLE" };
    return { kind: "OTHER", message: error.message, code: error.code ?? null, params: error.params ?? null };
  }
  return { kind: "OTHER", message: "", code: null, params: null };
}

/** What stopped the read of a proposal. STALE is the one the admin can do something about: search again. */
export type ProposalProblem =
  | { kind: "STALE" | "GONE" | "NOT_DONE" | "NO_PROPOSAL" }
  | { kind: "OTHER"; message: string };

export function classifyProposalError(error: unknown): ProposalProblem {
  if (error instanceof ApiError) {
    if (error.code === STAFF_PROPOSAL_STALE) return { kind: "STALE" };
    if (error.code === STAFFING_SEARCH_GONE) return { kind: "GONE" };
    if (error.code === STAFFING_SEARCH_NOT_DONE) return { kind: "NOT_DONE" };
    if (error.code === STAFFING_SEARCH_NO_PROPOSAL) return { kind: "NO_PROPOSAL" };
    return { kind: "OTHER", message: error.message };
  }
  return { kind: "OTHER", message: "" };
}

// ---------------------------------------------------------------------------
// How a run that has ended is worded

/** The codes of a failed run the panel has a sentence for; any other is worded as SEARCH_FAILED. */
const FAILED_CODES: ReadonlySet<string> = new Set([
  SEARCH_ABANDONED,
  SEARCH_INTERRUPTED,
  SEARCH_START_REFUSED,
  SEARCH_START_NOT_EXACT,
  SEARCH_ENGINE_OLDER,
  SEARCH_ENGINE_FAILING,
  SEARCH_ENGINE_BUSY,
  SEARCH_FAILED,
]);

/** The key of the sentence for a failed run (staffing.search.failed.*). */
export function failedKey(view: StaffingSearchView): string {
  const code = view.errorCode;
  if (code !== null && FAILED_CODES.has(code)) return code;
  if (view.stopReason === "ENGINE_OLDER") return SEARCH_ENGINE_OLDER;
  if (view.stopReason === "ENGINE_FAILING") return SEARCH_ENGINE_FAILING;
  if (view.stopReason === "ENGINE_BUSY") return SEARCH_ENGINE_BUSY;
  return SEARCH_FAILED;
}

/** The key of the sentence for a run that ended without failing (staffing.search.ended.*): the stop's own, and its "nothing found" form. */
export function endedKey(view: StaffingSearchView): string {
  const stop = view.status === "CANCELLED" ? "CANCELLED" : view.stopReason;
  const found = view.acceptedMoves > 0;
  switch (stop) {
    case "NOT_TIGHT":
    case "NO_MOVES":
      return stop;
    case "LOCAL_OPTIMUM":
    case "BUDGET":
    case "MAX_ROUNDS":
    case "MAX_EVALUATIONS":
    case "CANCELLED":
      return found ? stop : `${stop}_NONE`;
    default:
      return "DONE";
  }
}

// ---------------------------------------------------------------------------
// What the figures say, in the numbers the panel prints

/**
 * A year's tightest week on one side of the search, as a percent of that week's own supply: the largest share, compared by
 * cross-multiplying the minutes as the search itself does, so that nothing is rounded before two weeks are ordered. A week
 * with no supply has no share and is left out; null when no week has one.
 */
export function tightestPercent(weeks: readonly StaffingSearchWeekFigure[], side: "before" | "after"): number | null {
  let best: StaffingSearchCell | null = null;
  for (const week of weeks) {
    const cell = week[side];
    if (!(cell.capacityMinutes > 0)) continue;
    if (best === null || cell.demandMinutes * best.capacityMinutes > best.demandMinutes * cell.capacityMinutes) best = cell;
  }
  return best === null ? null : (best.demandMinutes / best.capacityMinutes) * 100;
}

export interface YearLine {
  year: number;
  /** The tightest week before the search, and as far as it has come (equal to `before` when no move was accepted), in percent. */
  before: number;
  after: number;
}

/** The judged years, lowest year first, each with its tightest week before and now. A year without a figure is not a line. */
export function yearLines(figures: StaffingSearchFiguresDoc | null): YearLine[] {
  if (!figures) return [];
  return figures.years
    .flatMap((entry) => {
      const before = tightestPercent(entry.weeks, "before");
      const after = tightestPercent(entry.weeks, "after");
      return before === null || after === null ? [] : [{ year: entry.year, before, after }];
    })
    .sort((a, b) => a.year - b.year);
}

/** One line of what the search left out: a count of posts under a reason, or a year that was not judged. */
export type LeftOutLine =
  | { kind: "posts"; reason: StaffingSearchLeftOutPostReason; count: number }
  | { kind: "year"; reason: StaffingSearchLeftOutYearReason; year: number };

/**
 * What the search left out, as the lines to print: a line for each reason that has posts (the gateway's order), then one for
 * each year that was not judged, lowest first. Empty when nothing was left out, and for a run with no figures yet.
 */
export function leftOutLines(leftOut: StaffingSearchLeftOut | null | undefined): LeftOutLine[] {
  if (!leftOut) return [];
  return [
    ...leftOut.posts.filter((entry) => entry.count > 0).map((entry): LeftOutLine => ({ kind: "posts", reason: entry.reason, count: entry.count })),
    ...[...leftOut.years].sort((a, b) => a.year - b.year).map((entry): LeftOutLine => ({ kind: "year", reason: entry.reason, year: entry.year })),
  ];
}

/** Whole minutes and the seconds over, of a time in milliseconds (rounded to the second, never negative). */
export function splitDuration(ms: number): { minutes: number; seconds: number } {
  const total = Math.max(0, Math.round(ms / 1000));
  return { minutes: Math.floor(total / 60), seconds: total % 60 };
}
