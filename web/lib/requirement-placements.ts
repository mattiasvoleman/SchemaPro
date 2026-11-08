import { useQuery } from "@tanstack/react-query";
import { ApiError, api } from "@/lib/api";

/*
 * Förlagda poster, read and written: the lessons a school has placed on a
 * timplanspost by hand — a day, a start, a room and the weeks it runs — before
 * Generera sends the posts to the engine. The gateway's routes are
 * /teaching-requirements/placements (the year, for the mark on the timplan)
 * and /teaching-requirements/:id/placements (one post: its rows and each
 * row's verdict; PUT replaces them).
 *
 * THREE MODULES, for the timplan page's bundle: this one is what the page
 * imports (the types, the year's read for the mark, the grouping and how a 409
 * is read), and it has no bytes to spare. What only the dialog needs is apart:
 * the reads and the write of one post (requirement-placements-api.ts) and the
 * sentences (requirement-placement-text.ts). The dialog is fetched on the first
 * press of Förlägg.
 */

/** The prefix react-query invalidates on: every read of a post's placements. */
export const REQUIREMENT_PLACEMENTS_KEY = ["requirementPlacements"] as const;

export type PlacementRecurrence = "ALL_WEEKS" | "ODD_WEEKS" | "EVEN_WEEKS";

/** One placed lesson as the PUT takes it. */
export interface PlacementInput {
  /** 1..5, Monday to Friday. */
  dayOfWeek: number;
  /** HH:MM on the five-minute grid. */
  startTime: string;
  /** One of the post's lengths. */
  minutes: number;
  roomId: string;
  recurrence: PlacementRecurrence;
}

/** One placed lesson as the gateway answers it. */
export interface RequirementPlacement {
  id: string;
  requirementId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  minutes: number;
  roomId: string;
  roomName: string;
  recurrence: PlacementRecurrence;
}

/** Why a placed lesson cannot stand where it is (the gateway's judge, placement-judge.ts). */
export type PlacementRefusalReason =
  | "TEACHER"
  | "ROOM"
  | "GROUP"
  | "PUPILS"
  | "AVAILABILITY"
  | "FRAME"
  | "LUNCH"
  | "GRADE_RULE"
  | "OTHER_SCHOOL"
  | "SCHOOL_DAY"
  | "OVER_DEMAND";

/** The judge's verdict on the row at `index`; `reason` and `params` only when it does not hold. */
export interface PlacementVerdict {
  index: number;
  ok: boolean;
  reason?: PlacementRefusalReason;
  params?: Record<string, string | number>;
}

/** GET /:id/placements and the 200 of the PUT: the rows and a verdict per row, in the same order. */
export interface PlacementsOfRequirement {
  placements: RequirementPlacement[];
  verdicts: PlacementVerdict[];
}

/** The year's placed lessons, for the mark on the timplan. */
export function useRequirementPlacements(academicYearId: string | null) {
  return useQuery({
    queryKey: [...REQUIREMENT_PLACEMENTS_KEY, academicYearId],
    enabled: academicYearId !== null,
    queryFn: () =>
      api.get<RequirementPlacement[]>(
        `/api/v1/teaching-requirements/placements?academicYearId=${encodeURIComponent(academicYearId!)}`,
      ),
  });
}

/** The year's rows by post, in the order the gateway answers them (day, then start). */
export function placementsByRequirement(
  rows: readonly RequirementPlacement[] | undefined,
): Map<string, RequirementPlacement[]> {
  const byPost = new Map<string, RequirementPlacement[]>();
  for (const row of rows ?? []) {
    const list = byPost.get(row.requirementId);
    if (list) list.push(row);
    else byPost.set(row.requirementId, [row]);
  }
  return byPost;
}

/**
 * What a 409 on a post's placements says, or null for any other error:
 *
 *   - FIT: the rows do not fit the post (REQUIREMENT_PLACEMENTS_DO_NOT_FIT),
 *     whether it was the PUT of rows that did not fit it or a change of the
 *     post the rows no longer fit. `reason` is LENGTH, COUNT, WEEKS, PAIRS,
 *     BLOCK, SHARES or POST.
 *   - ROW: the first row the judge refuses (REQUIREMENT_PLACEMENT_REFUSED).
 *     `index` is its place in the list that was sent, `reason` the judge's and
 *     `params` the rest of what the sentence is written from.
 *
 * The gateway's own sentence is Swedish; the reader's language is the web's
 * (requirements.placements.*).
 */
export type PlacementsRefusal =
  | { kind: "FIT"; reason: string }
  | { kind: "ROW"; index: number; reason: string; params: Record<string, string | number> };

export function placementsRefusal(error: unknown): PlacementsRefusal | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const params = error.params;
  if (error.code === "REQUIREMENT_PLACEMENTS_DO_NOT_FIT") {
    return typeof params?.reason === "string" ? { kind: "FIT", reason: params.reason } : null;
  }
  if (error.code === "REQUIREMENT_PLACEMENT_REFUSED") {
    if (typeof params?.reason !== "string" || typeof params.index !== "number") return null;
    const { index, reason, ...rest } = params;
    return { kind: "ROW", index, reason: String(reason), params: rest };
  }
  return null;
}
