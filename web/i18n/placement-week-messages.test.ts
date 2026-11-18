import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";

/**
 * The week of förläggningar's own words (D2: the week picker, the pair, the card's week mark), checked against the catalogues as the
 * reader gets them. The component tests echo keys, so they prove which sentence is said, never what the catalogue holds.
 */

const ROOT = join(__dirname, "..");
const SOURCE_DIRS = ["app", "components", "lib"];

/*
 * A sentence is used when a translator BOUND TO ITS NAMESPACE is asked for it by name. Searching for the key's text in all the source said yes
 * to any word that stood anywhere ("option" is in a dozen files), so an unused placementWeek.pair.option passed (review of #341, LÅG-6; the first
 * version caught heldLabel only because its name is rare).
 *
 * A translator is bound by `const t = useTranslations("placementWeek.pair")`, or, in the modules that are handed one (they are plain functions,
 * with no hook of their own), by the name it is given and the namespace the page hands it (FOREIGN). A call asks for a key by a string in its
 * first argument; `t(odd ? "weeksOdd" : "weeksEven")` asks for both.
 */
const FOREIGN: Record<string, Record<string, string>> = {
  "lib/placement-pair-control.ts": { t: "placementWeek", tPair: "placementWeek.pair", tWeeks: "placementWeek.weeks", tDays: "days" },
  "lib/placement-week-note.ts": { t: "placementWeek.note" },
};

const filesOf = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === ".next" ? [] : filesOf(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name) ? [path] : [];
  });

/** The string literals of a call's first argument: from just after its "(" to the first "," or the ")" that closes it. */
function literalsOfFirstArgument(code: string, open: number): string[] {
  let depth = 0;
  let end = open;
  for (; end < code.length; end += 1) {
    const char = code[end];
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") {
      if (depth === 0) break;
      depth -= 1;
    } else if (char === "," && depth === 0) break;
  }
  return [...code.slice(open, end).matchAll(/["`]([A-Za-z.]+)["`]/g)].map((match) => match[1]!);
}

/** Every `namespace.key` a translator bound to `namespace` is asked for in `code`, under the names `bindings` gives (name to namespace). */
function keysAskedFor(code: string, bindings: Readonly<Record<string, string>>): Set<string> {
  const asked = new Set<string>();
  for (const [name, namespace] of Object.entries(bindings)) {
    for (const call of code.matchAll(new RegExp(`(?<![\\w$])(?:[\\w$]+\\.)?${name}(?:\\.(?:rich|raw|has))?\\(`, "g"))) {
      for (const literal of literalsOfFirstArgument(code, call.index + call[0].length)) asked.add(`${namespace}.${literal}`);
    }
  }
  return asked;
}

const bindingsOf = (code: string): Record<string, string> =>
  Object.fromEntries([...code.matchAll(/(?:const|let)\s+([\w$]+)\s*=\s*useTranslations\(\s*"([^"]+)"\s*\)/g)].map((match) => [match[1]!, match[2]!]));

const askedForInTheApp = (): Set<string> => {
  const asked = new Set<string>();
  for (const dir of SOURCE_DIRS) {
    for (const path of filesOf(join(ROOT, dir))) {
      const code = readFileSync(path, "utf8");
      const relative = path.slice(ROOT.length + 1);
      for (const key of keysAskedFor(code, { ...bindingsOf(code), ...(FOREIGN[relative] ?? {}) })) asked.add(key);
    }
  }
  return asked;
};

describe("which sentences nothing says (review of #341, LÅG-6)", () => {
  const asked = askedForInTheApp();

  it("finds a key asked for through its own translator, through its parent's, and in either arm of a choice", () => {
    const code = `
      const t = useTranslations("placementWeek");
      const tPair = useTranslations("placementWeek.pair");
      a(t("pair.needsRoom"));
      b(tPair("layFirst", { x: 1 }));
      c(tPair(odd ? "weeksOdd" : "weeksEven"));
      d(c.tPair.rich("heldBody"));
    `;
    const found = keysAskedFor(code, bindingsOf(code));
    expect([...found].sort()).toEqual(
      ["placementWeek.pair.heldBody", "placementWeek.pair.layFirst", "placementWeek.pair.needsRoom", "placementWeek.pair.weeksEven", "placementWeek.pair.weeksOdd"],
    );
  });

  it("does not take a word that another translator is asked for as this namespace's key", () => {
    // "option" is a key of placementWeek.weeks and a word of a dozen other sentences; asked of the wrong translator it is not placementWeek.pair.option.
    const code = `
      const t = useTranslations("placementWeek.weeks");
      const tOther = useTranslations("requirements");
      a(t("option"));
      b(tOther("option"));
    `;
    const found = keysAskedFor(code, bindingsOf(code));
    expect(found.has("placementWeek.weeks.option")).toBe(true);
    expect(found.has("placementWeek.pair.option")).toBe(false);
    expect(found.has("requirements.option")).toBe(true);
  });

  it("has no sentence that nothing says (review of #338, LÅG-4: heldLabel was written and never used)", () => {
    for (const namespace of ["pair", "weeks", "note"] as const) {
      for (const locale of ["sv", "en"] as const) {
        const catalogue = (locale === "sv" ? sv : en).placementWeek[namespace] as Record<string, string>;
        const unused = Object.keys(catalogue).filter((key) => !asked.has(`placementWeek.${namespace}.${key}`));
        expect(unused, `${locale} placementWeek.${namespace}`).toEqual([]);
      }
    }
  });

  it("names a week odd or even, as the rest of the app does, and never A or B (review of #338, LÅG-5)", () => {
    // A school that calls its first week A would read the picker backwards: week 34 is even by its number, and the number is all the
    // picker knows. Everywhere else the app says "udda veckor" and "jämna veckor" (odd weeks, even weeks).
    for (const [locale, catalogue] of [
      ["sv", sv.placementWeek.weeks],
      ["en", en.placementWeek.weeks],
    ] as const) {
      // "(A)", "A-veckor" and "A weeks", but not the English article ("A lesson that runs only odd weeks").
      for (const [key, text] of Object.entries(catalogue)) expect(text, `${locale} placementWeek.weeks.${key}`).not.toMatch(/\([AB]\)|\b[AB]-(vecka|veckor)\b|\b[AB] weeks\b/);
    }
    expect(sv.placementWeek.weeks.odd).toBe("udda");
    expect(sv.placementWeek.weeks.even).toBe("jämn");
    expect(en.placementWeek.weeks.odd).toBe("odd");
    expect(en.placementWeek.weeks.even).toBe("even");
  });

  it("says in the hint what makes a week odd or even: its number, as the publication counts it", () => {
    expect(sv.placementWeek.weeks.hint).toBe("Udda och jämna veckor räknas efter veckonummer (ISO 8601), som överallt i appen.");
    expect(en.placementWeek.weeks.hint).toBe("Odd and even weeks are counted by week number (ISO 8601), as everywhere else in the app.");
  });
});
