/**
 * The react-query keys of the cover board (Vikarietavla) and the absence
 * register, and what a cover write makes stale — the publication-keys.ts
 * pattern.
 *
 * Its own module so that a page invalidating the board does not import the
 * cover hooks. lib/queries.ts, which is in every route's chunk graph, names
 * `coverBoard` as a literal in useLessonActions (the old absence page's and
 * the day planner's writes land on the board) rather than importing this.
 *
 * Each is the PREFIX react-query matches on invalidation. The board, the
 * register's counts and the counter share the prefix `coverBoard`, so the one
 * key an old-page write or a realtime event invalidates refreshes all three:
 * they are the same pairs counted three ways.
 */
export const ALL_COVER = ["coverBoard"] as const;

export const COVER_KEYS = {
  board: ["coverBoard", "board"],
  absences: ["coverBoard", "absences"],
  reasons: ["teacherAbsenceReasons"],
  settings: ["coverSettings"],
  candidates: ["coverCandidates"],
  counter: ["coverBoard", "counter"],
  hours: ["coverHours"],
  pool: ["substitutePool"],
  poolMembership: ["substitutePoolMembership"],
  availability: ["substituteAvailability"],
} as const;

/**
 * What a decision on the board makes stale: the board, the register's
 * counts, the counter, and every calendar read — the substitute's week, the
 * class's, the day planner's and the old absence page's — plus the figures
 * read off the calendar (P3's delivered time, the staffing reconciliation).
 */
export const AFTER_COVER_WRITE: readonly (readonly string[])[] = [
  ALL_COVER,
  COVER_KEYS.candidates,
  COVER_KEYS.hours,
  ["calendarLessons"],
  ["dayLessons"],
  ["teacherLessons"],
  ["teacherAbsenceLessons"],
  ["timplanCoverage"],
  ["staffingLoad"],
];
