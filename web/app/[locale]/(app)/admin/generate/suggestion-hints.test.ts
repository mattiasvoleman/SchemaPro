import { describe, expect, it } from "vitest";
import type { ConflictDetail } from "@/lib/queries";
import { hintsOf } from "./suggestion-hints";

/*
 * WHAT A REFUSED OR TIMED-OUT RUN ALREADY SAYS (suggestion-hints.ts): a floor for a cap, and what a probe measured. Neither is a solution
 * and neither says "solves": a floor is "at least", a measurement says no figure.
 */

const RULE = "11111111-1111-4111-8111-111111111111";

const probe = (code: string): ConflictDetail => ({ category: "TIMEOUT_PROBE", code, message: "…", params: { seconds: 4 }, resourceNames: [] });
const run = (over: Record<string, unknown> = {}) => ({
  errorCode: null as string | null,
  errorParams: null as Record<string, string | number> | null,
  conflicts: [] as ConflictDetail[],
  solverStatus: "INFEASIBLE" as "INFEASIBLE" | "TIMEOUT" | null,
  ...over,
});

describe("a cap the week cannot hold", () => {
  it("is at least the lesson itself when a lesson is longer than the cap: exact, and the least that works", () => {
    const hints = hintsOf(run({ errorCode: "TEACHER_LESSON_LONGER_THAN_DAILY_CAP", errorParams: { rule: RULE, minutes: 45, lessonMinutes: 60 } }));
    expect(hints).toEqual([{ kind: "CAP_AT_LEAST", workRuleId: RULE, minutes: 60, because: "LESSON" }]);
  });

  it("is at least the week's minutes over the school days, rounded up to the grid: a floor, since locked lessons only raise it", () => {
    // 1 500 minutes over 5 days is 300 a day; 1 520 over 5 is 304, which goes up to 305.
    expect(hintsOf(run({ errorCode: "TEACHER_DAILY_CAP_TOO_SMALL_FOR_WEEK", errorParams: { rule: RULE, minutes: 240, days: 5, weekMinutes: 1500 } }))).toEqual([
      { kind: "CAP_AT_LEAST", workRuleId: RULE, minutes: 300, because: "WEEK" },
    ]);
    expect(hintsOf(run({ errorCode: "TEACHER_DAILY_CAP_TOO_SMALL_FOR_WEEK", errorParams: { rule: RULE, minutes: 240, days: 5, weekMinutes: 1520 } }))[0]).toMatchObject({ minutes: 305 });
    expect(hintsOf(run({ errorCode: "TEACHER_DAILY_CAP_TOO_SMALL_FOR_WEEK", errorParams: { rule: RULE, minutes: 240, days: 3, weekMinutes: 400 } }))[0]).toMatchObject({ minutes: 135 });
  });

  it("names no work rule when the refusal named none, and still says the figure", () => {
    expect(hintsOf(run({ errorCode: "TEACHER_LESSON_LONGER_THAN_DAILY_CAP", errorParams: { minutes: 45, lessonMinutes: 60 } }))).toEqual([
      { kind: "CAP_AT_LEAST", workRuleId: null, minutes: 60, because: "LESSON" },
    ]);
  });

  it.each([
    ['no figure', { rule: RULE }],
    ['a figure that is not a count', { rule: RULE, lessonMinutes: "sixty" }],
    ['a count of zero', { rule: RULE, lessonMinutes: 0 }],
    ['a count that is not whole', { rule: RULE, lessonMinutes: 45.5 }],
    ['a count beyond belief', { rule: RULE, lessonMinutes: 1_000_000 }],
  ])("says nothing for a refusal with %s: a figure is never guessed", (_name, params) => {
    expect(hintsOf(run({ errorCode: "TEACHER_LESSON_LONGER_THAN_DAILY_CAP", errorParams: params }))).toEqual([]);
  });

  it("says nothing for a week with no days, or with no minutes, which no school has", () => {
    expect(hintsOf(run({ errorCode: "TEACHER_DAILY_CAP_TOO_SMALL_FOR_WEEK", errorParams: { rule: RULE, days: 0, weekMinutes: 100 } }))).toEqual([]);
    expect(hintsOf(run({ errorCode: "TEACHER_DAILY_CAP_TOO_SMALL_FOR_WEEK", errorParams: { rule: RULE, days: 5 } }))).toEqual([]);
  });

  it("says nothing for any other refusal, and for a run with no params", () => {
    expect(hintsOf(run({ errorCode: "LUNCH_WINDOW_SHORTER_THAN_BREAK", errorParams: { lessonMinutes: 60 } }))).toEqual([]);
    expect(hintsOf(run({ errorCode: "TEACHER_LESSON_LONGER_THAN_DAILY_CAP", errorParams: null }))).toEqual([]);
    expect(hintsOf(run())).toEqual([]);
  });
});

describe("what a timeout's probe measured", () => {
  it("names each rule that was in the way, once, and says no figure", () => {
    const hints = hintsOf(run({
      solverStatus: "TIMEOUT",
      conflicts: [
        probe("PROBE_SOLVED_WITHOUT_TEACHER_DAILY_CAP"),
        probe("PROBE_SOLVED_WITHOUT_TEACHER_DAILY_CAP"),
        probe("PROBE_SOLVED_WITHOUT_TEACHER_DAY_LIMITS"),
        probe("PROBE_SOLVED_WITHOUT_DISTRIBUTION"),
      ],
    }));
    expect(hints).toEqual([
      { kind: "MEASURED", rule: "TEACHER_DAILY_CAP" },
      { kind: "MEASURED", rule: "TEACHER_WORK_DAYS" },
      { kind: "MEASURED", rule: "SUBJECT_SPREAD" },
    ]);
  });

  it("leaves out a probe about a rule that is none of the five: the card says what it can act on", () => {
    expect(hintsOf(run({ solverStatus: "TIMEOUT", conflicts: [probe("PROBE_SOLVED_WITHOUT_LUNCH"), probe("PROBE_SOLVED_WITHOUT_TRAVEL")] }))).toEqual([]);
  });

  it("reads only a TIMEOUT's probe rows: a refusal's rows are not a measurement", () => {
    expect(hintsOf(run({ solverStatus: "INFEASIBLE", conflicts: [probe("PROBE_SOLVED_WITHOUT_TEACHER_DAILY_CAP")] }))).toEqual([]);
  });

  it("reads only the rows of the probe: another category with a probe's code is not one", () => {
    const other: ConflictDetail = { category: "REQUIREMENT_DEMAND", code: "PROBE_SOLVED_WITHOUT_TEACHER_DAILY_CAP", message: "…", params: {}, resourceNames: [] };
    expect(hintsOf(run({ solverStatus: "TIMEOUT", conflicts: [other] }))).toEqual([]);
  });

  it("puts a refusal's floor before a measurement", () => {
    const hints = hintsOf(run({
      solverStatus: "TIMEOUT",
      errorCode: "TEACHER_LESSON_LONGER_THAN_DAILY_CAP",
      errorParams: { rule: RULE, lessonMinutes: 60 },
      conflicts: [probe("PROBE_SOLVED_WITHOUT_TEACHER_DAILY_CAP")],
    }));
    expect(hints.map((hint) => hint.kind)).toEqual(["CAP_AT_LEAST", "MEASURED"]);
  });
});
