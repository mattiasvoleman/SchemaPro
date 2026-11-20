import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import type { ChoiceCount } from "@/lib/week-check-choice";

/*
 * Föreslå bemanning, veckan före och efter (POST /optimization/staffing/proposal/week). Its own file, loaded with the
 * panel (components/staffing/staffing-week.tsx, behind the dialog's own lazy import): nothing of it is in the
 * staffing page's chunk. Mirrored by hand in src/optimization/interfaces/staffing-week.interface.ts.
 *
 * ADVICE, NOT A GATE. A figure that could not be made is an answer of its own, and so is a request that failed: the
 * hook never throws, so the proposal and its apply go on without it.
 *
 * THE FIGURES ARE THE ENGINE'S OWN ChoiceCounts, so what week-check-choice.ts says of them holds: each is a lower
 * bound on the tightest period of its year, a figure over the supply is only the first period the engine refused,
 * and a count the engine's seconds cut is "at least". The gateway has already said how a year after stands to the
 * year before (`verdict`); nothing here compares two figures again.
 */

/** The ChoiceCount mirror and its period live in lib/week-check-choice.ts; only types come from it, which cost nothing at runtime. */
export type { ChoiceCount, ChoicePeriod } from "@/lib/week-check-choice";

export type StaffingWeekVerdict = "TIGHTER" | "LOOSER" | "SAME" | "STILL_OVER" | "NEWLY_REFUSED" | "NOT_COMPARED";

export type StaffingWeekReason = "NO_CHANGES" | "NOT_READY" | "NO_POSTS" | "ENGINE_OLDER" | "ENGINE_ERROR" | "TOO_SLOW";

export interface StaffingWeekYear {
  /** In the läsår's own numbering. */
  year: number;
  before: ChoiceCount;
  after: ChoiceCount;
  verdict: StaffingWeekVerdict;
}

export interface StaffingWeekOverlay {
  given: number;
  laidOver: number;
  notLaidOver: number;
  /** Of the laid-over changes, the posts nobody teaches today: their week before is counted with no teacher on them. */
  fromNobody: number;
  /** Teachers who have nothing else in the week's payload: the week after counts only their new posts. */
  newToTheWeek: number;
}

export interface StaffingWeekView {
  status: "DONE" | "NOT_CHECKED";
  reason?: StaffingWeekReason;
  years: StaffingWeekYear[];
  verdicts: { before: "OK" | "TIGHT" | "IMPOSSIBLE"; after: "OK" | "TIGHT" | "IMPOSSIBLE" } | null;
  /** The proposal makes the week provably tighter in some year, or makes the engine refuse it. */
  worse: boolean;
  /** The basis an apply carries when this figure was shown (the proposal's and the week's); null when none was made. */
  basisSha256: string | null;
  overlay: StaffingWeekOverlay;
  calls: number;
  elapsedMs: number;
}

/** One change of the part of the proposal that is selected: the post, and its lead from and to. */
export interface StaffingWeekChange {
  requirementId: string;
  fromTeacherId: string | null;
  toTeacherId: string;
}

export interface StaffingWeekRequest {
  academicYearId: string;
  /** The basis the proposal returned. */
  basisSha256: string;
  changes: StaffingWeekChange[];
}

/** What an ask came to: never an exception. */
export type StaffingWeekOutcome =
  | { kind: "result"; view: StaffingWeekView }
  | { kind: "unavailable"; reason: "ENGINE_OLDER" | "THROTTLED" | "STALE" | "ERROR" };

/**
 * The longest the question is waited for. The gateway gives it a budget of thirty seconds (two checks of the engine,
 * STAFFING_WEEK_BUDGET_MS) and begins none it could not finish inside it; this is a little over that, and under a
 * minute: it is asked when a proposal appears and again when the selection settles, and the dialog works meanwhile.
 */
export const STAFFING_WEEK_WAIT_MS = 40_000;

/** The gateway's code for a proposal that has gone old (the apply's own). */
const STAFF_PROPOSAL_STALE = "STAFF_PROPOSAL_STALE";

function waitOf(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(ms)
    : undefined;
}

export function classifyStaffingWeekError(error: unknown): StaffingWeekOutcome {
  if (error instanceof ApiError) {
    // An API that predates the route answers Nest's own 404 (this page can be deployed first).
    if (error.status === 404 && /^Cannot POST /.test(error.message)) return { kind: "unavailable", reason: "ENGINE_OLDER" };
    if (error.status === 429) return { kind: "unavailable", reason: "THROTTLED" };
    if (error.status === 409 && error.code === STAFF_PROPOSAL_STALE) return { kind: "unavailable", reason: "STALE" };
  }
  return { kind: "unavailable", reason: "ERROR" };
}

export async function askStaffingWeek(request: StaffingWeekRequest): Promise<StaffingWeekOutcome> {
  try {
    const view = await api.post<StaffingWeekView>(
      "/api/v1/optimization/staffing/proposal/week",
      request,
      waitOf(STAFFING_WEEK_WAIT_MS),
    );
    return { kind: "result", view };
  } catch (error) {
    return classifyStaffingWeekError(error);
  }
}

/** The key a selection is asked under: the posts and the lead each is given, in the order of their ids, so a ticked-and-unticked row is the same question. */
export function changesKey(changes: readonly StaffingWeekChange[]): string {
  return changes
    .map((change) => `${change.requirementId}>${change.toTeacherId}`)
    .sort()
    .join(",");
}

/**
 * The week before and after for a request, asked when there is one (null: not yet) and kept for the same question of the
 * same proposal: a selection that comes back is not asked twice. Never retried, and never an error: a failed ask is an outcome.
 */
export function useStaffingWeek(request: StaffingWeekRequest | null, serial: number) {
  const query = useQuery({
    // `serial` is the proposal on the screen: the same proposal asked again (Beräkna igen) is a new question, because the
    // week may have moved without the tjänstefördelning moving, and an answer kept from before carries a digest of the old one.
    queryKey: ["staffing-week", serial, request?.academicYearId, request?.basisSha256, request ? changesKey(request.changes) : null],
    queryFn: () => askStaffingWeek(request!),
    enabled: request !== null,
    retry: false,
    // The figure belongs to the week as it was when it was asked: asking again is the admin's, by pressing Beräkna igen.
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  return { outcome: query.data ?? null, isPending: request !== null && query.data === undefined };
}
