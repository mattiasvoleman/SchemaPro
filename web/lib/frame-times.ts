import type { GradeSpan } from "@/lib/grade-span";
import { timeToMinutes } from "@/lib/utils";

/**
 * A ramtid: the hours one stage of the school may be taught in.
 *
 * Mirrors the row in FrameTimes and the engine's `FrameTime`. Clock strings
 * are HH:MM:SS as PostgREST returns them.
 */
export interface FrameTime {
  id: string;
  minGradeLevel: number;
  maxGradeLevel: number;
  /** ISO weekday 1-7, or null for every teaching day. */
  dayOfWeek: number | null;
  startTime: string;
  endTime: string;
}

/** The minutes a group may be taught in on one day. */
export interface FrameWindow {
  startMinutes: number;
  endMinutes: number;
}

/**
 * The window a group is bound by on one weekday, or null if the day is closed.
 *
 * MATCHING IS OVERLAP AND EVERY MATCH APPLIES, so the answer is the
 * INTERSECTION of the frames the group's years touch. Three consequences worth
 * stating, because each is a decision and not an accident:
 *
 *   A weekday frame and an every-day frame both match that weekday, so both
 *   apply. "08:00-15:00 always, 08:00-13:00 on Friday" therefore means the
 *   obvious thing with no precedence rule to remember.
 *
 *   A group straddling two stages — years 6-7 where the school has 4-6 and 7-9
 *   frames — gets the tighter of the two. The alternative puts its year-6
 *   pupils in a classroom during an afternoon their own stage has closed; this
 *   one costs the timetable some room, which is the survivable error.
 *
 *   A group whose years are unknown matches nothing and keeps the whole day.
 *   Overlap has no answer against nothing, and answering yes would sweep every
 *   yearless group into a frame written for one stage.
 *
 * `undefined` for the frames — the query still in flight — is not the same as
 * an empty list and must not be: an empty list is a school with no frames,
 * where every day is open, and treating "not loaded yet" as that is how a
 * warning silently fails to appear. Callers pass the array only once they have
 * it; see how conflicts.ts skips the whole check when it is absent.
 *
 * The engine computes the same thing in optimization-engine/app/solver/frames.py.
 * The two must agree, or the grid flags what the solver allows and vice versa.
 */
export function frameWindow(
  frames: FrameTime[],
  span: GradeSpan | undefined,
  dayOfWeek: number,
): FrameWindow | null {
  if (!span) return { startMinutes: 0, endMinutes: 24 * 60 };

  let startMinutes = 0;
  let endMinutes = 24 * 60;

  for (const frame of frames) {
    if (frame.dayOfWeek !== null && frame.dayOfWeek !== dayOfWeek) continue;
    if (span.max < frame.minGradeLevel || span.min > frame.maxGradeLevel) continue;
    startMinutes = Math.max(startMinutes, timeToMinutes(frame.startTime));
    endMinutes = Math.min(endMinutes, timeToMinutes(frame.endTime));
  }

  return endMinutes > startMinutes ? { startMinutes, endMinutes } : null;
}

/**
 * Whether a placement falls outside the frames of every group attending it.
 *
 * ANY group is enough. A lesson shared by 6A and 7A has to sit inside both
 * their frames, because the pupils of both are in the room — so the lesson is
 * flagged as soon as one of them is outside its own. Requiring all of them to
 * be outside would let a lesson at 16:00 pass because the year-7 half may be
 * there, while the year-6 half sits in a lesson their school closed.
 *
 * A group with no known years is not evidence either way and is skipped, which
 * is the same silence frameWindow keeps for it.
 */
export function breaksFrame(
  frames: FrameTime[],
  groupIds: string[],
  gradeSpanOf: Map<string, GradeSpan> | undefined,
  dayOfWeek: number,
  startMinutes: number,
  endMinutes: number,
): boolean {
  if (frames.length === 0) return false;

  return groupIds.some((groupId) => {
    const span = gradeSpanOf?.get(groupId);
    if (!span) return false;
    const window = frameWindow(frames, span, dayOfWeek);
    return (
      window === null ||
      startMinutes < window.startMinutes ||
      endMinutes > window.endMinutes
    );
  });
}
