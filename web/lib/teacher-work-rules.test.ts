import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import {
  DAY_CAP_MINUTES_MAX,
  DAY_CAP_MINUTES_MIN,
  EMPTY_DRAFT,
  LUNCH_MINUTES_MAX,
  LUNCH_MINUTES_MIN,
  REST_MINUTES_MAX,
  REST_MINUTES_MIN,
  SUGGESTED_DRAFT,
  draftToBody,
  isEmptyDraft,
  ruleToDraft,
  validateDraft,
  type TeacherWorkRule,
  type WorkRuleDraft,
  type WorkRuleProblem,
} from "@/lib/teacher-work-rules";

/**
 * What this file guards: the difference between NOTHING SAID and ZERO.
 *
 * Every other rule this app sends the solver is a closing — an hour a room or a
 * teacher cannot be used — and an absent row there means "no restriction". Here
 * an absent NUMBER means the same thing while a present 0 would be a promise the
 * solver has to keep and cannot, so each of the six fields has to survive the
 * round trip as null rather than as a number. A regression would not throw: the
 * form would look right, the save would succeed, and the school would find out
 * when a week it has always been able to generate came back refused.
 *
 * The bounds and the all-or-nothing trio are the table's CHECK constraints and
 * the DTO's too. They are repeated here because only this copy can produce a
 * Swedish sentence naming the half the reader left out, and a 400 relayed from
 * the gateway is English prose written for a log.
 */

const draft = (overrides: Partial<WorkRuleDraft> = {}): WorkRuleDraft => ({
  ...EMPTY_DRAFT,
  ...overrides,
});

const fullLunch = {
  lunchMinutes: "30",
  lunchStartTime: "10:30",
  lunchEndTime: "13:30",
};

const rule = (overrides: Partial<TeacherWorkRule> = {}): TeacherWorkRule => ({
  id: "w1",
  userId: "t-1",
  lunchMinutes: 30,
  lunchStartTime: "10:30:00",
  lunchEndTime: "13:30:00",
  minDailyRestMinutes: 660,
  maxTeachingMinutesPerDay: null,
  preferredFreeDayOfWeek: null,
  ...overrides,
});

describe("an empty row", () => {
  it("is empty, and that is a legitimate answer rather than a refusal", () => {
    expect(isEmptyDraft(EMPTY_DRAFT)).toBe(true);
    expect(validateDraft(EMPTY_DRAFT)).toBeNull();
  });

  it("is still empty when the fields hold nothing but spaces", () => {
    // A value pasted out of a spreadsheet arrives with them, and " " saved as a
    // rule would be Number(" ") === 0 by the time it reached the column.
    expect(isEmptyDraft(draft({ lunchMinutes: "  ", minDailyRestMinutes: " " }))).toBe(true);
  });

  it("sends six nulls, never six zeroes", () => {
    expect(draftToBody(EMPTY_DRAFT)).toEqual({
      lunchMinutes: null,
      lunchStartTime: null,
      lunchEndTime: null,
      minDailyRestMinutes: null,
      maxTeachingMinutesPerDay: null,
      preferredFreeDayOfWeek: null,
    });
  });

  it("is what a teacher with no stored row starts from", () => {
    expect(ruleToDraft(undefined)).toEqual(EMPTY_DRAFT);
  });

  it("is what a row of nulls reads back as", () => {
    // Legal by the table's CHECK, so it can exist however the row was written;
    // it must not render as a rule. hasAnyRule's half of this is in
    // components/schedule/teacher-work-time-summary.test.tsx.
    const nulls = rule({
      lunchMinutes: null,
      lunchStartTime: null,
      lunchEndTime: null,
      minDailyRestMinutes: null,
    });
    expect(isEmptyDraft(ruleToDraft(nulls))).toBe(true);
  });

  it("is not empty while it holds only a cap, or only a wish", () => {
    /*
     * The dialog DELETES the row when the draft is empty. A cap or a wish
     * that did not count here would be deleted with the lunch somebody
     * cleared beside it, and the generator would lose a rule nobody took away.
     */
    expect(isEmptyDraft(draft({ maxTeachingMinutesPerDay: "300" }))).toBe(false);
    expect(isEmptyDraft(draft({ preferredFreeDayOfWeek: "5" }))).toBe(false);
    expect(isEmptyDraft(draft({ maxTeachingMinutesPerDay: " ", preferredFreeDayOfWeek: " " }))).toBe(true);
  });
});

describe("the lunch trio, which is all-or-nothing", () => {
  it("refuses minutes without a window", () => {
    expect(validateDraft(draft({ lunchMinutes: "30" }))).toEqual({
      reason: "lunchTrioIncomplete",
    });
  });

  it("refuses a window without minutes", () => {
    expect(
      validateDraft(draft({ lunchStartTime: "10:30", lunchEndTime: "13:30" })),
    ).toEqual({ reason: "lunchTrioIncomplete" });
  });

  it("refuses two of the three", () => {
    expect(validateDraft(draft({ lunchMinutes: "30", lunchStartTime: "10:30" }))).toEqual({
      reason: "lunchTrioIncomplete",
    });
  });

  it("accepts all three", () => {
    expect(validateDraft(draft(fullLunch))).toBeNull();
  });

  it("counts a half-typed clock as not filled in", () => {
    /*
     * An unparseable time would otherwise reach timeToMinutes, which answers
     * NaN — and every comparison against NaN is false, so a window of "10:3"
     * would pass both the backwards check and the width check and be saved.
     * Treated as empty it lands on the trio rule, which is a sentence the
     * reader can act on.
     */
    expect(
      validateDraft(draft({ ...fullLunch, lunchEndTime: "13:3" })),
    ).toEqual({ reason: "lunchTrioIncomplete" });
  });
});

describe("the lunch bounds", () => {
  it("refuses a length below the floor", () => {
    expect(validateDraft(draft({ ...fullLunch, lunchMinutes: "4" }))).toEqual({
      reason: "lunchMinutesOutOfRange",
      min: LUNCH_MINUTES_MIN,
      max: LUNCH_MINUTES_MAX,
    });
  });

  it("refuses a length above the ceiling", () => {
    expect(validateDraft(draft({ ...fullLunch, lunchMinutes: "245" }))).toEqual({
      reason: "lunchMinutesOutOfRange",
      min: LUNCH_MINUTES_MIN,
      max: LUNCH_MINUTES_MAX,
    });
  });

  it("accepts both ends of the range", () => {
    expect(
      validateDraft(draft({ ...fullLunch, lunchMinutes: String(LUNCH_MINUTES_MIN) })),
    ).toBeNull();
    expect(
      validateDraft(
        draft({
          lunchMinutes: String(LUNCH_MINUTES_MAX),
          lunchStartTime: "08:00",
          lunchEndTime: "12:00",
        }),
      ),
    ).toBeNull();
  });

  it("reports a fractional length as a length, not as a grid problem", () => {
    // 30.5 fails both rules; the reader typed a number, so the message is
    // about the number.
    expect(validateDraft(draft({ ...fullLunch, lunchMinutes: "30.5" }))).toEqual({
      reason: "lunchMinutesOutOfRange",
      min: LUNCH_MINUTES_MIN,
      max: LUNCH_MINUTES_MAX,
    });
  });

  it("refuses a length off the solver's five-minute grid", () => {
    expect(validateDraft(draft({ ...fullLunch, lunchMinutes: "32" }))).toEqual({
      reason: "lunchMinutesOffGrid",
      step: 5,
    });
  });
});

describe("the lunch window", () => {
  it("refuses an end before its start", () => {
    expect(
      validateDraft(draft({ ...fullLunch, lunchStartTime: "13:30", lunchEndTime: "10:30" })),
    ).toEqual({ reason: "lunchWindowBackwards" });
  });

  it("refuses a window of no width at all", () => {
    expect(
      validateDraft(draft({ ...fullLunch, lunchEndTime: "10:30" })),
    ).toEqual({ reason: "lunchWindowBackwards" });
  });

  it("refuses a window narrower than the lunch it must hold", () => {
    expect(
      validateDraft(
        draft({ lunchMinutes: "45", lunchStartTime: "11:00", lunchEndTime: "11:30" }),
      ),
    ).toEqual({ reason: "lunchWindowTooNarrow", minutes: 45, window: 30 });
  });

  it("accepts a window exactly as wide as the lunch", () => {
    // One placement, and the solver has to find it — narrow, not impossible.
    expect(
      validateDraft(
        draft({ lunchMinutes: "30", lunchStartTime: "11:00", lunchEndTime: "11:30" }),
      ),
    ).toBeNull();
  });

  it("refuses an edge off the five-minute grid, at either end", () => {
    /*
     * A separate rule from the lunch's own length, and one the TABLE does not
     * enforce — the gateway's assertLunchFits is what refuses it. A window from
     * 10:32 gives the solver 10:35 as its first legal start, so a school that
     * wrote exactly `lunchMinutes` of room silently gets three minutes less than
     * it asked for.
     */
    expect(
      validateDraft(draft({ ...fullLunch, lunchStartTime: "10:32" })),
    ).toEqual({ reason: "lunchWindowOffGrid", step: 5 });
    expect(
      validateDraft(draft({ ...fullLunch, lunchEndTime: "13:33" })),
    ).toEqual({ reason: "lunchWindowOffGrid", step: 5 });
  });

  it("checks the width before the grid, the order the gateway checks them in", () => {
    // Two copies of a rule that disagree about WHICH refusal comes first show a
    // school one sentence in the form and a different one from the API.
    expect(
      validateDraft(
        draft({ lunchMinutes: "45", lunchStartTime: "11:02", lunchEndTime: "11:32" }),
      ),
    ).toEqual({ reason: "lunchWindowTooNarrow", minutes: 45, window: 30 });
  });
});

describe("the rest rule, which stands on its own", () => {
  it("is allowed with no lunch rule beside it", () => {
    expect(validateDraft(draft({ minDailyRestMinutes: "660" }))).toBeNull();
    expect(draftToBody(draft({ minDailyRestMinutes: "660" }))).toEqual({
      lunchMinutes: null,
      lunchStartTime: null,
      lunchEndTime: null,
      minDailyRestMinutes: 660,
      maxTeachingMinutesPerDay: null,
      preferredFreeDayOfWeek: null,
    });
  });

  it("refuses less than the floor", () => {
    expect(validateDraft(draft({ minDailyRestMinutes: "59" }))).toEqual({
      reason: "restOutOfRange",
      min: REST_MINUTES_MIN,
      max: REST_MINUTES_MAX,
    });
  });

  it("refuses more than the ceiling", () => {
    expect(validateDraft(draft({ minDailyRestMinutes: "1321" }))).toEqual({
      reason: "restOutOfRange",
      min: REST_MINUTES_MIN,
      max: REST_MINUTES_MAX,
    });
  });

  it("accepts both ends of the range", () => {
    expect(
      validateDraft(draft({ minDailyRestMinutes: String(REST_MINUTES_MIN) })),
    ).toBeNull();
    expect(
      validateDraft(draft({ minDailyRestMinutes: String(REST_MINUTES_MAX) })),
    ).toBeNull();
  });

  it("refuses a fractional number of minutes", () => {
    expect(validateDraft(draft({ minDailyRestMinutes: "660.5" }))).toEqual({
      reason: "restOutOfRange",
      min: REST_MINUTES_MIN,
      max: REST_MINUTES_MAX,
    });
  });

  it("is reported even when the lunch trio beside it is fine", () => {
    expect(
      validateDraft(draft({ ...fullLunch, minDailyRestMinutes: "30" })),
    ).toEqual({ reason: "restOutOfRange", min: REST_MINUTES_MIN, max: REST_MINUTES_MAX });
  });
});

describe("the round trip", () => {
  it("cuts the seconds PostgREST adds, so the time inputs accept the value", () => {
    // An `<input type="time">` renders EMPTY for "10:30:00" rather than
    // complaining, which looks exactly like a teacher who has no lunch rule —
    // and one unrelated save would then clear the rule.
    expect(ruleToDraft(rule())).toEqual({
      lunchMinutes: "30",
      lunchStartTime: "10:30",
      lunchEndTime: "13:30",
      minDailyRestMinutes: "660",
      maxTeachingMinutesPerDay: "",
      preferredFreeDayOfWeek: "",
    });
  });

  it("sends HH:MM and real numbers", () => {
    expect(draftToBody(ruleToDraft(rule()))).toEqual({
      lunchMinutes: 30,
      lunchStartTime: "10:30",
      lunchEndTime: "13:30",
      minDailyRestMinutes: 660,
      maxTeachingMinutesPerDay: null,
      preferredFreeDayOfWeek: null,
    });
  });

  it("keeps a rest-only row rest-only", () => {
    const restOnly = rule({
      lunchMinutes: null,
      lunchStartTime: null,
      lunchEndTime: null,
    });
    expect(draftToBody(ruleToDraft(restOnly))).toEqual({
      lunchMinutes: null,
      lunchStartTime: null,
      lunchEndTime: null,
      minDailyRestMinutes: 660,
      maxTeachingMinutesPerDay: null,
      preferredFreeDayOfWeek: null,
    });
  });

  it("carries a stored cap and wish through the form and back as numbers", () => {
    // The form names every key, so a cap it had not read would be sent as
    // null by the next lunch somebody saved, and the cap would be gone.
    const stored = rule({ maxTeachingMinutesPerDay: 270, preferredFreeDayOfWeek: 5 });
    expect(ruleToDraft(stored)).toMatchObject({
      maxTeachingMinutesPerDay: "270",
      preferredFreeDayOfWeek: "5",
    });
    expect(draftToBody(ruleToDraft(stored))).toMatchObject({
      maxTeachingMinutesPerDay: 270,
      preferredFreeDayOfWeek: 5,
    });
  });

  it("opens a row without the two newer keys as nothing said, not as the word undefined", () => {
    const { maxTeachingMinutesPerDay: _cap, preferredFreeDayOfWeek: _day, ...older } = rule();
    const draftOf = ruleToDraft(older as TeacherWorkRule);
    expect(draftOf).toMatchObject({ maxTeachingMinutesPerDay: "", preferredFreeDayOfWeek: "" });
    // And the lunch on the same row stays savable.
    expect(validateDraft(draftOf)).toBeNull();
  });

  it("names every key in the body, including the null ones", () => {
    /*
     * A PATCH that omits a field leaves the stored value alone, so a body built
     * from the filled fields only would make clearing the lunch rule
     * impossible: the reader empties the three boxes, presses Spara, and the old
     * rule is still there at the next generation run.
     */
    expect(Object.keys(draftToBody(EMPTY_DRAFT)).sort()).toEqual([
      "lunchEndTime",
      "lunchMinutes",
      "lunchStartTime",
      "maxTeachingMinutesPerDay",
      "minDailyRestMinutes",
      "preferredFreeDayOfWeek",
    ]);
  });
});

describe("the suggestion", () => {
  it("is the settled values: 30 minutes inside 10:30-13:30 and 11 hours", () => {
    expect(SUGGESTED_DRAFT).toEqual({
      lunchMinutes: "30",
      lunchStartTime: "10:30",
      lunchEndTime: "13:30",
      minDailyRestMinutes: "660",
      maxTeachingMinutesPerDay: "",
      preferredFreeDayOfWeek: "",
    });
  });

  it("never carries a cap or a free day", () => {
    // A suggested cap would be a hard rule nobody chose: the next run of a
    // school that only wanted the lunch would be refused over it.
    expect(draftToBody(SUGGESTED_DRAFT)).toMatchObject({
      maxTeachingMinutesPerDay: null,
      preferredFreeDayOfWeek: null,
    });
  });

  it("is itself savable, which is the only thing that makes it a suggestion", () => {
    expect(validateDraft(SUGGESTED_DRAFT)).toBeNull();
  });
});

describe("the day's cap, which stands on its own", () => {
  it("is allowed with nothing else on the row, and sent as a number", () => {
    expect(validateDraft(draft({ maxTeachingMinutesPerDay: "270" }))).toBeNull();
    expect(draftToBody(draft({ maxTeachingMinutesPerDay: " 270 " }))).toEqual({
      lunchMinutes: null,
      lunchStartTime: null,
      lunchEndTime: null,
      minDailyRestMinutes: null,
      maxTeachingMinutesPerDay: 270,
      preferredFreeDayOfWeek: null,
    });
  });

  it("accepts both ends of the gateway's range", () => {
    expect([DAY_CAP_MINUTES_MIN, DAY_CAP_MINUTES_MAX]).toEqual([30, 720]);
    expect(validateDraft(draft({ maxTeachingMinutesPerDay: "30" }))).toBeNull();
    expect(validateDraft(draft({ maxTeachingMinutesPerDay: "720" }))).toBeNull();
  });

  it("refuses a cap under half an hour or over twelve hours, naming the range", () => {
    for (const value of ["25", "725", "0", "-30", "300.5", "fem"]) {
      expect(validateDraft(draft({ maxTeachingMinutesPerDay: value }))).toEqual({
        reason: "dayCapOutOfRange",
        min: 30,
        max: 720,
      });
    }
  });

  it("refuses a cap off the engine's five-minute grid", () => {
    expect(validateDraft(draft({ maxTeachingMinutesPerDay: "272" }))).toEqual({
      reason: "dayCapOffGrid",
      step: 5,
    });
  });

  it("says a number out of range is out of range, not off the grid", () => {
    // 3001 fails both rules; the reader typed a number, so the message is
    // about the number.
    expect(validateDraft(draft({ maxTeachingMinutesPerDay: "3001" }))).toMatchObject({
      reason: "dayCapOutOfRange",
    });
  });

  it("is reported even when the lunch and the rest beside it are fine", () => {
    expect(
      validateDraft(draft({ ...fullLunch, minDailyRestMinutes: "660", maxTeachingMinutesPerDay: "20" })),
    ).toMatchObject({ reason: "dayCapOutOfRange" });
  });
});

describe("the free-day wish", () => {
  it("takes every ISO weekday, Monday to Sunday, and sends it as a number", () => {
    for (const day of [1, 2, 3, 4, 5, 6, 7]) {
      expect(validateDraft(draft({ preferredFreeDayOfWeek: String(day) }))).toBeNull();
      expect(draftToBody(draft({ preferredFreeDayOfWeek: String(day) })).preferredFreeDayOfWeek).toBe(day);
    }
  });

  it("refuses a value the select never offers rather than sending it as null", () => {
    // A null in the body would clear a stored wish nobody chose to clear.
    for (const value of ["0", "8", "1.5", "fredag"]) {
      expect(validateDraft(draft({ preferredFreeDayOfWeek: value }))).toEqual({
        reason: "freeDayOutOfRange",
      });
    }
  });

  it("is checked after the cap, in the order the dialog draws them", () => {
    expect(
      validateDraft(draft({ maxTeachingMinutesPerDay: "10", preferredFreeDayOfWeek: "9" })),
    ).toMatchObject({ reason: "dayCapOutOfRange" });
  });
});

/**
 * Every refusal has a sentence in both languages.
 *
 * These keys are reached through `t(problem.reason)` — a variable, which is
 * exactly the shape i18n/messages.test.ts skips rather than guesses at. Nothing
 * else would catch a reason added to the union and to no message file: the form
 * would render MISSING_MESSAGE where the explanation belongs, and only for the
 * draft that trips that one rule.
 */
describe("the refusals are translated", () => {
  // Typed as a total record on purpose: a reason added to WorkRuleProblem and
  // not to this map fails the typecheck rather than slipping past the run.
  const REASONS: Record<WorkRuleProblem["reason"], true> = {
    lunchTrioIncomplete: true,
    lunchMinutesOutOfRange: true,
    lunchMinutesOffGrid: true,
    lunchWindowBackwards: true,
    lunchWindowTooNarrow: true,
    lunchWindowOffGrid: true,
    restOutOfRange: true,
    dayCapOutOfRange: true,
    dayCapOffGrid: true,
    freeDayOutOfRange: true,
  };

  it.each(Object.keys(REASONS))("%s reads in Swedish and in English", (reason) => {
    const swedish = (sv.teacherWorkTime as Record<string, string>)[reason];
    const english = (en.teacherWorkTime as Record<string, string>)[reason];
    expect(swedish).toBeTruthy();
    expect(english).toBeTruthy();
  });
});
