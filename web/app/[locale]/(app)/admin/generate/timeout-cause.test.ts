import { describe, expect, it } from "vitest";
import engineMessages from "@/i18n/__fixtures__/engine-messages.json";
import type { ConflictDetail, TimeoutReport } from "@/lib/queries";
import {
  SHORT_CLOCK_MIN_SECONDS,
  SLOW_SETUP_MIN_SECONDS,
  searchesOf,
  timeoutAccountOf,
  weekLoadThresholdOf,
} from "./timeout-cause";

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

  // The two probes that are not a rule being lifted (optimization-engine/app/messages.py): a teacher of its own on each shared group
  // with the groups run in one parallel block, and the placed lessons released. "En regel gjorde att veckan gick att lösa" and
  // "Lätta på regeln" are not true of either, and the rows under the card say what each found.
  const NOT_RULES = ["PROBE_SOLVED_WITH_OWN_TEACHERS_AND_BLOCK", "PROBE_SOLVED_WITH_PLACEMENTS_RELEASED"];

  it.each(NOT_RULES)("does not count %s as a rule, but says it as the probe it is: a measurement that the week solved, never 'no cause'", (code) => {
    // The engine's own summary names such a probe among "the rules" it found and the rows under the card carry its sentence, so a card
    // that said "No cause could be measured" for a week only this probe solved would contradict both.
    expect(timeoutAccountOf(report(), [solved(code)]).causes).toEqual([{ kind: "PROBE_CHANGED_WEEK", count: 1 }]);
  });

  it("counts the rules and the probes that change the week apart, among probes of both kinds", () => {
    const account = timeoutAccountOf(report(), [
      solved("PROBE_SOLVED_WITH_OWN_TEACHERS_AND_BLOCK"),
      solved("PROBE_SOLVED_WITHOUT_CHANGEOVER"),
      solved("PROBE_SOLVED_WITH_PLACEMENTS_RELEASED"),
    ]);
    expect(account.causes).toEqual([
      { kind: "RULES_MEASURED", count: 1 },
      { kind: "PROBE_CHANGED_WEEK", count: 2 },
    ]);
  });

  it("is not moved by a row that is a probe's summary or another kind of row", () => {
    const summary: ConflictDetail = { category: "TIMEOUT_PROBE", code: "PROBE_NOTHING_HELPED", message: "x", params: {}, resourceNames: [] };
    const elsewhere: ConflictDetail = { category: "REQUIREMENT_DEMAND", code: "PROBE_SOLVED_WITH_PLACEMENTS_RELEASED", message: "x", params: {}, resourceNames: [] };
    expect(timeoutAccountOf(report(), [summary, elsewhere]).causes).toEqual([{ kind: "NOTHING_FOUND" }]);
  });

  it("counts every probe the engine says by 'without' and none of the two it says by 'with', whatever the engine's catalogue holds", () => {
    // The catalogue's own codes (the fixture the engine-message tests hold equal to the engine): a third 'with', or a code of neither
    // shape, is a decision this card has not made, and this is where it is found.
    const probes = Object.keys(engineMessages).filter((code) => code.startsWith("PROBE_SOLVED_"));
    expect(probes.length).toBeGreaterThan(15);
    expect(probes.filter((code) => !code.startsWith("PROBE_SOLVED_WITHOUT_")).sort()).toEqual([...NOT_RULES].sort());
    for (const code of probes) {
      // Every probe the engine can send is said as one of the two, and never as neither.
      const kind = timeoutAccountOf(report(), [solved(code)]).causes[0]!.kind;
      expect(kind, code).toBe(NOT_RULES.includes(code) ? "PROBE_CHANGED_WEEK" : "RULES_MEASURED");
    }
  });
});

describe("the searches that ran", () => {
  const stages = (...searches: Array<[TimeoutReport["stages"][number]["stage"], number]>) =>
    report({
      stages: [{ stage: "PRECHECKS", seconds: 1 }, ...searches.map(([stage, seconds]) => ({ stage, seconds })), { stage: "PROBE", seconds: 5 }],
    });

  it("counts every search step the list shows, the walk's search among them, so the sentence is never less than the list", () => {
    // Measured shape: 60 s of the walk's search and 30 s of the first, under a list that says 60 and 30. `search.phases` has only the
    // second (the engine notes a phase for the two satisfaction searches), and a sentence made of it said one search and 30 s.
    const sites = stages(["SITES", 60], ["SEARCH_CLEAN", 30]);
    expect(searchesOf(sites)).toEqual({ count: 2, seconds: 90 });
    expect(sites.search.phases).toHaveLength(1);
  });

  it("counts the search year by year (YEARS) as a search, and the reading of the start schedule (START) as none (G6b)", () => {
    expect(searchesOf(stages(["SEARCH_CLEAN", 60], ["YEARS", 40], ["SEARCH_CLONE", 50]))).toEqual({ count: 3, seconds: 150 });
    expect(searchesOf(stages(["START", 3], ["SEARCH_CLEAN", 60]))).toEqual({ count: 1, seconds: 60 });
  });

  it("counts the walk's search when it is the only one that ran, and the two satisfaction searches", () => {
    expect(searchesOf(stages(["SITES", 60]))).toEqual({ count: 1, seconds: 60 });
    expect(searchesOf(stages(["SEARCH_CLEAN", 60], ["SEARCH_CLONE", 112.1]))).toEqual({ count: 2, seconds: 172.1 });
  });

  it("does not count the checks, the builds or the probe, and says none when no search began", () => {
    const none = report({ stages: [{ stage: "PRECHECKS", seconds: 1 }, { stage: "BUILD", seconds: 20 }, { stage: "PROBE", seconds: 5 }] });
    expect(searchesOf(none)).toEqual({ count: 0, seconds: 0 });
  });

  it("does not count a search step that took no time: the walk's step is entered, and the engine leaves it at once, when the builds ate the clock", () => {
    // Measured on the engine's own solve with a clock that leaves 0.2 s after two builds of 4.9 s and the walk kept: the stages are
    // PRECHECKS 0, BUILD 9.8, SITES 0, PROBE 0, CP-SAT was never called, and `search.phases` is empty.
    const eaten = report({
      stages: [{ stage: "PRECHECKS", seconds: 0 }, { stage: "BUILD", seconds: 9.8 }, { stage: "SITES", seconds: 0 }, { stage: "PROBE", seconds: 0 }],
      search: { solutions: 0, phases: [] },
    });
    expect(searchesOf(eaten)).toEqual({ count: 0, seconds: 0 });
    // And one that ran is counted beside it: SITES 0 s and a first search of 0.6 s are one search.
    expect(searchesOf(stages(["SITES", 0], ["SEARCH_CLEAN", 0.6]))).toEqual({ count: 1, seconds: 0.6 });
  });

  it("rounds the sum to a tenth, as the list's own figures are", () => {
    expect(searchesOf(stages(["SITES", 0.1], ["SEARCH_CLEAN", 0.2])).seconds).toBe(0.3);
  });
});

describe("the threshold the week load counts against", () => {
  const notCounted = (params: ConflictDetail["params"]): ConflictDetail => ({
    category: "REQUIREMENT_DEMAND",
    code: "WEEK_LOAD_NOT_COUNTED",
    message: "…",
    params,
    resourceNames: [],
  });

  it("is the percent the engine's own row carries, and not a number written into the text", () => {
    expect(weekLoadThresholdOf([tight("7", 94), notCounted({ seconds: 4, percent: 90 })])).toBe(90);
    expect(weekLoadThresholdOf([notCounted({ seconds: 4, percent: 85 })])).toBe(85);
  });

  it("is not known without the row, or when the row carries no figure", () => {
    expect(weekLoadThresholdOf([])).toBeNull();
    expect(weekLoadThresholdOf([tight("7", 94)])).toBeNull();
    expect(weekLoadThresholdOf([notCounted({ seconds: 4 })])).toBeNull();
    expect(weekLoadThresholdOf([notCounted(null)])).toBeNull();
    expect(weekLoadThresholdOf([notCounted({ percent: "85" })])).toBeNull();
    expect(weekLoadThresholdOf([notCounted({ percent: Number.NaN })])).toBeNull();
  });

  it("is a threshold of 0 when the row says 0: a number is a number, and only a missing one is none", () => {
    expect(weekLoadThresholdOf([notCounted({ seconds: 4, percent: 0 })])).toBe(0);
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
