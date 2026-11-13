/**
 * The gateway's code for an edit, a swap or a klasslärare's draft that would move or change a lesson Generera writes
 * from a förläggning on its timplanspost (LESSON_IS_PLACED in src/calendar/master-lessons.service.ts and
 * LESSON_IS_PLACED_REASON in src/class-teacher/class-teacher.types.ts). On a file of its own: the pages that only
 * compare a code with it must not take the whole of lib/class-teacher.ts into their chunk for one string.
 * class-teacher.contract.test.ts reads the gateway's files and fails when this drifts.
 */
export const LESSON_IS_PLACED = "LESSON_IS_PLACED";
