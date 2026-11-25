import type { ProblemLookup } from "@/lib/api-error-text";

/**
 * The codes of the gateway's problems that have a sentence in the web's own catalogue, `common.codes.<CODE>`, and the `params` each
 * sentence is written from.
 *
 * The gateway words a refusal in the language its thrower wrote, mostly Swedish and a few in English, and sends it as `detail` beside
 * a machine-readable `code` and flat `params` (src/common/filters/http-exception.filter.ts). A Swedish reader got the thrower's
 * sentence and an English reader got the same one. For a code listed here the reader gets the catalogue's sentence in their own
 * language instead (lib/api-error-text.ts); a code that is not listed, or whose params did not arrive, still shows `detail`.
 *
 * It is a list and not a lookup in the catalogue because apiErrorText asks its translator for keys and never for `has`: the page
 * tests replace next-intl with a stub that only echoes (web-page-tests-mock-next-intl), and a `has` there would answer for every
 * code or for none. The sentences themselves are server data and cost no bundle; this table is the only part that ships, so it
 * holds names and nothing else. lib/problem-codes.test.ts holds it equal to the catalogue, key for key and argument for argument.
 *
 * A code a page words itself (its own catalogue, through engineMessage) is that page's: the page asks first, and this is the last
 * resort of the pages that fall back to apiErrorText.
 */
export const PROBLEM_CODES: Readonly<Record<string, readonly string[]>> = {
  ABSENCE_STATS_TOO_SLOW: [],
  ATTENDANCE_REGISTER_BUSY: [],
  BLOCK_CARD_STALE: [],
  CLASS_ALREADY_SPLIT: [],
  CLASS_HAS_HALVES: [],
  CLASS_HAS_ONE_HALF: [],
  DATABASE_BUSY: [],
  HALF_IN_OTHER_YEAR: [],
  HALF_LINK_IS_FIXED: [],
  HALF_MEMBER_IN_OTHER_HALF: [],
  HALF_MEMBER_NOT_IN_CLASS: [],
  HALF_NOT_A_TEACHING_GROUP: [],
  HALF_OF_NOT_A_CLASS: [],
  LANGUAGE_BLOCK_HAS_OTHER_LESSONS: [],
  LANGUAGE_BLOCK_IN_OTHER_GRADE: [],
  LESSON_LENGTHS_MISMATCH: [],
  LESSON_LENGTHS_TOO_MANY_KINDS: [],
  LESSON_LOG_TOO_LONG: ["max"],
  NOT_A_BLOCK_CARD: [],
  NOT_A_CLASS: [],
  NOT_THE_CLASS_HALVES: [],
  PUPIL_IN_TWO_HALVES: [],
  PUPIL_NOT_IN_CLASS: [],
  PUSH_DISABLED: [],
  PUSH_TOKEN_BUSY: [],
  REQUIREMENT_HAS_PERIOD: [],
  REQUIREMENT_IN_A_BLOCK: [],
  ROOM_CLASH: [],
  SCHOOL_ID_INVALID: [],
  SPRING_START_OUTSIDE_YEAR: [],
  SUBJECT_QUALIFICATION_IS_INHERITED: [],
  SUBJECT_QUALIFICATION_IS_ITSELF: [],
  SUBJECT_QUALIFICATION_SOURCE_INHERITS: [],
  SUBJECT_QUALIFICATION_SOURCE_NOT_FOUND: [],
  TEACHING_BLOCK_NAME_TAKEN: [],
  TEMPLATE_FIELDS_CONFLICT: ["a", "b"],
  TERM_PERIODS_MISSING: [],
  TERM_SUBJECTS_SAME: [],
  TERM_TEACHER_TWICE: [],
  TIMPLAN_CREDIT_GROUP_OF_ANOTHER_YEAR: ["groupName", "yearName"],
  TIMPLAN_CREDIT_SCOPE: [],
  TIMPLAN_IN_USE: [],
  TIMPLAN_IS_DRAFT: [],
};

/**
 * The sentence for a coded problem, or undefined when there is none to give: the code is not listed, or the sentence takes an
 * argument the gateway did not send (or sent as something other than a string or a number). The translator is only asked for a
 * sentence it can fill, so a missing argument never reaches it and the reader never sees its fallback ("common.codes.X").
 */
export function problemCodeText(error: Error, code: string, t: ProblemLookup): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(PROBLEM_CODES, code)) return undefined;
  const sent = (error as Error & { params?: unknown }).params;
  const values: Record<string, string | number> = {};
  for (const name of PROBLEM_CODES[code]) {
    const value = typeof sent === "object" && sent !== null ? (sent as Record<string, unknown>)[name] : undefined;
    if (typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) values[name] = value;
    else return undefined;
  }
  return t(`codes.${code}`, PROBLEM_CODES[code].length > 0 ? values : undefined);
}
