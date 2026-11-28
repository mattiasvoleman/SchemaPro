import { api, ApiError } from "@/lib/api";

/*
 * LÄGG DET SOM GÅR, AS THE PAGE READS IT (E7a).
 *
 * POST /api/v1/board-fill/propose (src/board-fill/) lays the bricks of Att lägga that were asked for (a class, a year or the school) one at a time on the
 * best free time each has, with a room, and answers how many fitted and why each of the others was not laid. It writes nothing. POST /api/v1/board-fill/apply
 * ("Ta in") writes the proposal as locked lessons after a version. The judge is the gateway's: nothing here decides what may stand, it says what the gateway
 * answered. And "går inte" is not a word of this answer: a brick that was not laid is "not laid by this", and only the engine can prove that it cannot be.
 */

export type FillScope = "CLASS" | "GRADE" | "SCHOOL";

/** A brick as the answer names it: ids only, the page finds the names in the lists it already reads. */
export interface FillBrickView {
  key: string;
  postId: string;
  studentGroupId: string;
  subjectId: string;
  teacherId: string | null;
  minutes: number;
  /** The lesson on the tray this brick is, or null. */
  lessonId: string | null;
}

export interface FillPlaced extends FillBrickView {
  dayOfWeek: number;
  startMinutes: number;
  endMinutes: number;
  roomId: string | null;
  /** "Utan sal": the school has no room the generator would put the lesson in. */
  noRoom: boolean;
}

export type FillLeftReason = "NO_FREE_START" | "JUDGE" | "TIME" | "BLOCK" | "NO_TEACHER";

export interface FillLeft extends FillBrickView {
  reason: FillLeftReason;
}

export interface FillProposal {
  academicYearId: string;
  answeredBy: "FILL";
  /** The grundschema the proposal was made on; Ta in gives it back. */
  basis: string;
  asked: number;
  placed: FillPlaced[];
  left: FillLeft[];
  /** The lessons the proposal moves: none, and a later PR's place. */
  moved: unknown[];
  /** The time ran out before every brick was begun. */
  truncated: boolean;
}

export interface FillApplied {
  academicYearId: string;
  versionId: string;
  laid: Array<{ key: string; lessonId: string; created: boolean; noRoom: boolean }>;
}

export interface FillRequest {
  academicYearId: string;
  scope: FillScope;
  studentGroupId?: string;
  gradeLevel?: number;
}

/** The proposal, or null for an answer that is not the gateway's (a proxy's page, an older gateway's body). */
export async function proposeFill(request: FillRequest, signal?: AbortSignal): Promise<FillProposal | null> {
  const answer = await api.post<FillProposal>("/api/v1/board-fill/propose", request, signal);
  return answer && typeof answer.basis === "string" && Array.isArray(answer.placed) && Array.isArray(answer.left) ? answer : null;
}

/** "Ta in": the proposal as it was read, with the basis it was made on. */
export function applyFill(proposal: FillProposal): Promise<FillApplied> {
  return api.post<FillApplied>("/api/v1/board-fill/apply", {
    academicYearId: proposal.academicYearId,
    basis: proposal.basis,
    items: proposal.placed.map((entry) => ({
      key: entry.key,
      dayOfWeek: entry.dayOfWeek,
      startTime: clockOf(entry.startMinutes),
      roomId: entry.roomId,
    })),
  });
}

/** "HH:MM" of a minute of the day. */
export function clockOf(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** The codes the gateway answers with that the page words itself. */
export const BOARD_FILL_STALE = "BOARD_FILL_STALE";
export const MASTER_LESSON_REFUSED = "MASTER_LESSON_REFUSED";
export const BOARD_ROOM_NOT_ALLOWED = "BOARD_ROOM_NOT_ALLOWED";

/** What a refused "Ta in" is, for the dialog to say and to offer the way on. */
export type FillFailure =
  /** The grundschema is not the one the proposal was made on: ask again. */
  | { kind: "STALE" }
  /** The judge refused a time it let through when the proposal was made (somebody laid something since): ask again. */
  | { kind: "REFUSED" }
  | { kind: "OTHER" };

export function fillFailureOf(error: unknown): FillFailure {
  if (!(error instanceof ApiError)) return { kind: "OTHER" };
  if (error.code === BOARD_FILL_STALE) return { kind: "STALE" };
  if (error.code === MASTER_LESSON_REFUSED || error.code === BOARD_ROOM_NOT_ALLOWED) return { kind: "REFUSED" };
  return { kind: "OTHER" };
}

/**
 * What the answer says in numbers, for the sentence "Lade 31 av 36. Ingenting annat flyttades.": how many were laid of how many were asked
 * about, and how many were left for each reason.
 */
export function fillFigures(proposal: FillProposal): { laid: number; asked: number; left: number; byReason: Partial<Record<FillLeftReason, number>> } {
  const byReason: Partial<Record<FillLeftReason, number>> = {};
  for (const entry of proposal.left) byReason[entry.reason] = (byReason[entry.reason] ?? 0) + 1;
  return { laid: proposal.placed.length, asked: proposal.asked, left: proposal.left.length, byReason };
}
