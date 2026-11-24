import { IntlMessageFormat } from "intl-messageformat";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import { runEnding } from "./run-ending";

/*
 * HOW A RUN THAT GAVE NO ANSWER IS SAID (omgång 13, M2). The page shows the sentence this picks: one that says as
 * much of the gateway's figures as it has, and the plain one each ending always had where it has none.
 */

describe("an engine ceiling that fell (ENGINE_TIMED_OUT)", () => {
  it("says the step the solve was in, with its seconds and the seconds since the request came in, in that order", () => {
    expect(
      runEnding("ENGINE_TIMED_OUT", { ceilingSeconds: 230, stage: "SEARCH_CLONE", stageSeconds: 160, elapsedSeconds: 230 }),
    ).toEqual({
      key: "ENGINE_TIMED_OUT_AT",
      values: { ceilingSeconds: 230, stage: "SEARCH_CLONE", stageSeconds: 160, elapsedSeconds: 230 },
    });
  });

  it.each(["PRECHECKS", "BUILD", "SITES", "SEARCH_CLEAN", "SEARCH_CLONE", "PROBE"])("knows the step %s", (stage) => {
    expect(runEnding("ENGINE_TIMED_OUT", { ceilingSeconds: 40, stage, stageSeconds: 1, elapsedSeconds: 2 })?.key).toBe(
      "ENGINE_TIMED_OUT_AT",
    );
  });

  it("says the ceiling alone from an engine that names no step", () => {
    expect(runEnding("ENGINE_TIMED_OUT", { ceilingSeconds: 230 })).toEqual({
      key: "ENGINE_TIMED_OUT_CEILING",
      values: { ceilingSeconds: 230 },
    });
  });

  it("says the plain sentence when nothing is known, as every run before the figures did", () => {
    expect(runEnding("ENGINE_TIMED_OUT", null)).toEqual({ key: "ENGINE_TIMED_OUT" });
    expect(runEnding("ENGINE_TIMED_OUT", undefined)).toEqual({ key: "ENGINE_TIMED_OUT" });
    expect(runEnding("ENGINE_TIMED_OUT", {})).toEqual({ key: "ENGINE_TIMED_OUT" });
  });

  it("says the step only with all three of its figures, and only for a step it has a sentence for", () => {
    const said = { ceilingSeconds: 230, stage: "BUILD", stageSeconds: 4, elapsedSeconds: 5 };
    for (const without of ["stageSeconds", "elapsedSeconds", "stage"]) {
      const params: Record<string, string | number> = { ...said };
      delete params[without];
      expect(runEnding("ENGINE_TIMED_OUT", params)?.key).toBe("ENGINE_TIMED_OUT_CEILING");
    }
    expect(runEnding("ENGINE_TIMED_OUT", { ...said, stage: "THINKING" })?.key).toBe("ENGINE_TIMED_OUT_CEILING");
    expect(runEnding("ENGINE_TIMED_OUT", { ...said, stage: 7 })?.key).toBe("ENGINE_TIMED_OUT_CEILING");
  });

  it("does not say a figure that is not a number of seconds", () => {
    expect(runEnding("ENGINE_TIMED_OUT", { ceilingSeconds: "230" })).toEqual({ key: "ENGINE_TIMED_OUT" });
    expect(runEnding("ENGINE_TIMED_OUT", { ceilingSeconds: -1 })).toEqual({ key: "ENGINE_TIMED_OUT" });
    expect(runEnding("ENGINE_TIMED_OUT", { ceilingSeconds: Number.NaN })).toEqual({ key: "ENGINE_TIMED_OUT" });
    expect(runEnding("ENGINE_TIMED_OUT", { ceilingSeconds: Number.POSITIVE_INFINITY })).toEqual({ key: "ENGINE_TIMED_OUT" });
    // Zero seconds is a figure: a step that had just begun.
    expect(
      runEnding("ENGINE_TIMED_OUT", { ceilingSeconds: 230, stage: "PROBE", stageSeconds: 0, elapsedSeconds: 0 })?.key,
    ).toBe("ENGINE_TIMED_OUT_AT");
  });
});

describe("the API's own wait that ran out (ENGINE_WAIT_EXPIRED)", () => {
  it("says a wait shorter than the engine can need as that, and not the school's to fix", () => {
    expect(runEnding("ENGINE_WAIT_EXPIRED", { waitSeconds: 120, engineCeilingSeconds: 230 })).toEqual({
      key: "ENGINE_WAIT_EXPIRED_SHORT",
      values: { waitSeconds: 120, engineCeilingSeconds: 230 },
    });
  });

  it("says only the wait when it was as long as the engine says it can need, or the engine has not said", () => {
    expect(runEnding("ENGINE_WAIT_EXPIRED", { waitSeconds: 230, engineCeilingSeconds: 230 })).toEqual({
      key: "ENGINE_WAIT_EXPIRED_AFTER",
      values: { waitSeconds: 230 },
    });
    expect(runEnding("ENGINE_WAIT_EXPIRED", { waitSeconds: 240 })).toEqual({
      key: "ENGINE_WAIT_EXPIRED_AFTER",
      values: { waitSeconds: 240 },
    });
  });

  it("says the plain sentence when the wait is not known", () => {
    expect(runEnding("ENGINE_WAIT_EXPIRED", null)).toEqual({ key: "ENGINE_WAIT_EXPIRED" });
    expect(runEnding("ENGINE_WAIT_EXPIRED", { engineCeilingSeconds: 230 })).toEqual({ key: "ENGINE_WAIT_EXPIRED" });
  });
});

describe("the road between the service and the engine closed the call (ENGINE_PATH_CLOSED)", () => {
  it("says how long the call went on and what the road holds, where both are known", () => {
    expect(runEnding("ENGINE_PATH_CLOSED", { elapsedSeconds: 303, pathLimitSeconds: 300, engineCeilingSeconds: 590 })).toEqual({
      key: "ENGINE_PATH_CLOSED_AFTER",
      values: { elapsedSeconds: 303, pathLimitSeconds: 300 },
    });
  });

  it("says the plain sentence when either figure is missing or is not a number of seconds: the two go together or not at all", () => {
    expect(runEnding("ENGINE_PATH_CLOSED", null)).toEqual({ key: "ENGINE_PATH_CLOSED" });
    expect(runEnding("ENGINE_PATH_CLOSED", { elapsedSeconds: 303 })).toEqual({ key: "ENGINE_PATH_CLOSED" });
    expect(runEnding("ENGINE_PATH_CLOSED", { pathLimitSeconds: 300 })).toEqual({ key: "ENGINE_PATH_CLOSED" });
    expect(runEnding("ENGINE_PATH_CLOSED", { elapsedSeconds: "303", pathLimitSeconds: 300 })).toEqual({ key: "ENGINE_PATH_CLOSED" });
    expect(runEnding("ENGINE_PATH_CLOSED", { elapsedSeconds: -1, pathLimitSeconds: 300 })).toEqual({ key: "ENGINE_PATH_CLOSED" });
  });
});

describe("an engine that was not reached, and a run that was abandoned", () => {
  it("says the engine was not reached with no figure", () => {
    expect(runEnding("ENGINE_NOT_REACHED", null)).toEqual({ key: "ENGINE_NOT_REACHED" });
  });

  it("says how long an abandoned run had gone on when it was last heard from, where it is known", () => {
    expect(runEnding("ENGINE_RUN_ABANDONED", { lastSeenSeconds: 150 })).toEqual({
      key: "ENGINE_RUN_ABANDONED_AFTER",
      values: { lastSeenSeconds: 150 },
    });
    expect(runEnding("ENGINE_RUN_ABANDONED", null)).toEqual({ key: "ENGINE_RUN_ABANDONED" });
    expect(runEnding("ENGINE_RUN_ABANDONED", { lastSeenSeconds: "150" })).toEqual({ key: "ENGINE_RUN_ABANDONED" });
  });
});

describe("a code that is not one of these endings", () => {
  it.each([null, "GENERATE_STALE", "SCHEDULE_BUSY", "ENGINE_ERROR", ""])("is left to the page (%s)", (code) => {
    expect(runEnding(code, { ceilingSeconds: 230 })).toBeNull();
  });
});

describe("what a school reads when the road closed the call (ENGINE_PATH_CLOSED_AFTER)", () => {
  const say = (messages: unknown, locale: string, values: Record<string, number>): string =>
    new IntlMessageFormat(
      (messages as { scheduleCandidates: { jobErrors: Record<string, string> } }).scheduleCandidates.jobErrors.ENGINE_PATH_CLOSED_AFTER!,
      locale,
    ).format(values) as string;

  it.each([
    ["the API's own wait, ten seconds before the road would have closed it", 290, 300],
    ["the road's own close, a little after its limit", 303, 300],
  ])("is true of %s: it names how long there was no answer and what the road allows, and never says the call was closed after a time other than the road's", (_name, elapsedSeconds, pathLimitSeconds) => {
    for (const [messages, locale] of [[sv, "sv"], [en, "en"]] as const) {
      const sentence = say(messages, locale, { elapsedSeconds, pathLimitSeconds });
      expect(sentence).toContain(String(elapsedSeconds));
      expect(sentence).toContain(String(pathLimitSeconds));
      expect(sentence).not.toMatch(/stängdes efter|was closed after/);
    }
  });
});
