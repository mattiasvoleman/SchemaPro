import { describe, expect, it } from "vitest";
import type { MessageLookup } from "@/lib/engine-message";
import { ApiError } from "@/lib/api";
import {
  clockOfMinutes,
  fitSentence,
  minutesOfClock,
  placementChangeSentence,
  verdictSentence,
} from "./requirement-placement-text";

/**
 * The words of Förlägg are the catalogues' (i18n/placements-messages.test.ts
 * renders them). Here the choice between them: which key a reason gets, and
 * what is said when the gateway names a reason or leaves out a value this build
 * has no sentence for.
 */

/** A translator that knows the keys given, echoes them with their values, and throws on `broken`. */
function lookup(known: string[], broken: string[] = []): MessageLookup {
  const t = ((key: string, values?: Record<string, string | number>) => {
    if (broken.includes(key)) throw new Error("FORMATTING_ERROR");
    return `${key}(${Object.entries(values ?? {})
      .map(([name, value]) => `${name}=${value}`)
      .join(",")})`;
  }) as MessageLookup;
  t.has = (key: string) => known.includes(key);
  return t;
}

describe("the clock of a row", () => {
  it("is minutes past midnight both ways", () => {
    expect(minutesOfClock("08:05")).toBe(485);
    expect(minutesOfClock("17:55")).toBe(1075);
    expect(clockOfMinutes(485)).toBe("08:05");
    expect(clockOfMinutes(1080)).toBe("18:00");
  });

  it("reads seconds off a time the browser hands over, and nothing from a half-typed one", () => {
    expect(minutesOfClock("10:00:00")).toBe(600);
    expect(minutesOfClock("")).toBeNaN();
    expect(minutesOfClock("10")).toBeNaN();
  });
});

describe("a verdict", () => {
  const t = lookup(["verdict.TEACHER", "verdict.UNKNOWN", "verdict.BROKEN"], ["verdict.BROKEN"]);

  it("is said by the sentence of its reason, with the values the gateway sent", () => {
    expect(verdictSentence(t, "TEACHER", { className: "7B", day: 2 })).toBe("verdict.TEACHER(className=7B,day=2)");
  });

  it("is said in general words for a reason this build does not know", () => {
    expect(verdictSentence(t, "NEW_RULE", { x: 1 })).toBe("verdict.UNKNOWN()");
    expect(verdictSentence(t, undefined)).toBe("verdict.UNKNOWN()");
  });

  it("is said in general words when the sentence needs a value that did not come", () => {
    // next-intl throws on a missing argument; a refusal is never left unsaid for it.
    expect(verdictSentence(t, "BROKEN")).toBe("verdict.UNKNOWN()");
  });
});

describe("why the rows do not fit the post", () => {
  const t = lookup(["problem.PAIRS", "problem.UNKNOWN"]);

  it("is the sentence of the rule", () => {
    expect(fitSentence(t, "PAIRS")).toBe("problem.PAIRS()");
  });

  it("is a general one for a rule this build does not know", () => {
    expect(fitSentence(t, "SOMETHING_NEW")).toBe("problem.UNKNOWN()");
  });
});

describe("a refused change of a post's teacher", () => {
  const t = lookup(["problem.TEACHER", "problem.NO_TEACHER", "problem.UNKNOWN", "changeFirst", "editRefused"]);
  const named = { reason: "TEACHER", day: 2, start: "10:00", end: "11:00", weeks: "ODD_WEEKS" };

  it("names the placement to change first, by its day, its time and its weeks, and says why", () => {
    const error = new ApiError(409, "x", "REQUIREMENT_PLACEMENTS_DO_NOT_FIT", named);
    expect(placementChangeSentence(t, error)).toBe(
      "changeFirst(reason=problem.TEACHER(),day=2,start=10:00,end=11:00,weeks=ODD_WEEKS)",
    );
  });

  it("says in general words which of the post's lessons are placed, when no placement is named", () => {
    const error = new ApiError(409, "x", "REQUIREMENT_PLACEMENTS_DO_NOT_FIT", { reason: "NO_TEACHER" });
    expect(placementChangeSentence(t, error)).toBe("editRefused(reason=problem.NO_TEACHER())");
  });

  it("is a general sentence for a reason this build does not know", () => {
    const error = new ApiError(409, "x", "REQUIREMENT_PLACEMENTS_DO_NOT_FIT", { ...named, reason: "SOMETHING_NEW" });
    expect(placementChangeSentence(t, error)).toContain("reason=problem.UNKNOWN()");
  });

  it.each([
    ["another 409", new ApiError(409, "x", "SCHEDULE_BUSY")],
    ["a judge's refusal of a row", new ApiError(409, "x", "REQUIREMENT_PLACEMENT_REFUSED", { index: 0, reason: "ROOM" })],
    ["a plain error", new Error("boom")],
  ])("is null for %s, which the caller shows as every other failure", (_what, error) => {
    expect(placementChangeSentence(t, error)).toBeNull();
  });
});
