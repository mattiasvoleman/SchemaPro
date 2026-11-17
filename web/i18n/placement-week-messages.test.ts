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

const sourcesOf = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === ".next" ? [] : sourcesOf(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name) ? [readFileSync(path, "utf8")] : [];
  });

describe("placementWeek.pair and placementWeek.weeks", () => {
  const code = SOURCE_DIRS.flatMap((dir) => sourcesOf(join(ROOT, dir))).join("\n");

  it("has no sentence that nothing says (review of #338, LÅG-4: heldLabel was written and never used)", () => {
    for (const namespace of ["pair", "weeks", "note"] as const) {
      for (const locale of ["sv", "en"] as const) {
        const catalogue = (locale === "sv" ? sv : en).placementWeek[namespace] as Record<string, string>;
        // A key is said as "key" through the namespace's own translator, or as "pair.key" through its parent's.
        const unused = Object.keys(catalogue).filter((key) => !code.includes(`"${key}"`) && !code.includes(`.${key}"`));
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
