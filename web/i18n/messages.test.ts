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

  it("call a timplanspost a curriculum entry in English, as the nav does", () => {
    // nav.requirements is "Curriculum entries"; the staffing workspace and its
    // engine sentence said "Requirements" for the same rows, so one English
    // screen named one thing twice. Scoped to the namespaces that name a
    // TeachingRequirement as a row a person staffs; the engine's older
    // "requirement" sentences (lesson length, rooms) are another matter.
    const english = en as Messages;
    const named = [
      ...flatten(lookup(english, "staffing") as Messages, "staffing."),
      "engineMessages.STAFF_UNSTAFFED_REQUIREMENTS",
    ].filter((key) => /requirement/i.test(String(lookup(english, key))));
    expect(named).toEqual([]);
    expect(String(lookup(english, "nav.requirements"))).toBe("Curriculum entries");
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

/**
 * Every key the CODE asks for exists in both locales.
 *
 * The two checks above hold the files level with each other, which is a
 * different question from whether either one answers what the app calls for.
 * `common.saved` never existed in either — so it was consistent, and the two
 * files agreed perfectly — while the lunch card called `tCommon("saved")` on
 * every successful save and got MISSING_MESSAGE instead of a confirmation. It
 * had been that way since the card was written.
 *
 * Only literal keys are checked. `t(someVariable)` is skipped rather than
 * guessed at: a rule that reported what it could not resolve would be a list of
 * false alarms nobody reads, and this one has to stay worth failing on.
 */
describe("keys the app actually asks for", () => {
  const sources = import.meta.glob("../{app,components}/**/*.tsx", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;

  const lookup = (messages: Messages, key: string): unknown =>
    key.split(".").reduce<unknown>(
      (node, part) =>
        node !== null && typeof node === "object"
          ? (node as Messages)[part]
          : undefined,
      messages,
    );

  /** `const t = useTranslations("timetable")` -> { t: "timetable" }. */
  const namespacesIn = (source: string): Map<string, string> => {
    const found = new Map<string, string>();
    const declaration = /const\s+(\w+)\s*=\s*useTranslations\(\s*"([^"]+)"\s*\)/g;
    for (const match of source.matchAll(declaration)) {
      found.set(match[1]!, match[2]!);
    }
    return found;
  };

  const missing: string[] = [];
  for (const [file, source] of Object.entries(sources)) {
    if (file.includes(".test.")) continue;
    const namespaces = namespacesIn(source);
    if (namespaces.size === 0) continue;
    const names = [...namespaces.keys()].join("|");
    const call = new RegExp(`\\b(${names})\\(\\s*"([^"]+)"`, "g");
    for (const match of source.matchAll(call)) {
      const key = `${namespaces.get(match[1]!)}.${match[2]}`;
      const inSv = lookup(sv as Messages, key) !== undefined;
      const inEn = lookup(en as Messages, key) !== undefined;
      if (!inSv || !inEn) {
        missing.push(`${file.replace("../", "")}: ${key}${inSv ? " (saknas i en)" : inEn ? " (saknas i sv)" : ""}`);
      }
    }
  }

  it("finds enough calls to be measuring something", () => {
    // A glob that stopped matching, or a regex that stopped recognising the
    // declaration, would report zero missing keys and look like a clean run.
    const scanned = Object.entries(sources).filter(
      ([file, source]) => !file.includes(".test.") && namespacesIn(source).size > 0,
    );
    expect(scanned.length).toBeGreaterThan(20);
  });

  it("resolves every literal key in both locales", () => {
    expect(missing).toEqual([]);
  });
});
