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
 *
 * A name that ends in `?` is one the sentence takes only for some of the cases it stands for. MASTER_LESSON_REFUSED says one of nine
 * reasons, and the gateway sends the other lesson's class, subject, day and time for a clash and nothing of them for a lunch or a ramtid:
 * the sentence selects on the reason, and each branch takes what its reason sends. A name left out is passed as "" (a `select` falls to its
 * `other`, a branch that is not chosen never reads its names), and only the names without a `?` must arrive for the sentence to be said.
 */
export const PROBLEM_CODES: Readonly<Record<string, readonly string[]>> = {
  ABSENCE_STATS_TOO_SLOW: [],
  ABSENCE_WATCH_LIMIT_NOT_FOUND: [],
  ACK_NOT_A_GUARDIAN: [],
  ACTIVITY_OWNED_BY_EXAM: [],
  ACTIVITY_OWNS_BATCH: [],
  ANALYSIS_RANGE: [],
  ATTENDANCE_REGISTER_BUSY: [],
  BEST_EFFORT_NO_REFRESH: [],
  BLOCK_CARD_STALE: [],
  CLASS_ALREADY_SPLIT: [],
  CLASS_BOOK_RANGE: [],
  CLASS_HAS_HALVES: [],
  CLASS_HAS_ONE_HALF: [],
  DATABASE_BUSY: [],
  DIRECT_REACH_UNANSWERED: ["validFrom", "validTo"],
  EMPLOYMENT_PERIOD_OVERLAP: [],
  EXAM_CAPS: [],
  EXAM_GROUPS: [],
  EXAM_NOT_FOUND: [],
  EXAM_NOT_PLANNED: [],
  EXAM_NO_REPLACEMENT_SUBJECT: [],
  EXAM_ROOM: [],
  EXAM_TOO_MANY: ["limit"],
  EXTERNAL_BOOKINGS_REGISTERED: ["date"],
  EXTERNAL_BOOKING_IS_RUNNING: [],
  HALF_IN_OTHER_YEAR: [],
  HALF_LINK_IS_FIXED: [],
  HALF_MEMBER_IN_OTHER_HALF: [],
  HALF_MEMBER_NOT_IN_CLASS: [],
  HALF_NOT_A_TEACHING_GROUP: [],
  HALF_OF_NOT_A_CLASS: [],
  HUVUDMAN_KEEPS_AN_ADMIN: [],
  HUVUDMAN_KEY_NOT_FOUND: [],
  HUVUDMAN_MEMBER_EXISTS: [],
  HUVUDMAN_MEMBER_NOT_FOUND: [],
  HUVUDMAN_NO_SCHOOL: [],
  IMPORT_ENCODING_UNSUPPORTED: [],
  IMPORT_FILE_COUNT: [],
  IMPORT_FILE_TOO_LARGE: [],
  IMPORT_HAS_REFUSALS: [],
  IMPORT_UNTIS_NO_GPU001: [],
  LANGUAGE_BLOCK_HAS_OTHER_LESSONS: [],
  LANGUAGE_BLOCK_IN_OTHER_GRADE: [],
  LAST_DECIDER: [],
  LESSON_CHANGED: [],
  LESSON_DATE_FORM: [],
  LESSON_LENGTHS_MISMATCH: [],
  LESSON_LENGTHS_TOO_MANY_KINDS: [],
  LESSON_LOG_NOT_YOURS: [],
  LESSON_LOG_RANGE: [],
  LESSON_LOG_TOO_LONG: ["max"],
  LESSON_LOG_TOPIC_ONE_LINE: [],
  MASTER_LESSON_REFUSED: ["reason", "schools?", "resource?", "pupilTime?", "className?", "subjectName?", "day?", "start?", "end?"],
  NOTIFICATION_TYPE_NOT_OFFERED: [],
  NOTIFICATION_TYPE_REQUIRED: [],
  NOT_A_BLOCK_CARD: [],
  NOT_A_CLASS: [],
  NOT_THE_CLASS_HALVES: [],
  PERSON_NOT_FOUND: [],
  PRINT_BAD_DATE: [],
  PRINT_TEACHERS_UNNAMED: [],
  PUPIL_IN_TWO_HALVES: [],
  PUPIL_NOT_IN_CLASS: [],
  PUSH_DISABLED: [],
  PUSH_TOKEN_BUSY: [],
  REPLACED_TEACHER_NOT_ON_LESSON: [],
  REQUIREMENT_HAS_PERIOD: [],
  REQUIREMENT_IN_A_BLOCK: [],
  RESOURCE_QUANTITY_USED: [],
  ROOM_CLASH: [],
  ROOM_IS_LET_OUT: [],
  ROOM_LENT_TO_OTHER_SCHOOL: [],
  ROOM_LOAN_LOCAL_ROOM_IS_ANOTHER: [],
  ROOM_TYPE_NOT_FOUND: [],
  SCHOOL_ID_INVALID: [],
  SCHOOL_PART_NAME_TAKEN: [],
  SCHOOL_PART_SPAN_INVALID: [],
  SCHOOL_PART_TEXT_INVALID: [],
  SCHOOL_UNIT_NAME_EMPTY: [],
  SPRING_START_OUTSIDE_YEAR: [],
  STUDENT_GROUP_HAS_ENROLMENT_HISTORY: [],
  SUBJECT_QUALIFICATION_IS_INHERITED: [],
  SUBJECT_QUALIFICATION_IS_ITSELF: [],
  SUBJECT_QUALIFICATION_SOURCE_INHERITS: [],
  SUBJECT_QUALIFICATION_SOURCE_NOT_FOUND: [],
  SUBSTITUTE_NOTE_NOT_YOURS: [],
  SUGGESTIONS_RUNNING: [],
  SWAP_BREAKS_BOARD_RULE: [],
  TEACHER_DUTY_BLOCK_IS_THE_ADMINS: [],
  TEACHER_DUTY_BLOCK_MISMATCH: [],
  TEACHING_BLOCK_NAME_TAKEN: [],
  TEMPLATE_DUPLICATE_FIELD: ["field"],
  TEMPLATE_DUPLICATE_KEY: [],
  TEMPLATE_FIELDS_CONFLICT: ["a", "b"],
  TEMPLATE_LABEL_INVALID: [],
  TEMPLATE_NAME_INVALID: ["max"],
  TEMPLATE_PERSONAL_NUMBER: [],
  TEMPLATE_TOO_LARGE: [],
  TEMPLATE_UNKNOWN_FIELD: ["field"],
  TERM_PERIODS_MISSING: [],
  TERM_SUBJECTS_SAME: [],
  TERM_TEACHER_TWICE: [],
  TIMPLAN_CREDIT_GROUP_OF_ANOTHER_YEAR: ["groupName", "yearName"],
  TIMPLAN_CREDIT_SCOPE: [],
  TIMPLAN_IN_USE: [],
  TIMPLAN_IS_DRAFT: [],
  USER_LEFT_ON_BEFORE_RETURN: ["returned"],
  USER_LEFT_ON_BEFORE_START: ["added"],
  USER_LEFT_ON_IN_THE_FUTURE: [],
  USER_LEFT_ON_NEEDS_INACTIVE: [],
  WORK_RULE_DAY_IS_PLANNED: [],
};

/** The reasons of a refused hand edit that common.codes.MASTER_LESSON_REFUSED has words for (src/calendar/lesson-judge.ts LessonRefusalReason). */
const REFUSAL_REASONS: ReadonlySet<string> = new Set(["SCHOOL_DAY", "TEACHER", "ROOM", "GROUP", "PUPILS", "AVAILABILITY", "FRAME", "LUNCH", "GRADE_RULE", "OTHER_SCHOOL"]);
/** The ones whose sentence names the other lesson, by class, subject, day and time. */
const NAMES_THE_OTHER_LESSON: ReadonlySet<string> = new Set(["TEACHER", "ROOM", "GROUP", "PUPILS"]);

/**
 * The sentence for a coded problem, or undefined when there is none to give: the code is not listed, or the sentence takes an
 * argument the gateway did not send (or sent as something other than a string or a number). The translator is only asked for a
 * sentence it can fill, so a missing argument never reaches it and the reader never sees its fallback ("common.codes.X").
 */
export function problemCodeText(error: Error, code: string, t: ProblemLookup): string | undefined {
  const params = (error as Error & { params?: unknown }).params;
  const sentence = problemSentence(code, params, t);
  // A refusal of several lessons at once (a swap's apply, a block's card) says which of them it is about in `requirement` ("Kemi för 8B"):
  // the sentence names only the OTHER lesson, and with no lesson of its own before it would not say which of the moved ones clashes.
  const member = code === "MASTER_LESSON_REFUSED" && typeof params === "object" && params !== null ? (params as Record<string, unknown>)["requirement"] : undefined;
  return sentence !== undefined && typeof member === "string" ? `${member}: ${sentence}` : sentence;
}

/**
 * The same from the code and the params themselves, for a sentence that is not an error's: the reasons the judge's read answers with
 * (POST /master-lessons/judge) are the refusal's own `params`, and are said in the sentence the refusal of a save is.
 */
export function problemSentence(code: string, sent: unknown, t: ProblemLookup): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(PROBLEM_CODES, code)) return undefined;
  const values: Record<string, string | number> = {};
  for (const declared of PROBLEM_CODES[code]) {
    const optional = declared.endsWith("?");
    const name = optional ? declared.slice(0, -1) : declared;
    const value = typeof sent === "object" && sent !== null ? (sent as Record<string, unknown>)[name] : undefined;
    if (typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) values[name] = value;
    else if (optional) values[name] = "";
    else return undefined;
  }
  // A sentence that chooses on its reason says only the reasons it knows, and the clash of a lesson names the other lesson: a reason this
  // web has no words for (a newer gateway's), or a clash that came without the lesson it is with, falls to the gateway's own sentence
  // and not to the sentence's `other` ("Klassen har redan  med , dag  –.").
  if (code === "MASTER_LESSON_REFUSED") {
    const reason = values["reason"];
    if (typeof reason !== "string" || !REFUSAL_REASONS.has(reason)) return undefined;
    if (NAMES_THE_OTHER_LESSON.has(reason) && values["className"] === "") return undefined;
    if (reason === "OTHER_SCHOOL" && values["schools"] === "") return undefined;
  }
  return t(`codes.${code}`, PROBLEM_CODES[code].length > 0 ? values : undefined);
}
