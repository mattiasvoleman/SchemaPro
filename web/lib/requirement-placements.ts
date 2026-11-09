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
  /**
   * Delade lektioner: whose lesson it is. Required (not null) on every row of
   * a post that shares its lessons between teachers; left out on a post that
   * shares nothing, whose teacher is the lesson's.
   */
  teacherId?: string | null;
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
  /** Null on a post that shares nothing, and on a shared post's lesson whose teacher was deleted since. */
  teacherId: string | null;
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
 *     BLOCK or POST, or one of Delade lektioner's: NO_TEACHER, TEACHER,
 *     TEACHER_LENGTH, TEACHER_PAIRS, TEACHER_COUNT. `params` is what came with
 *     it: from the PUT a per-teacher reason may carry `index`, the row's place
 *     in the list that was sent; from a change of the post's teacher or
 *     shares it carries `day`, `start`, `end` and `weeks`, which name the
 *     placement that has to be changed (or removed) first, and `requirementId`
 *     its post. A placement that names nobody because its teacher was removed
 *     (`unstaffed`) can only be removed: its reason reads UNSTAFFED.
 *   - ROW: the first row the judge refuses (REQUIREMENT_PLACEMENT_REFUSED).
 *     `index` is its place in the list that was sent, `reason` the judge's and
 *     `params` the rest of what the sentence is written from.
 *
 * The gateway's own sentence is Swedish; the reader's language is the web's
 * (requirements.placements.*).
 */
export type PlacementsRefusal =
  | { kind: "FIT"; reason: string; params: Record<string, string | number> }
  | { kind: "ROW"; index: number; reason: string; params: Record<string, string | number> };

export function placementsRefusal(error: unknown): PlacementsRefusal | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const params = error.params;
  if (error.code === "REQUIREMENT_PLACEMENTS_DO_NOT_FIT") {
    // A placement nobody teaches (its teacher removed) is one the change waits for that can only be removed.
    if (typeof params?.reason !== "string") return null;
    return { kind: "FIT", reason: params.unstaffed ? "UNSTAFFED" : params.reason, params };
  }
  if (error.code === "REQUIREMENT_PLACEMENT_REFUSED") {
    if (typeof params?.reason !== "string" || typeof params.index !== "number") return null;
    const { index, reason, ...rest } = params;
    return { kind: "ROW", index, reason: String(reason), params: rest };
  }
  return null;
}
