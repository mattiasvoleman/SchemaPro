// Lektionslängder, as the browser counts them.
//
// A MIRROR OF src/common/lesson-lengths.ts, not a second opinion on it. A
// timplanspost says lessonsPerWeek × minutesPerLesson and, when its lessons
// are not all one length, `lessonLengths`, one entry per lesson longest first
// ({80,40} is "1 × 80 + 1 × 40"); the list is empty on every uniform row, and
// on a split row the scalars are the count and the longest. Every reader of a
// row's MINUTES — the Timplansposter matrix and its Mål mode, the teacher
// card, the load report, the rollover's volume check — reads them here, so the
// browser says 120 for 1 × 80 + 1 × 40 where the gateway says 120.
//
// Both copies replay src/common/__fixtures__/lesson-lengths-cases.json
// (generated from the gateway copy): lesson-lengths.contract.spec.ts there,
// lesson-lengths.contract.test.ts here. The body below is the gateway file's
// with this package's quotes; keep it that way, so a diff of the two shows
// only the header. Formatting ("1 × 80 + 1 × 40") is the web's alone and lives
// in lesson-lengths-text.ts; the CSV cell grammar lives in csv.ts.

/** The engine's AnonymousRequirement bounds on one lesson (schedule.py). */
export const LESSON_MIN_MINUTES = 15;
export const LESSON_MAX_MINUTES = 240;
/**
 * The solver's grid: the engine's SLOT_MINUTES and solver-grid.ts's. Written
 * out rather than imported, because solver-grid.ts reaches into @nestjs/common
 * and this module is imported by pure ones (year-rollover.ts: "no Nest") and
 * mirrored in the web; lesson-lengths.contract.spec.ts asserts the two agree.
 */
export const LESSON_GRID_MINUTES = 5;
/** The engine's lessons_per_week bound and the DTO's @Max(40). */
export const MAX_LESSONS_PER_WEEK = 40;
/**
 * At most three different lengths on one post: 80 + 60 + 40 is the widest
 * scheme a school writes; more is a list of lessons rather than a split. The
 * CHECK TeachingRequirements_lesson_lengths_are_canonical says the same.
 */
export const MAX_DISTINCT_LENGTHS = 3;

/** What every reader of a requirement's lessons hands in. */
export interface LessonShape {
  lessonsPerWeek: number;
  minutesPerLesson: number;
  /** Longest first; empty, absent or null on a uniform row. */
  lessonLengths?: readonly number[] | null;
}

/** One length and how many lessons a week have it. */
export interface LengthPart {
  count: number;
  minutes: number;
}

/** A row as it is stored: lessonLengths is [] exactly when the row is uniform. */
export interface CanonicalShape {
  lessonsPerWeek: number;
  minutesPerLesson: number;
  lessonLengths: number[];
}

export type LengthsProblem =
  | "EMPTY"
  | "NOT_INTEGER"
  | "OUT_OF_RANGE"
  | "OFF_GRID"
  | "TOO_MANY_LESSONS"
  | "TOO_MANY_KINDS";

const positive = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0);

const listOf = (row: LessonShape): readonly number[] => row.lessonLengths ?? [];

/** Whether the row's lessons have two or more different lengths. */
export function isMixed(row: LessonShape): boolean {
  const lengths = listOf(row);
  return lengths.length > 1 && lengths.some((minutes) => minutes !== lengths[0]);
}

/** The lessons a week. On a split row, the list's length; it equals lessonsPerWeek. */
export function lessonCountOf(row: LessonShape): number {
  return isMixed(row) ? listOf(row).length : positive(row.lessonsPerWeek);
}

/** One length per lesson, longest first. A uniform row is lessonsPerWeek copies. */
export function lessonMinutesOf(row: LessonShape): number[] {
  if (isMixed(row)) return [...listOf(row)].sort((a, b) => b - a);
  const count = Math.floor(positive(row.lessonsPerWeek));
  return Array.from({ length: count }, () => positive(row.minutesPerLesson));
}

/** The minutes a week the row's lessons take: Σ of every lesson's length. */
export function weeklyMinutesOf(row: LessonShape): number {
  if (isMixed(row)) return listOf(row).reduce((sum, minutes) => sum + positive(minutes), 0);
  return positive(row.lessonsPerWeek) * positive(row.minutesPerLesson);
}

/** The shortest lesson: the one that could go if a week has a lesson too many. */
export function shortestLessonOf(row: LessonShape): number {
  return isMixed(row) ? Math.min(...listOf(row)) : positive(row.minutesPerLesson);
}

/** The longest lesson: the one a frame, a rast or a day must have room for. */
export function longestLessonOf(row: LessonShape): number {
  return isMixed(row) ? Math.max(...listOf(row)) : positive(row.minutesPerLesson);
}

/** The lengths with their counts, longest first: {80,40} → 1 × 80, 1 × 40. */
export function lengthPartsOf(row: LessonShape): LengthPart[] {
  if (!isMixed(row)) {
    return [{ count: positive(row.lessonsPerWeek), minutes: positive(row.minutesPerLesson) }];
  }
  const counts = new Map<number, number>();
  for (const minutes of listOf(row)) counts.set(minutes, (counts.get(minutes) ?? 0) + 1);
  return [...counts]
    .sort(([a], [b]) => b - a)
    .map(([minutes, count]) => ({ count, minutes }));
}

/**
 * Any list of lengths as the row that stores it: sorted longest first, the
 * count and the longest as the scalars, and [] when the lengths are all one
 * (a uniform row has one representation, never {60,60}). An empty list is no
 * row at all and gives zeros; ask lengthsProblem first.
 */
export function canonicalShape(lengths: readonly number[]): CanonicalShape {
  const sorted = [...lengths].sort((a, b) => b - a);
  const mixed = sorted.length > 1 && sorted[sorted.length - 1] !== sorted[0];
  return {
    lessonsPerWeek: sorted.length,
    minutesPerLesson: sorted[0] ?? 0,
    lessonLengths: mixed ? sorted : [],
  };
}

/** Parts as the row that stores them; equal minutes in two parts merge. */
export function shapeFromParts(parts: readonly LengthPart[]): CanonicalShape {
  const lengths: number[] = [];
  for (const { count, minutes } of parts) {
    for (let i = 0; i < count; i += 1) lengths.push(minutes);
  }
  return canonicalShape(lengths);
}

/**
 * Why a list of lengths cannot be stored, or null. In the order a writer
 * should hear it: each length first (whole, in range, on the grid), then the
 * list (at most 40 lessons, at most three different lengths).
 */
export function lengthsProblem(lengths: readonly number[]): LengthsProblem | null {
  if (lengths.length === 0) return "EMPTY";
  if (lengths.some((minutes) => !Number.isInteger(minutes))) return "NOT_INTEGER";
  if (lengths.some((minutes) => minutes < LESSON_MIN_MINUTES || minutes > LESSON_MAX_MINUTES)) {
    return "OUT_OF_RANGE";
  }
  if (lengths.some((minutes) => minutes % LESSON_GRID_MINUTES !== 0)) return "OFF_GRID";
  if (lengths.length > MAX_LESSONS_PER_WEEK) return "TOO_MANY_LESSONS";
  if (new Set(lengths).size > MAX_DISTINCT_LENGTHS) return "TOO_MANY_KINDS";
  return null;
}
