// Lektionslängder as the admin reads and types them.
//
// The arithmetic is lib/lesson-lengths.ts, a mirror of the gateway's; this
// file is the web's alone — how a row's lengths are written ("1 × 80 + 1 × 40")
// and how the cell dialog's text fields become a row the API will store. The
// gateway never formats a length and never reads a half-typed field, so
// neither belongs in the mirror both sides replay.

import {
  LESSON_MAX_MINUTES,
  LESSON_MIN_MINUTES,
  MAX_LESSONS_PER_WEEK,
  lengthPartsOf,
  lengthsProblem,
  shapeFromParts,
  type CanonicalShape,
  type LengthPart,
  type LessonShape,
  type LengthsProblem,
} from "@/lib/lesson-lengths";

/**
 * "1 × 80 + 1 × 40", longest first; a uniform row is "3 × 60", as the
 * dialog's hints have always written it. `compact` drops the spaces around
 * ×, the matrix cell's "3×60", and keeps them around + so two parts still
 * read as two.
 */
export function formatParts(parts: readonly LengthPart[], compact = false): string {
  const times = compact ? "×" : " × ";
  return parts.map((part) => `${part.count}${times}${part.minutes}`).join(" + ");
}

/** A row's lengths written out: formatParts(lengthPartsOf(row)). */
export function formatLengths(row: LessonShape, compact = false): string {
  return formatParts(lengthPartsOf(row), compact);
}

/** One length as the dialog holds it: two text fields, like every number there. */
export interface DraftPart {
  lessons: string;
  minutes: string;
}

export type DraftProblem = "INCOMPLETE" | LengthsProblem;

/**
 * The dialog's parts as the row a save would store, or why it cannot be.
 *
 * ONE part is a uniform row and is judged exactly as the dialog always judged
 * it: whole lessons 1..40 and whole minutes 15..240, with the grid left to the
 * gateway, whose 400 names the nearest lengths. Two or more parts are judged
 * as the list they expand to (lengthsProblem: range, grid, at most 40 lessons,
 * at most three different lengths), because the dialog cannot send a list the
 * CHECK would refuse and then explain a 400 about a column the admin never
 * saw. Parts with equal minutes merge, and parts that all say one length are
 * a uniform row with an empty list — the one representation the database has.
 */
export function shapeFromDraft(
  parts: readonly DraftPart[],
): { shape: CanonicalShape; problem: null } | { shape: null; problem: DraftProblem } {
  const numbers: LengthPart[] = [];
  for (const part of parts) {
    if (part.lessons.trim() === "" || part.minutes.trim() === "") {
      return { shape: null, problem: "INCOMPLETE" };
    }
    const count = Number(part.lessons);
    const minutes = Number(part.minutes);
    if (!Number.isInteger(count) || count < 1 || count > MAX_LESSONS_PER_WEEK) {
      return { shape: null, problem: count > MAX_LESSONS_PER_WEEK ? "TOO_MANY_LESSONS" : "INCOMPLETE" };
    }
    numbers.push({ count, minutes });
  }
  if (numbers.length === 1) {
    const [{ count, minutes }] = numbers;
    if (!Number.isInteger(minutes)) return { shape: null, problem: "NOT_INTEGER" };
    if (minutes < LESSON_MIN_MINUTES || minutes > LESSON_MAX_MINUTES) {
      return { shape: null, problem: "OUT_OF_RANGE" };
    }
    return { shape: { lessonsPerWeek: count, minutesPerLesson: minutes, lessonLengths: [] }, problem: null };
  }
  const total = numbers.reduce((sum, part) => sum + part.count, 0);
  if (total > MAX_LESSONS_PER_WEEK) return { shape: null, problem: "TOO_MANY_LESSONS" };
  const lengths = numbers.flatMap((part) => Array.from({ length: part.count }, () => part.minutes));
  const problem = lengthsProblem(lengths);
  if (problem) return { shape: null, problem };
  return { shape: shapeFromParts(numbers), problem: null };
}

/** A stored row as the dialog's parts, longest first: one part when uniform. */
export function draftPartsOf(row: LessonShape): DraftPart[] {
  return lengthPartsOf(row).map((part) => ({
    lessons: String(part.count),
    minutes: String(part.minutes),
  }));
}
