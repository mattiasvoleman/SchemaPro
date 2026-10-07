import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";

/**
 * Every sentence of the läsår pages formats, in both languages.
 *
 * messages.test.ts proves the two files carry the same keys and the same
 * placeholders; it cannot see an ICU sentence that does not PARSE — a plural
 * missing its `other`, a brace left open — which next-intl reports only when
 * the sentence is rendered, and in the browser prints as a key path instead.
 * The component tests render the Swedish ones they reach; this renders every
 * one under `years`, Swedish and English, with each argument filled.
 */

type Messages = Record<string, unknown>;

function leaves(messages: Messages, prefix = ""): [string, string][] {
  return Object.entries(messages).flatMap(([key, value]) =>
    value !== null && typeof value === "object"
      ? leaves(value as Messages, `${prefix}${key}.`)
      : [[`${prefix}${key}`, String(value)] as [string, string]],
  );
}

/**
 * Every argument name of an ICU message, nested ones too.
 *
 * messages.test.ts compares only the top level, where a plural's branches are
 * prose. Here the names are values to fill, and a sentence that leaves a
 * clause out at zero names its next count INSIDE a branch ("3 följer med{
 * notCarried, plural, =0 {.} other { och # stannar.}}"), which formats only
 * if that count is given. So every `{name` or `{name,` at any depth is
 * filled; a prose branch that happens to look like one (`{Förskoleklass}`)
 * only adds a value nothing reads.
 */
function argumentsOf(message: string): string[] {
  const names = new Set<string>();
  for (const match of message.matchAll(/\{\s*(\w+)\s*[,}]/g)) names.add(match[1]);
  return [...names];
}

describe.each([
  ["sv", sv],
  ["en", en],
] as const)("the %s läsår sentences", (locale, messages) => {
  const translate = createTranslator({
    locale,
    messages: messages as Messages,
    namespace: "years",
    onError: (error) => {
      throw error;
    },
  }) as unknown as (key: string, values: Record<string, number>) => string;

  it.each(leaves((messages as Messages).years as Messages))("formats %s", (key, raw) => {
    const values = Object.fromEntries(argumentsOf(raw).map((name) => [name, 2]));
    const text = translate(key, values);
    expect(text).not.toContain("{");
    expect(text.trim()).not.toBe("");
  });
});

describe("the läsår sentences that count", () => {
  const translate = (messages: Messages, locale: string) =>
    createTranslator({
      locale,
      messages,
      namespace: "years",
      onError: (error) => {
        throw error;
      },
    }) as unknown as (key: string, values?: Record<string, number | string>) => string;

  it("say one, not 'one … s', in both languages", () => {
    const tSv = translate(sv as Messages, "sv");
    const tEn = translate(en as Messages, "en");
    expect(tSv("count.membersStranded", { count: 1 })).toBe("1 medlem blir utan grupp");
    expect(tEn("count.membersStranded", { count: 1 })).toBe("1 member is left without a group");
    expect(tSv("reviewRequirementsCounts", { carried: 3, notCarried: 0, shifted: 1, anchored: 0 })).toContain("1 period flyttas");
    expect(tEn("reviewRequirementsCounts", { carried: 3, notCarried: 0, shifted: 1, anchored: 0 })).toContain("1 period moves");
    expect(tEn("errors.YEAR_ACTIVATION_HAS_MOVES", { pupils: 1 })).toMatch(/^1 pupil has not/);
  });

  it("leave a count out at zero instead of printing it, in both languages", () => {
    // Webbgenomgången 2026-10-07: "0 perioder flyttas hela veckor och 0
    // följer läsårets början eller slut", and "blir 0 elever utan klass".
    const tSv = translate(sv as Messages, "sv");
    const tEn = translate(en as Messages, "en");
    const none = { carried: 24, notCarried: 0, shifted: 0, anchored: 0 };
    expect(tSv("reviewRequirementsCounts", none)).toBe("24 följer med.");
    expect(tEn("reviewRequirementsCounts", none)).toBe("24 carried over.");
    expect(tSv("reviewRequirementsCounts", { carried: 24, notCarried: 12, shifted: 2, anchored: 0 })).toBe(
      "24 följer med och 12 stannar. 2 perioder flyttas hela veckor.",
    );
    expect(tSv("reviewRequirementsCounts", { carried: 24, notCarried: 12, shifted: 0, anchored: 1 })).toBe(
      "24 följer med och 12 stannar. 1 period följer läsårets början eller slut.",
    );
    expect(tSv("reviewRequirementsCounts", { carried: 0, notCarried: 0, shifted: 0, anchored: 0 })).toBe(
      "Läsåret har inga timplansposter att föra över.",
    );
    expect(tSv("reviewLeaving", { graduating: 25, unplaced: 0 })).toBe("Vid aktiveringen går 25 elever ut.");
    expect(tSv("reviewLeaving", { graduating: 0, unplaced: 2 })).toBe("Vid aktiveringen blir 2 elever utan klass.");
    expect(tEn("reviewLeaving", { graduating: 0, unplaced: 1 })).toBe("At the activation 1 pupil is left without a class.");
    expect(tSv("problems.MEMBERSHIPS_OUT_OF_DATE", { missing: 0, stale: 2 })).toMatch(
      /sedan dess: 2 medlemskap hör till elever som går ut eller blir utan klass\. Se över/,
    );
    expect(tEn("problems.MEMBERSHIPS_OUT_OF_DATE", { missing: 3, stale: 0 })).toMatch(
      /since: 3 memberships are missing for pupils moving in\. Review/,
    );
  });

  it("translate every refusal the rollover's execute answers with a code, so English never shows the gateway's Swedish", () => {
    // year-rollover.service.ts refuseBlockedRollover and refuseUnrollable, and the 409s around them.
    const codes = [
      "ROLLOVER_TARGET_DATES",
      "ROLLOVER_UNKNOWN_GROUP",
      "PROMOTE_GRADUATING",
      "PROMOTE_WITHOUT_GRADE",
      "INTAKE_NOT_LOWEST",
      "GRADUATING_GRADE_REQUIRED",
      "ROLLOVER_NAME_COLLISION",
      "ROLLOVER_UNKNOWN_BREAK",
      "BREAK_NEEDS_DATES",
      "BREAK_OUTSIDE_YEAR",
      "YEAR_NAME_TAKEN",
      "YEAR_HAS_SUCCESSOR",
      "ROLLOVER_SOURCE_NOT_ACTIVATED",
      "ROLLOVER_SOURCE_HAS_STRAGGLERS",
      "ROLLOVER_PREVIEW_STALE",
      "ACTIVATION_PREVIEW_STALE",
      "ROLLOVER_NOT_ACTIVATED",
    ];
    for (const messages of [sv, en]) {
      const errors = (messages as { years: { errors: Record<string, string> } }).years.errors;
      expect(codes.filter((code) => errors[code] === undefined)).toEqual([]);
    }
  });
});
