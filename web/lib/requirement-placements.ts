import { useQuery } from "@tanstack/react-query";
import { ApiError, api } from "@/lib/api";

/*
 * Förlagda poster, read and written: the lessons a school has placed on a
 * timplanspost by hand — a day, a start, a room (or none: the engine chooses it
 * at every Generera) and the weeks it runs — before Generera sends the posts to
 * the engine. The gateway's routes are
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
  /** Null or left out: the engine chooses the room at every Generera. A pair of odd and even weeks needs a room on both halves. */
  roomId?: string | null;
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
  /** Null: the school left the room to the engine. */
  roomId: string | null;
  roomName: string | null;
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
  | "OVER_DEMAND"
  // A half of a pair names no room; the post is in a parallel block (only a row another writer stored reaches the judge with them).
  | "PAIR_ROOM"
  | "BLOCK";

/** The judge's verdict on the row at `index`; `reason` and `params` only when it does not hold. */
export interface PlacementVerdict {
  index: number;
  ok: boolean;
  reason?: PlacementRefusalReason;
  params?: Record<string, string | number>;
}

/**
 * What the week the school has fixed says about a row without refusing it (the gateway's placement-warnings.ts). A code this build
 * has no sentence for is read as the general one (placement-warnings.ts sentenceOfWarning): the gateway deploys apart from the web.
 */
export type PlacementWarningCode =
  | "TEACHER_DAY_TOO_LONG"
  | "TEACHER_WEEK_TOO_MANY_DAYS"
  | "TEACHER_WEEK_TOO_MANY_DAYS_HIDDEN"
  | "TEACHER_STRETCH_TOO_LONG"
  | "TEACHER_STRETCH_TOO_LONG_HIDDEN"
  | "CLASS_HAS_NO_LUNCH"
  | "NO_ROOM_FREE";

/**
 * One warning on one row, the row named by its id in the SAME answer (a post's row, or a block's lesson): every save gives the rows new
 * ids, so a warning is joined to a card through the answer it came in and never kept across a write.
 */
export interface PlacementWarning {
  code: PlacementWarningCode;
  /** True: Generera will refuse the week because of this. False: this does not stop it (no promise that nothing else does). */
  refuses: boolean;
  /** `day` is ISO 1..5; the `_HIDDEN` codes carry none. */
  params?: Record<string, string | number>;
  rowId: string;
  /** The post's id; for a block's lesson, the member's. */
  requirementId: string;
  /** Set for a block's lesson. */
  blockId?: string;
}

/** GET /:id/placements and the 200 of the PUT: the rows and a verdict per row, in the same order. */
export interface PlacementsOfRequirement {
  placements: RequirementPlacement[];
  verdicts: PlacementVerdict[];
  /** The key of these rows: what the next write on top of them sends as `baseKey`. */
  rowsKey: string;
  /** What the week says of the rows, at their places in this answer. Absent from a gateway before D1. */
  warnings?: PlacementWarning[];
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
 *     PAIR_ROOM (a half of a pair names no room), BLOCK or POST, or one of Delade lektioner's: NO_TEACHER, TEACHER,
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
