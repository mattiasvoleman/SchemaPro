import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createTranslator } from "use-intl";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";

/**
 * Kontrollera veckan's own words, checked against the catalogues as the reader gets them. The component tests echo
 * keys, so they prove which sentence is said, never what the catalogue holds: "Åk 7 är 94 % full. Kör ändå?" is the
 * sentence the phase was asked for, and it is only ever read through the real ICU.
 */

const ROOT = join(__dirname, "..");
const SOURCE_DIRS = ["app", "components", "lib"];

const sourcesOf = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === ".next" ? [] : sourcesOf(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name) ? [readFileSync(path, "utf8")] : [];
  });

const swedish = createTranslator({ locale: "sv", messages: sv, namespace: "weekCheck" });
const english = createTranslator({ locale: "en", messages: en, namespace: "weekCheck" });

describe("weekCheck", () => {
  it("asks the question the phase was written for, in both languages", () => {
    expect(swedish("ask.titleTight", { grades: "7", percent: 94 })).toBe("Åk 7 är minst 94 % full. Kör ändå?");
    expect(english("ask.titleTight", { grades: "7", percent: 94 })).toBe("Year 7 is at least 94 % full. Run anyway?");
    expect(swedish("ask.titleTight", { grades: "any", percent: 90 })).toBe("Klasserna med okänd årskurs är minst 90 % full. Kör ändå?");
    expect(english("ask.titleTight", { grades: "any", percent: 90 })).toBe("The classes of unknown year are at least 90 % full. Run anyway?");
  });

  it("says a year's share of its frame time, and what a year over it needs", () => {
    expect(swedish("yearTight", { grades: "9", percent: 97 })).toBe("Åk 9 ligger på minst 97 % av ramtiden.");
    expect(swedish("yearTight", { grades: "any", percent: 88 })).toBe("Klasserna med okänd årskurs ligger på minst 88 % av ramtiden.");
    expect(swedish("yearOver", { grades: "9", demandMinutes: 2365, capacityMinutes: 2275 })).toBe(
      "Åk 9 behöver mer än ramtiden ger: minst 2365 av 2275 minuter.",
    );
    expect(english("yearTight", { grades: "9", percent: 97 })).toBe("Year 9 is at least 97 % of the frame time.");
    expect(english("yearTight", { grades: "any", percent: 88 })).toBe("The classes of unknown year are at least 88 % of the frame time.");
  });

  it("never gives a year's percent without the word for what it is: the least its week needs, as the engine's own row says it", () => {
    // The percentage is a lower bound whether or not the count finished (a year's least week is bounded from below, week_load.py),
    // and the row under it says "at least". A line that said "94 %" beside a row that said "at least 94 %" read as two figures.
    for (const [translate, word] of [[swedish, /minst/], [english, /at least/]] as const) {
      for (const key of ["yearTight", "ask.titleTight"] as const) {
        for (const grades of ["7", "any"]) {
          expect(translate(key, { grades, percent: 91 }), `${key} ${grades}`).toMatch(word);
        }
      }
    }
  });

  it("has a sentence for every verdict and everything a check can leave out", () => {
    // WeekCheckVerdict and WeekCheckSkipped (lib/week-check.ts), which the engine's schema lists by the same names.
    for (const verdict of ["OK", "TIGHT", "IMPOSSIBLE"]) {
      expect(swedish(`verdict.${verdict}` as never), verdict).not.toMatch(/^weekCheck\./);
      expect(english(`verdict.${verdict}` as never), verdict).not.toMatch(/^weekCheck\./);
    }
    for (const skipped of ["LUNCH_STAGE", "PLACEMENTS_PROBE", "WEEK_LOAD_DEADLINE", "ENGINE"]) {
      expect(swedish(`skipped.${skipped}` as never), skipped).not.toMatch(/^weekCheck\./);
      expect(english(`skipped.${skipped}` as never), skipped).not.toMatch(/^weekCheck\./);
    }
    expect(Object.keys(sv.weekCheck.verdict)).toEqual(["OK", "TIGHT", "IMPOSSIBLE"]);
    expect(Object.keys(sv.weekCheck.skipped)).toEqual(["LUNCH_STAGE", "PLACEMENTS_PROBE", "WEEK_LOAD_DEADLINE", "ENGINE"]);
  });

  it("never lets an OK read as a timetable that exists", () => {
    expect(sv.weekCheck.okBody).toContain("ingen garanti");
    expect(en.weekCheck.okBody).toContain("no guarantee");
  });

  it("says a check that did not finish as that, with its figures as lower bounds, in both languages", () => {
    expect(swedish("okCutTitle")).toBe("Förkontrollen hann inte räkna klart veckan");
    expect(english("okCutTitle")).toBe("The pre-check did not finish counting the week");
    expect(sv.weekCheck.okCutBody).toContain("ingen garanti");
    expect(en.weekCheck.okCutBody).toContain("no guarantee");
    expect(swedish("atLeast")).toContain("lägst så höga");
    // It stands under a year over its frame time as well, whose line says minutes and no percent ("minst 2365 av 2275 minuter"), as the
    // English says "figures": a note about "Procenttalen" under a list with none is a note about nothing.
    expect(swedish("atLeast")).not.toMatch(/procent/i);
    expect(english("atLeast")).toContain("at least");
  });

  it("asks for the refused run in the run history in words a reader has", () => {
    expect(sv.weekCheck.ask.bodyImpossible).toBe(
      "Generera skulle neka veckan inom några sekunder. Kör den ändå om du vill ha den nekade körningen i körhistoriken.",
    );
    expect(sv.weekCheck.ask.bodyImpossible).not.toContain("nekan");
  });

  it("has no sentence that nothing says", () => {
    const code = SOURCE_DIRS.flatMap((dir) => sourcesOf(join(ROOT, dir))).join("\n");
    const flat = (catalogue: Record<string, unknown>, prefix = ""): string[] =>
      Object.entries(catalogue).flatMap(([key, value]) =>
        value !== null && typeof value === "object" ? flat(value as Record<string, unknown>, `${prefix}${key}.`) : [`${prefix}${key}`],
      );
    // verdict.* and skipped.* are said through a template (`verdict.${...}`), which is held by the test above.
    const unused = flat(sv.weekCheck).filter(
      (key) => !/^(verdict|skipped)\./.test(key) && !code.includes(`"${key}"`) && !code.includes(`weekCheck.${key}`),
    );
    expect(unused).toEqual([]);
  });
});
