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

/** The top-level argument names of an ICU message (see messages.test.ts). */
function argumentsOf(message: string): string[] {
  const names = new Set<string>();
  let depth = 0;
  for (let i = 0; i < message.length; i++) {
    if (message[i] === "}") depth--;
    if (message[i] !== "{") continue;
    depth++;
    if (depth === 1) {
      const name = /^\w+/.exec(message.slice(i + 1))?.[0];
      if (name) names.add(name);
    }
  }
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
