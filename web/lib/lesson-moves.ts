/**
 * Elevens lektion för dagen: the gateway's answers (src/lesson-moves), typed.
 * A pupil is moved, for one date, from a lesson to a parallel one; the move is
 * the two dated lessons' and never the template's.
 */

/** Why a pupil cannot be moved to a lesson; the candidates carry it, a refused move answers with it as an error code. */
export type MoveRefusalCode =
  | "LESSON_MOVE_NOT_PARALLEL"
  | "LESSON_MOVE_LESSON_OVER"
  | "LESSON_MOVE_LESSON_NOT_HELD"
  | "LESSON_MOVE_REPLACED_BY_ACTIVITY"
  | "LESSON_MOVE_ALREADY_ON_TARGET"
  | "LESSON_MOVE_PUPIL_DOUBLE_BOOKED";

export interface MoveRefusal {
  code: MoveRefusalCode;
  /** The lesson the reason is about, when it is one of the two. */
  side?: "FROM" | "TO";
}

export interface MoveWarning {
  code: "TARGET_ROOM_OVER_CAPACITY";
  /** The pupils the lesson would have with this one. */
  headcount: number;
  capacity: number;
}

/** A lesson as the lists name it: subject, class or group, the school's clock, room. */
export interface MoveLessonView {
  id: string;
  subject: string;
  className: string;
  start: string;
  end: string;
  room: string | null;
}

export interface MoveCandidate extends MoveLessonView {
  headcount: number;
  roomCapacity: number | null;
  refusal: MoveRefusal | null;
  warnings: MoveWarning[];
}

export interface MoveCandidates {
  from: MoveLessonView;
  candidates: MoveCandidate[];
}

export interface MoveResult {
  /** False when the pupil was sent back to the lesson they started on. */
  moved: boolean;
  moveId: string | null;
  warnings: MoveWarning[];
}

export interface MovablePupil {
  id: string;
  firstName: string;
  lastName: string;
  /** On the lesson because a move put them there. */
  arrived: boolean;
}

export interface LessonMoveEntry {
  moveId: string;
  studentId: string;
  studentName: string;
  other: MoveLessonView;
  movedByName: string | null;
  createdAt: string;
}

export interface LessonMoves {
  departures: LessonMoveEntry[];
  arrivals: LessonMoveEntry[];
}
