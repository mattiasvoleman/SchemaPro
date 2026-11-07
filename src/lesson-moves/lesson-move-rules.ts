/**
 * Elevens lektion för dagen: what a move is, as the gateway says it before the
 * database's door does (app.lesson_pupil_move, 20270122091000). The database
 * holds the same rules (a trigger on LessonPupilMoves), so a race that gets
 * past these is refused there with the same code; these exist to answer the
 * teacher with the reason, and to rank the lessons a pupil can be moved to.
 *
 * Pure: nothing here reads a row.
 */

/** The codes a refusal carries, to the web and the app (messages under `lessonMoves.errors`). */
export const LESSON_MOVE_NOT_ALLOWED = 'LESSON_MOVE_NOT_ALLOWED';
export const LESSON_MOVE_LESSON_NOT_FOUND = 'LESSON_MOVE_LESSON_NOT_FOUND';
export const LESSON_MOVE_NOT_FOUND = 'LESSON_MOVE_NOT_FOUND';
export const LESSON_MOVE_NOT_PARALLEL = 'LESSON_MOVE_NOT_PARALLEL';
export const LESSON_MOVE_LESSON_NOT_HELD = 'LESSON_MOVE_LESSON_NOT_HELD';
export const LESSON_MOVE_REPLACED_BY_ACTIVITY = 'LESSON_MOVE_REPLACED_BY_ACTIVITY';
export const LESSON_MOVE_IN_THE_PAST = 'LESSON_MOVE_IN_THE_PAST';
export const LESSON_MOVE_PUPIL_NOT_ON_LESSON = 'LESSON_MOVE_PUPIL_NOT_ON_LESSON';
export const LESSON_MOVE_ALREADY_ON_TARGET = 'LESSON_MOVE_ALREADY_ON_TARGET';
export const LESSON_MOVE_PUPIL_DOUBLE_BOOKED = 'LESSON_MOVE_PUPIL_DOUBLE_BOOKED';
export const LESSON_MOVE_HAS_ATTENDANCE = 'LESSON_MOVE_HAS_ATTENDANCE';
export const LESSON_MOVE_EXISTS = 'LESSON_MOVE_EXISTS';
export const LESSON_MOVE_CHANGED = 'LESSON_MOVE_CHANGED';
export const LESSON_MOVE_NOT_A_PUPIL = 'LESSON_MOVE_NOT_A_PUPIL';

export type MoveRefusalCode =
  | typeof LESSON_MOVE_NOT_PARALLEL
  | typeof LESSON_MOVE_LESSON_NOT_HELD
  | typeof LESSON_MOVE_REPLACED_BY_ACTIVITY
  | typeof LESSON_MOVE_ALREADY_ON_TARGET
  | typeof LESSON_MOVE_PUPIL_DOUBLE_BOOKED;

/** Which lesson of the move a refusal is about. */
export type MoveSide = 'FROM' | 'TO';

export interface MoveRefusal {
  code: MoveRefusalCode;
  /** The lesson that is the reason, for a refusal about one of the two. */
  side?: MoveSide;
}

/** The parts of a lesson the rules read. */
export interface MoveLesson {
  id: string;
  status: 'SCHEDULED' | 'CANCELLED' | 'COMPLETED' | 'RESCHEDULED';
  cancelCause?: string | null;
  startsAt: Date;
  endsAt: Date;
}

/** A lesson that is held: the statuses the delivered time and the absence watch count (cover-rules.holdsTime). */
export function isHeld(lesson: Pick<MoveLesson, 'status'>): boolean {
  return lesson.status === 'SCHEDULED' || lesson.status === 'COMPLETED';
}

/** Two lessons overlap in time: each starts before the other ends. Touching is not overlapping. */
export function overlaps(a: Pick<MoveLesson, 'startsAt' | 'endsAt'>, b: Pick<MoveLesson, 'startsAt' | 'endsAt'>): boolean {
  return a.startsAt.getTime() < b.endsAt.getTime() && b.startsAt.getTime() < a.endsAt.getTime();
}

/** A lesson an activity has replaced (Schemabrytande aktivitet): cancelled with the cause EVENT. */
export function isReplacedByActivity(lesson: Pick<MoveLesson, 'status' | 'cancelCause'>): boolean {
  return lesson.status === 'CANCELLED' && lesson.cancelCause === 'EVENT';
}

/**
 * Why `target` cannot be where the pupil goes in place of `origin`, in the
 * database's order: a lesson an activity has replaced, a lesson not held,
 * a lesson that does not overlap the pupil's own. The pupil may be on `current`
 * (a lesson a move put them on), which is not the target either.
 */
export function refusalOf(origin: MoveLesson, target: MoveLesson): MoveRefusal | null {
  if (target.id === origin.id) return { code: LESSON_MOVE_NOT_PARALLEL };
  if (isReplacedByActivity(origin)) return { code: LESSON_MOVE_REPLACED_BY_ACTIVITY, side: 'FROM' };
  if (isReplacedByActivity(target)) return { code: LESSON_MOVE_REPLACED_BY_ACTIVITY, side: 'TO' };
  if (!isHeld(origin)) return { code: LESSON_MOVE_LESSON_NOT_HELD, side: 'FROM' };
  if (!isHeld(target)) return { code: LESSON_MOVE_LESSON_NOT_HELD, side: 'TO' };
  if (!overlaps(origin, target)) return { code: LESSON_MOVE_NOT_PARALLEL };
  return null;
}

/**
 * Another lesson the pupil is on that would be held beside the target if they
 * went there: held, overlapping the target, and neither the lesson they leave,
 * the one they are on, nor the target itself.
 */
export function doubleBooks(target: MoveLesson, pupilLessons: readonly MoveLesson[], except: ReadonlySet<string>): MoveLesson | null {
  return pupilLessons.find((other) => !except.has(other.id) && other.id !== target.id && isHeld(other) && overlaps(other, target)) ?? null;
}

/** A warning that does not refuse. */
export type MoveWarning = { code: 'TARGET_ROOM_OVER_CAPACITY'; headcount: number; capacity: number };

/**
 * The target's room holds fewer than the lesson would have with the pupil. A
 * warning and never a refusal: a room's capacity is the school's estimate,
 * and a teacher who takes one more pupil knows their room. A room with no
 * capacity written is no warning.
 */
export function crowdedWarning(headcount: number, capacity: number | null): MoveWarning | null {
  if (capacity === null || capacity <= 0) return null;
  return headcount + 1 > capacity ? { code: 'TARGET_ROOM_OVER_CAPACITY', headcount: headcount + 1, capacity } : null;
}

/** SQLSTATE of the database's refusals (app.lesson_pupil_move), and the code each is answered with. */
export const SQLSTATE_TO_CODE: Readonly<Record<string, string>> = {
  LM403: LESSON_MOVE_NOT_ALLOWED,
  LM404: LESSON_MOVE_NOT_FOUND,
  LM410: LESSON_MOVE_LESSON_NOT_HELD,
  LM412: LESSON_MOVE_NOT_PARALLEL,
  LM413: LESSON_MOVE_REPLACED_BY_ACTIVITY,
  LM414: LESSON_MOVE_IN_THE_PAST,
  LM415: LESSON_MOVE_HAS_ATTENDANCE,
};

/** The code a LM409 refusal carries in its message, or null. */
export function conflictCodeOf(text: string): string | null {
  return /(LESSON_MOVE_[A-Z_]+)/.exec(text)?.[1] ?? null;
}
