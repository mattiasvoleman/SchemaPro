import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";

/**
 * The two message files agree by discipline alone — nothing has enforced it.
 *
 * next-intl resolves a key at render time, so a key added to sv.json and
 * forgotten in en.json ships green and throws in the browser, but only for the
 * admin who happens to be reading English. That is the worst shape a bug can
 * have: invisible to the person who wrote it.
 */

type Messages = Record<string, unknown>;

function flatten(messages: Messages, prefix = ""): string[] {
  return Object.entries(messages).flatMap(([key, value]) =>
    value !== null && typeof value === "object"
      ? flatten(value as Messages, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );
}

/**
 * The ICU arguments a message takes — {count}, {row}, {created}.
 *
 * Depth matters: a plural's own branches are written in braces too, so a naive
 * scan reads `{Förskoleklass}` as an argument and then reports every translated
 * branch as a mismatch. Only a brace opening at the top level introduces an
 * argument; everything nested inside one is prose.
 */
function placeholders(value: string): string[] {
  const names: string[] = [];
  let depth = 0;

  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === "}") {
      depth--;
      continue;
    }
    if (char !== "{") continue;
    depth++;
    if (depth !== 1) continue;
    const name = /^\w+/.exec(value.slice(i + 1))?.[0];
    if (name !== undefined) names.push(name);
  }

  return names.sort();
}

function lookup(messages: Messages, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (node, key) => (node as Messages | undefined)?.[key],
      messages,
    );
}

describe("translation files", () => {
  const svKeys = flatten(sv as Messages);
  const enKeys = flatten(en as Messages);

  it("carry the same keys in both languages", () => {
    expect(svKeys.filter((key) => !enKeys.includes(key))).toEqual([]);
    expect(enKeys.filter((key) => !svKeys.includes(key))).toEqual([]);
  });

  it("carry the same placeholders in every message", () => {
    const mismatched = svKeys
      .filter((key) => enKeys.includes(key))
      .map((key) => ({
        key,
        sv: placeholders(String(lookup(sv as Messages, key))),
        en: placeholders(String(lookup(en as Messages, key))),
      }))
      .filter(({ sv: a, en: b }) => a.join() !== b.join());

    expect(mismatched).toEqual([]);
  });

  it("leave no message empty in either language", () => {
    // Checked per language, not per key: reading sv ?? en would let a blank
    // English string hide behind its Swedish counterpart, which is exactly the
    // half of the pair nobody in this team proofreads.
    const empty = (
      [
        ["sv", sv as Messages, svKeys],
        ["en", en as Messages, enKeys],
      ] as const
    ).flatMap(([locale, messages, keys]) =>
      keys
        .filter((key) => String(lookup(messages, key)).trim() === "")
        .map((key) => `${locale}:${key}`),
    );

    expect(empty).toEqual([]);
  });
});
