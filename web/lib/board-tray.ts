import { api, ApiError } from "@/lib/api";
import { exemptableReasons, type ExemptRule } from "@/lib/exemptions";
import type { LessonRecurrence } from "@/lib/types";

/*
 * ATT LÄGGA, AS THE PAGE READS IT (E4).
 *
 * GET /api/v1/board-tray (src/board-tray/) answers with one BRICK for each lesson a timplanspost has left, counted as Generera counts it, and
 * the head's figures. POST /api/v1/board-tray/lay lays one: the brick becomes a locked lesson (or the parked lesson that is the brick is moved
 * back), judged as a hand edit is. Nothing here decides what may stand: the gateway counts the bricks, ranks the times and judges the lay, and
 * this only says what it answered.
 */

/** One lesson still to lay (src/board-tray/board-tray.service.ts, TrayBrick). */
export interface TrayBrick {
  postId: string;
  nth: number;
  /** The picture of the brick's part it was read in: a lay names it, and is refused when it is another now. */
  partKey: string;
  /** A lesson on the tray (parkeringen) is a brick, namely itself: laying it moves it back. */
  lessonId: string | null;
  studentGroupId: string;
  subjectId: string;
  teacherId: string | null;
  coTeacherId: string | null;
  minutes: number;
  recurrence: LessonRecurrence;
  startDate: string | null;
  endDate: string | null;
  /** A post in a parallel block is laid with its block. */
  blockId: string | null;
  cannotPlace: "BLOCK" | "NO_TEACHER" | null;
  /** How many times the server judges free, when it says. */
  possibleTimes: number | null;
}

export interface BoardTray {
  academicYearId: string;
  bricks: TrayBrick[];
  tally: { lessons: number; laid: number; placedByRow: number; left: number };
  groups: Array<{ studentGroupId: string; left: number }>;
}

/** The tray of the year, or null for an answer that is not the gateway's (a proxy's page, an older gateway's body). */
export async function fetchTray(academicYearId: string): Promise<BoardTray | null> {
  const tray = await api.get<BoardTray>(`/api/v1/board-tray?academicYearId=${encodeURIComponent(academicYearId)}`);
  return tray && Array.isArray(tray.bricks) && Array.isArray(tray.groups) && tray.tally && typeof tray.tally.lessons === "number" ? tray : null;
}

/** What a lay is told, as the gateway takes it (src/board-tray/dto/lay-brick.dto.ts). */
export interface LayBody {
  academicYearId: string;
  postId: string;
  teacherId: string | null;
  minutes: number;
  partKey: string;
  lessonId?: string;
  dayOfWeek: number;
  startTime: string;
  /** null: "Utan sal". */
  roomId: string | null;
  /** "Lägg ändå": the rules of the board the administrator answers yes to for this time. */
  exempt?: ExemptRule[];
}

export interface LayAnswer {
  lesson: { id: string; dayOfWeek: number; startTime: string; endTime: string; roomId: string | null };
  noRoom: boolean;
}

/** The body a lay is sent as: the brick's own part and where it is put. */
export function layBodyOf(
  brick: TrayBrick,
  academicYearId: string,
  where: { dayOfWeek: number; startTime: string; roomId: string | null; exempt?: ExemptRule[] },
): LayBody {
  return {
    academicYearId,
    postId: brick.postId,
    teacherId: brick.teacherId,
    minutes: brick.minutes,
    partKey: brick.partKey,
    ...(brick.lessonId !== null ? { lessonId: brick.lessonId } : {}),
    dayOfWeek: where.dayOfWeek,
    startTime: where.startTime,
    roomId: where.roomId,
    ...(where.exempt && where.exempt.length > 0 ? { exempt: where.exempt } : {}),
  };
}

export function layBrick(body: LayBody): Promise<LayAnswer> {
  return api.post<LayAnswer>("/api/v1/board-tray/lay", body);
}

/** The codes the gateway answers a lay with that the page words itself. */
export const REQUIREMENT_PLACEMENTS_STALE = "REQUIREMENT_PLACEMENTS_STALE";
export const BOARD_ROOM_NOT_ALLOWED = "BOARD_ROOM_NOT_ALLOWED";
export const BOARD_BRICK_CANNOT_BE_LAID = "BOARD_BRICK_CANNOT_BE_LAID";
export const MASTER_LESSON_REFUSED = "MASTER_LESSON_REFUSED";

/** Why the generator would not put the lesson in the room (src/board-tray/lay-room.ts). */
export type RoomRefusal = "SEATS" | "TYPE" | "YEARS";

/** What a refused lay is, for the form to say and to offer the way on. */
export type LayFailure =
  /** Another administrator laid or changed the part: the list is read again. */
  | { kind: "STALE" }
  /** The room does not suit the lesson: choose another, or lay it without one. */
  | { kind: "ROOM"; reason: RoomRefusal }
  /** The brick is laid with its block, or has no teacher. */
  | { kind: "CANNOT" }
  /** The judge refused the time. `exemptable` names the rules the answer "Lägg ändå" can be given to, when it is all of them. */
  | { kind: "REFUSED"; exemptable: ExemptRule[] | null }
  | { kind: "OTHER" };

const ROOM_REFUSALS: readonly string[] = ["SEATS", "TYPE", "YEARS"];

export function layFailureOf(error: unknown): LayFailure {
  if (!(error instanceof ApiError)) return { kind: "OTHER" };
  if (error.code === REQUIREMENT_PLACEMENTS_STALE) return { kind: "STALE" };
  if (error.code === BOARD_ROOM_NOT_ALLOWED) {
    const reason = String(error.params?.["reason"] ?? "");
    return ROOM_REFUSALS.includes(reason) ? { kind: "ROOM", reason: reason as RoomRefusal } : { kind: "OTHER" };
  }
  if (error.code === BOARD_BRICK_CANNOT_BE_LAID) return { kind: "CANNOT" };
  if (error.code === MASTER_LESSON_REFUSED) {
    const reasons = error.params?.["reasons"];
    return { kind: "REFUSED", exemptable: typeof reasons === "string" ? exemptableReasons(reasons) : null };
  }
  return { kind: "OTHER" };
}

/**
 * The head's sentence in numbers: the lessons that stand on the grundschema of those the year's posts ask for. A förläggning answers a lesson too
 * but is no lesson until Generera writes it, so it is said apart and not counted as laid.
 */
export function headFigures(tally: BoardTray["tally"]): { laid: number; of: number; placedByRow: number } {
  return { laid: tally.laid, of: tally.lessons, placedByRow: tally.placedByRow };
}

/** The bricks of one class, or all of them with `null`; the gateway's order is kept (the longest first). */
export function bricksOf(tray: BoardTray, groupId: string | null): TrayBrick[] {
  return groupId === null ? tray.bricks : tray.bricks.filter((brick) => brick.studentGroupId === groupId);
}

/** A key for a brick on the page: the part and which of its bricks it is, or the lesson it is. */
export function brickKey(brick: TrayBrick): string {
  return brick.lessonId ?? `${brick.postId}:${brick.teacherId ?? ""}:${brick.minutes}:${brick.nth}`;
}

/** The brick as the question "where can it stand?" and "which rooms?" take it (src/calendar/dto/possible-times.dto.ts). */
export function brickSubject(brick: TrayBrick, academicYearId: string) {
  return {
    academicYearId,
    studentGroupId: brick.studentGroupId,
    subjectId: brick.subjectId,
    minutes: brick.minutes,
    ...(brick.teacherId !== null ? { teacherId: brick.teacherId } : {}),
    ...(brick.coTeacherId !== null ? { coTeacherId: brick.coTeacherId } : {}),
    recurrence: brick.recurrence,
    ...(brick.startDate !== null ? { startDate: brick.startDate } : {}),
    ...(brick.endDate !== null ? { endDate: brick.endDate } : {}),
  };
}

export type BrickSubject = ReturnType<typeof brickSubject>;
