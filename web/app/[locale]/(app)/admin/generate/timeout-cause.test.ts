import { describe, expect, it } from "vitest";
import type { ConflictDetail, TimeoutReport } from "@/lib/queries";
import { SHORT_CLOCK_MIN_SECONDS, SLOW_SETUP_MIN_SECONDS, timeoutAccountOf } from "./timeout-cause";

/*
 * THE CAUSE OF A RUN THAT RAN OUT OF TIME (omgång 13, M2). What the engine measured is read into a short list of causes, each
 * said as what it is: measured, proved at least, or a fact about the run. The figures of a tight week are lower bounds, so nothing
 * here ranks them.
 */

const report = (over: Partial<TimeoutReport> = {}): TimeoutReport => ({
  totalSeconds: 183.4,
  budgetSeconds: 180,
  configuredBudgetSeconds: 180,
  callerWaitSeconds: null,
  stages: [
    { stage: "PRECHECKS", seconds: 0.9 },
    { stage: "BUILD", seconds: 7.8 },
    { stage: "SEARCH_CLEAN", seconds: 60 },
    { stage: "SEARCH_CLONE", seconds: 112.1 },
    { stage: "PROBE", seconds: 2.6 },
  ],
  search: { solutions: 0, phases: [{ phase: "CLEAN", seconds: 60, conflicts: 12, branches: 34 }] },
  weekLoadCut: false,
  ...over,
});

const tight = (grades: string, percent: number): ConflictDetail => ({
  category: "REQUIREMENT_DEMAND",
  code: "TIGHT_WEEK_LOAD",
  message: `Year ${grades} needs at least … (${percent} %).`,
  params: { grades, demandMinutes: 2120, capacityMinutes: 2275, percent },
  resourceNames: [],
});

const solved = (code: string): ConflictDetail => ({
  category: "TIMEOUT_PROBE",
  code,
  message: "With the margin set to 0, a timetable was found in 3 s.",
  params: { seconds: 3 },
  resourceNames: [],
});

describe("a run that found nothing to say", () => {
  it("says so, and nothing is guessed", () => {
    expect(timeoutAccountOf(report(), [])).toEqual({ causes: [{ kind: "NOTHING_FOUND" }], weekLoadCut: false });
  });

  it("carries the week load's cut beside the causes, and never turns it into a cause of its own", () => {
    expect(timeoutAccountOf(report({ weekLoadCut: true }), [])).toEqual({
      causes: [{ kind: "NOTHING_FOUND" }],
      weekLoadCut: true,
    });
    expect(timeoutAccountOf(report({ weekLoadCut: true }), [tight("7", 94)]).weekLoadCut).toBe(true);
  });
});

describe("the rules a probe found", () => {
  it("counts each rule that, relaxed, let the week solve", () => {
    const account = timeoutAccountOf(report(), [solved("PROBE_SOLVED_WITHOUT_CHANGEOVER"), solved("PROBE_SOLVED_WITHOUT_PUPIL_BUFFERS")]);
    expect(account.causes).toEqual([{ kind: "RULES_MEASURED", count: 2 }]);
  });

  it("does not count the probe's 'could not measure the walk' row, which found nothing", () => {
    const unmeasured: ConflictDetail = { ...solved("PROBE_TRAVEL_UNMEASURED"), message: "The walk was not measured." };
    expect(timeoutAccountOf(report(), [unmeasured]).causes).toEqual([{ kind: "NOTHING_FOUND" }]);
  });

  it("does not count a row of another category, nor a row with no code", () => {
    const other: ConflictDetail = { ...solved("PROBE_SOLVED_WITHOUT_CHANGEOVER"), category: "REQUIREMENT_DEMAND" };
    const nameless: ConflictDetail = { category: "TIMEOUT_PROBE", message: "x" };
    expect(timeoutAccountOf(report(), [other, nameless]).causes).toEqual([{ kind: "NOTHING_FOUND" }]);
  });
});

describe("a tight week: lower bounds that are never ranked", () => {
  it("lists the years in grade order, whatever order the rows came in (and so not by weight)", () => {
    const heaviestFirst = timeoutAccountOf(report(), [tight("9", 97), tight("7", 91), tight("8", 94)]);
    const lightestFirst = timeoutAccountOf(report(), [tight("7", 91), tight("8", 94), tight("9", 97)]);

    const years = [{ grades: "7", percent: 91 }, { grades: "8", percent: 94 }, { grades: "9", percent: 97 }];
    expect(heaviestFirst.causes).toEqual([{ kind: "TIGHT_WEEK", years }]);
    expect(lightestFirst.causes).toEqual([{ kind: "TIGHT_WEEK", years }]);
    // And the order does not follow the figures: a lighter year can come after a heavier one.
    expect(timeoutAccountOf(report(), [tight("9", 86), tight("7", 99)]).causes).toEqual([
      { kind: "TIGHT_WEEK", years: [{ grades: "7", percent: 99 }, { grades: "9", percent: 86 }] },
    ]);
  });

  it("puts the classes whose years are unknown last, as a year of their own", () => {
    expect(timeoutAccountOf(report(), [tight("any", 90), tight("4", 88)]).causes).toEqual([
      { kind: "TIGHT_WEEK", years: [{ grades: "4", percent: 88 }, { grades: "any", percent: 90 }] },
    ]);
  });

  it("says a year once: counted in two weeks, the larger of two lower bounds is a lower bound too", () => {
    expect(timeoutAccountOf(report(), [tight("7", 88), tight("7", 93), tight("7", 90)]).causes).toEqual([
      { kind: "TIGHT_WEEK", years: [{ grades: "7", percent: 93 }] },
    ]);
  });

  it("skips a row that does not carry a year and a figure", () => {
    const noFigure: ConflictDetail = { ...tight("7", 90), params: { grades: "7" } };
    const noYear: ConflictDetail = { ...tight("7", 90), params: { percent: 90 } };
    expect(timeoutAccountOf(report(), [noFigure, noYear]).causes).toEqual([{ kind: "NOTHING_FOUND" }]);
  });
});

describe("a search that was given less than it is set to have", () => {
  it("is a cause when it lacks the least that is worth saying, with the caller's wait where it was said", () => {
    const wait = timeoutAccountOf(report({ budgetSeconds: 175, configuredBudgetSeconds: 180, callerWaitSeconds: 94 }), []);
    expect(SHORT_CLOCK_MIN_SECONDS).toBe(5);
    expect(wait.causes).toEqual([
      { kind: "SHORT_CLOCK", budgetSeconds: 175, configuredBudgetSeconds: 180, callerWaitSeconds: 94 },
    ]);
    expect(timeoutAccountOf(report({ budgetSeconds: 94, callerWaitSeconds: null }), []).causes).toEqual([
      { kind: "SHORT_CLOCK", budgetSeconds: 94, configuredBudgetSeconds: 180, callerWaitSeconds: null },
    ]);
  });

  it("is no cause for a second or two, which is rounding", () => {
    expect(timeoutAccountOf(report({ budgetSeconds: 176 }), []).causes).toEqual([{ kind: "NOTHING_FOUND" }]);
  });
});

describe("a setup that took a large part of the run", () => {
  const slow = (setup: number, total: number) =>
    report({
      totalSeconds: total,
      stages: [
        { stage: "PRECHECKS", seconds: setup / 2 },
        { stage: "BUILD", seconds: setup / 2 },
        { stage: "SEARCH_CLEAN", seconds: total - setup },
      ],
    });

  it("is said when it is a quarter of the run and at least ten seconds", () => {
    expect(SLOW_SETUP_MIN_SECONDS).toBe(10);
    expect(timeoutAccountOf(slow(50, 200), []).causes).toEqual([{ kind: "SLOW_SETUP", setupSeconds: 50, totalSeconds: 200 }]);
  });

  it("is not said below a quarter, nor below ten seconds however large a share", () => {
    expect(timeoutAccountOf(slow(49, 200), []).causes).toEqual([{ kind: "NOTHING_FOUND" }]);
    expect(timeoutAccountOf(slow(9, 20), []).causes).toEqual([{ kind: "NOTHING_FOUND" }]);
  });

  it("counts the checks and the builds as the setup, and the walk's own search, the two searches and the probe not at all", () => {
    // The list above the cause says "Sökning med restid mellan skolområden: 60 s" for SITES: a search, so not a part of "kontrollerna
    // och förberedelserna", and a sentence naming 5 s and 10 s must not give 75.
    const withSites = report({
      totalSeconds: 148,
      stages: [
        { stage: "PRECHECKS", seconds: 5 },
        { stage: "BUILD", seconds: 10 },
        { stage: "SITES", seconds: 60 },
        { stage: "SEARCH_CLEAN", seconds: 60 },
        { stage: "PROBE", seconds: 13 },
      ],
    });
    expect(timeoutAccountOf(withSites, []).causes).toEqual([{ kind: "NOTHING_FOUND" }]);

    const slowChecks = report({
      totalSeconds: 100,
      stages: [
        { stage: "PRECHECKS", seconds: 15 },
        { stage: "BUILD", seconds: 12 },
        { stage: "SITES", seconds: 12 },
        { stage: "SEARCH_CLEAN", seconds: 48 },
        { stage: "PROBE", seconds: 13 },
      ],
    });
    expect(timeoutAccountOf(slowChecks, []).causes).toEqual([{ kind: "SLOW_SETUP", setupSeconds: 27, totalSeconds: 100 }]);
  });

  it("is not said of a run that took no time at all", () => {
    expect(timeoutAccountOf(report({ totalSeconds: 0, stages: [] }), []).causes).toEqual([{ kind: "NOTHING_FOUND" }]);
  });
});

describe("several causes at once", () => {
  it("are said in the order of how well each is known: measured, proved, then the facts about the run", () => {
    const account = timeoutAccountOf(
      report({ budgetSeconds: 94, callerWaitSeconds: 99, totalSeconds: 100, stages: [{ stage: "BUILD", seconds: 40 }] }),
      [tight("8", 90), solved("PROBE_SOLVED_WITHOUT_CHANGEOVER")],
    );

    expect(account.causes.map((cause) => cause.kind)).toEqual(["RULES_MEASURED", "TIGHT_WEEK", "SHORT_CLOCK", "SLOW_SETUP"]);
  });
});
