import { timeToMinutes } from "@/lib/utils";

/**
 * A teacher's own working time: the lunch they are owed and the night between
 * two teaching days.
 *
 * Mirrors the row in TeacherWorkRules and the engine's
 * `AnonymousTeacherWorkRule`. Clock strings are HH:MM:SS as PostgREST returns
 * them; null where the school has said nothing.
 *
 * NULL IS NOT ZERO, and the difference decides whether a school can still
 * generate a week. Everything else the solver is told about a teacher is a
 * closing — an AvailabilityConstraint saying when they cannot be used — and a
 * missing row there means "always available". Here a missing number means the
 * rule DOES NOT SPEAK about this teacher: not nought minutes of lunch, not "as
 * short as possible". That is also why the column carries no default. A stored
 * 30 would turn every school that has never opened this dialog into a refusal
 * at the next generation run, over a rule nobody had asked for.
 *
 * THE LUNCH TRIO IS ALL-OR-NOTHING. Minutes without a window is a break the
 * solver has nowhere to put, and a window without minutes is a wish rather than
 * a constraint. The table's CHECK says so; `validateDraft` below says so first,
 * so the form can name the missing half in Swedish instead of relaying a 400.
 */
export interface TeacherWorkRule {
  id: string;
  userId: string;
  /** Unbroken minutes of lunch owed, or null for no lunch rule. */
  lunchMinutes: number | null;
  lunchStartTime: string | null;
  lunchEndTime: string | null;
  /**
   * Minutes between the last lesson of one day and the first of the next, or
   * null for no rest rule.
   */
  minDailyRestMinutes: number | null;
}

export const LUNCH_MINUTES_MIN = 5;
export const LUNCH_MINUTES_MAX = 240;
/**
 * The solver places lessons on a five-minute grid, so a lunch of 32 minutes is
 * a number it cannot honour exactly — it would have to round, and a hard rule
 * that quietly rounds is not a hard rule. The table's CHECK enforces the same
 * multiple.
 */
export const LUNCH_MINUTES_STEP = 5;
export const REST_MINUTES_MIN = 60;
export const REST_MINUTES_MAX = 1320;

/**
 * What the form offers when somebody starts filling an EMPTY row.
 *
 * A suggestion and nothing more: it is written into the draft the reader can
 * still change or clear, never into the column and never into a save the reader
 * did not make. Thirty minutes inside 10:30-13:30 is the ordinary Swedish
 * school lunch, and eleven hours is the rest the working-time agreements assume
 * — but a school that disagrees has to be able to say so, and a school that has
 * not thought about it at all must keep the week it already generates.
 */
export const SUGGESTED_DRAFT: WorkRuleDraft = {
  lunchMinutes: "30",
  lunchStartTime: "10:30",
  lunchEndTime: "13:30",
  minDailyRestMinutes: "660",
};

/**
 * The form's own shape: four strings, because "" is the only way a controlled
 * `<input type="number">` can hold "nothing said" — a number-typed state would
 * have to pick 0 or NaN for the empty case, and 0 is precisely the value that
 * must never reach the API.
 */
export interface WorkRuleDraft {
  lunchMinutes: string;
  lunchStartTime: string;
  lunchEndTime: string;
  minDailyRestMinutes: string;
}

export const EMPTY_DRAFT: WorkRuleDraft = {
  lunchMinutes: "",
  lunchStartTime: "",
  lunchEndTime: "",
  minDailyRestMinutes: "",
};

/** The four nullable fields as the gateway takes them. Times are HH:MM. */
export interface WorkRuleBody {
  lunchMinutes: number | null;
  lunchStartTime: string | null;
  lunchEndTime: string | null;
  minDailyRestMinutes: number | null;
}

/**
 * Why a draft cannot be saved. The `reason` is a message key under the
 * `teacherWorkTime` namespace and the rest of the object is that message's ICU
 * arguments, so the dialog renders a refusal without a switch of its own.
 *
 * lib/teacher-work-rules.test.ts checks every reason against both locales:
 * these keys are reached through a variable, which is exactly the shape the
 * i18n sweep in i18n/messages.test.ts skips rather than guesses at.
 */
export type WorkRuleProblem =
  | { reason: "lunchTrioIncomplete" }
  | { reason: "lunchMinutesOutOfRange"; min: number; max: number }
  | { reason: "lunchMinutesOffGrid"; step: number }
  | { reason: "lunchWindowBackwards" }
  | { reason: "lunchWindowTooNarrow"; minutes: number; window: number }
  | { reason: "lunchWindowOffGrid"; step: number }
  | { reason: "restOutOfRange"; min: number; max: number };

/** HH:MM, with optional seconds — what PostgREST sends and what the DTO takes. */
const TIME = /^\d{2}:\d{2}(:\d{2})?$/;

/**
 * A time field's value, or "" when it holds nothing usable.
 *
 * A half-typed `<input type="time">` reports "" in every browser this app
 * supports, but a value restored from a row is not guaranteed to be a clock at
 * all, and `timeToMinutes` answers NaN rather than failing. Treating an
 * unparseable time as EMPTY means the trio rule below catches it — "you have
 * filled in two of three" — instead of a comparison against NaN quietly
 * declaring the window fine.
 */
function clock(value: string): string {
  const trimmed = value.trim();
  return TIME.test(trimmed) ? trimmed : "";
}

/** A whole number of minutes, or null for empty, blank, fractional or negative. */
function wholeMinutes(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Whether the draft says nothing at all — which is a legitimate answer, and the
 * one every teacher starts from.
 */
export function isEmptyDraft(draft: WorkRuleDraft): boolean {
  return (
    draft.lunchMinutes.trim() === "" &&
    clock(draft.lunchStartTime) === "" &&
    clock(draft.lunchEndTime) === "" &&
    draft.minDailyRestMinutes.trim() === ""
  );
}

/**
 * The first reason this draft cannot be saved, or null when it can.
 *
 * Mirrors the table's CHECK constraints and the DTO deliberately — see the
 * migration's preamble for why the constraints exist at all. The point of
 * repeating them here is the sentence: a 400 from the gateway carries English
 * prose written for a log, and the person filling the form needs to be told in
 * Swedish which half of the lunch rule they left out.
 *
 * The order is chosen so the message is about the thing the reader got wrong.
 * The trio comes first, because a missing window makes every later check
 * meaningless; the minutes are validated before the window they are compared
 * against, so a typo of 3000 is reported as a bad length rather than as a
 * window too narrow to hold it.
 */
export function validateDraft(draft: WorkRuleDraft): WorkRuleProblem | null {
  if (isEmptyDraft(draft)) return null;

  const start = clock(draft.lunchStartTime);
  const end = clock(draft.lunchEndTime);
  const lunchFields = [draft.lunchMinutes.trim(), start, end];
  const filled = lunchFields.filter((value) => value !== "").length;

  if (filled > 0 && filled < lunchFields.length) {
    return { reason: "lunchTrioIncomplete" };
  }

  if (filled === lunchFields.length) {
    const minutes = wholeMinutes(draft.lunchMinutes);
    if (
      minutes === null ||
      minutes < LUNCH_MINUTES_MIN ||
      minutes > LUNCH_MINUTES_MAX
    ) {
      return {
        reason: "lunchMinutesOutOfRange",
        min: LUNCH_MINUTES_MIN,
        max: LUNCH_MINUTES_MAX,
      };
    }
    if (minutes % LUNCH_MINUTES_STEP !== 0) {
      return { reason: "lunchMinutesOffGrid", step: LUNCH_MINUTES_STEP };
    }

    const startMinutes = timeToMinutes(start);
    const endMinutes = timeToMinutes(end);
    const window = endMinutes - startMinutes;
    if (window <= 0) return { reason: "lunchWindowBackwards" };
    if (window < minutes) {
      return { reason: "lunchWindowTooNarrow", minutes, window };
    }
    /*
     * The WINDOW'S OWN EDGES have to sit on the grid too, and this is not the
     * same rule as the length above. Nothing in the table forbids 10:32 — the
     * gateway's assertLunchFits is what refuses it, in the same order these
     * checks run — because a window starting at 10:32 gives the solver 10:35 as
     * its first legal start, so a school that wrote exactly `lunchMinutes` of
     * room would silently have three minutes less than it asked for.
     */
    if (
      startMinutes % LUNCH_MINUTES_STEP !== 0 ||
      endMinutes % LUNCH_MINUTES_STEP !== 0
    ) {
      return { reason: "lunchWindowOffGrid", step: LUNCH_MINUTES_STEP };
    }
  }

  if (draft.minDailyRestMinutes.trim() !== "") {
    const rest = wholeMinutes(draft.minDailyRestMinutes);
    if (rest === null || rest < REST_MINUTES_MIN || rest > REST_MINUTES_MAX) {
      return {
        reason: "restOutOfRange",
        min: REST_MINUTES_MIN,
        max: REST_MINUTES_MAX,
      };
    }
  }

  return null;
}

/**
 * The draft as the gateway takes it.
 *
 * All four keys are always present, including the null ones. A PATCH that
 * OMITS a field leaves the stored value alone, so a body built from only the
 * filled fields would make "clear the lunch rule" impossible: the reader would
 * empty the three boxes, press Spara, and find the old rule still there at the
 * next generation run. Only a draft that has already passed `validateDraft`
 * should be sent.
 */
export function draftToBody(draft: WorkRuleDraft): WorkRuleBody {
  const start = clock(draft.lunchStartTime);
  const end = clock(draft.lunchEndTime);
  const minutes = wholeMinutes(draft.lunchMinutes);
  const rest = wholeMinutes(draft.minDailyRestMinutes);

  // Sent as real numbers: the API runs with implicit conversion off, so "30" is
  // not 30 anywhere along the way.
  return {
    lunchMinutes: minutes,
    // HH:MM, the form's own value — every time DTO in the gateway takes it, and
    // the seconds PostgreSQL adds on the way back are cut by `formatTime`.
    lunchStartTime: start === "" ? null : start.slice(0, 5),
    lunchEndTime: end === "" ? null : end.slice(0, 5),
    minDailyRestMinutes: rest,
  };
}

/**
 * A stored row as the form holds it, or the empty draft for a teacher who has
 * no row.
 *
 * The seconds are cut here rather than in the dialog because an
 * `<input type="time">` refuses "10:30:00" outright and renders EMPTY — which
 * looks exactly like a teacher who has no lunch rule, and would let one
 * unrelated save wipe a rule the school set a term ago.
 */
export function ruleToDraft(rule: TeacherWorkRule | undefined): WorkRuleDraft {
  if (!rule) return EMPTY_DRAFT;
  return {
    lunchMinutes: rule.lunchMinutes === null ? "" : String(rule.lunchMinutes),
    lunchStartTime: rule.lunchStartTime === null ? "" : rule.lunchStartTime.slice(0, 5),
    lunchEndTime: rule.lunchEndTime === null ? "" : rule.lunchEndTime.slice(0, 5),
    minDailyRestMinutes:
      rule.minDailyRestMinutes === null ? "" : String(rule.minDailyRestMinutes),
  };
}

/** Whether a stored row says anything at all, as opposed to being four nulls. */
export function hasAnyRule(rule: TeacherWorkRule | undefined): boolean {
  if (!rule) return false;
  return (
    rule.lunchMinutes !== null ||
    rule.lunchStartTime !== null ||
    rule.lunchEndTime !== null ||
    rule.minDailyRestMinutes !== null
  );
}

/**
 * Minutes as hours and the remainder, for reading a rest rule back.
 *
 * 660 is eleven hours to everybody who set it and a meaningless number on a
 * page. The split is done here rather than formatted here because the two cases
 * need two different sentences — "11 timmar" and "9 tim 30 min" — and a
 * locale's decimal comma is the translator's business, not this module's.
 */
export function splitHours(minutes: number): { hours: number; minutes: number } {
  return { hours: Math.floor(minutes / 60), minutes: minutes % 60 };
}
