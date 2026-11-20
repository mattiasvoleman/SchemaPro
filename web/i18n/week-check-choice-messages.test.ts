import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createTranslator } from "use-intl";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";

/**
 * Kontrollera veckan med lärarval, its words checked against the catalogues as the reader gets them. The component
 * tests echo keys, so they prove which sentence is said and never what the catalogue holds: the floor's sentence, "from
 * → to" for a subject, and "minst" for a figure that is only a bound are read through the real ICU here.
 */

const ROOT = join(__dirname, "..");
const SOURCE_DIRS = ["app", "components", "lib"];

const sourcesOf = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === ".next" ? [] : sourcesOf(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name) ? [readFileSync(path, "utf8")] : [];
  });

const swedish = createTranslator({ locale: "sv", messages: sv, namespace: "weekCheckChoice" });
const english = createTranslator({ locale: "en", messages: en, namespace: "weekCheckChoice" });

const flat = (catalogue: Record<string, unknown>, prefix = ""): string[] =>
  Object.entries(catalogue).flatMap(([key, value]) =>
    value !== null && typeof value === "object" ? flat(value as Record<string, unknown>, `${prefix}${key}.`) : [`${prefix}${key}`],
  );

describe("weekCheckChoice", () => {
  it("says the floor in the sentence the phase was written for, as a lower bound", () => {
    expect(swedish("floor.load", { year: 9, percent: 94 })).toBe(
      "Även om varje grupp i de ämnen där flera lärare är behöriga fick en egen lärare är åk 9 minst 94 % full.",
    );
    expect(english("floor.load", { year: 9, percent: 94 })).toBe(
      "Even if every group in the subjects that have several qualified teachers got a teacher of its own, year 9 is at least 94 % full.",
    );
  });

  it("says a floor above the supply plainly: no choice of teachers helps", () => {
    expect(swedish("floor.over", { year: 9, demandMinutes: 2366, capacityMinutes: 2275 })).toContain("mer än ramtiden ger: minst 2366 av 2275 minuter");
    expect(sv.weekCheckChoice.floor.overBody).toBe("Inget lärarval kan lösa veckan. Det behövs mer undervisningstid eller färre timmar.");
    expect(en.weekCheckChoice.floor.overBody).toContain("No choice of teachers can solve the week");
  });

  it("never says that a floor under the supply fits, only that a choice might help", () => {
    expect(sv.weekCheckChoice.floor.mayHelp).toBe("Ett lärarval kan hjälpa. Det betyder inte att veckan går att lägga.");
    expect(en.weekCheckChoice.floor.mayHelp).toBe("A choice of teachers might help. It does not mean the week can be laid.");
    for (const text of [sv.weekCheckChoice.floor.load, sv.weekCheckChoice.floor.under, sv.weekCheckChoice.floor.mayHelp]) {
      expect(text).not.toMatch(/går ihop|ryms|räcker/);
    }
  });

  it("says a year under the tight threshold as what it is, an absence of proof, and a count that did not finish as not said", () => {
    expect(swedish("floor.under", { year: 9, below: 85 })).toContain("inget över 85 % för åk 9");
    expect(swedish("floor.under", { year: 9, below: 85 })).toContain("Det är inte bevisat trängre än så.");
    expect(swedish("floor.unknown", { year: 9 })).toContain("kan inte sägas");
    expect(sv.weekCheckChoice.floor.cut).toContain("nedre gräns");
    expect(en.weekCheckChoice.floor.cut).toContain("lower bound");
  });

  it("says a subject's what-if as from → to, and a count the seconds cut as at least", () => {
    const from = swedish("count.short.load", { percent: 114, atLeast: "no" });
    expect(from).toBe("114 %");
    expect(swedish("whatIf.line", { subject: "Hemkunskap", from, to: swedish("count.short.load", { percent: 109, atLeast: "no" }) })).toBe(
      "En andra lärare i Hemkunskap: 114 % → 109 %",
    );
    expect(swedish("count.short.load", { percent: 109, atLeast: "yes" })).toBe("minst 109 %");
    expect(english("count.short.load", { percent: 109, atLeast: "yes" })).toBe("at least 109 %");
    expect(english("whatIf.line", { subject: "Home economics", from: "114 %", to: "109 %" })).toBe("A second teacher in Home economics: 114 % → 109 %");
  });

  it("says every kind of count, short and long, in both languages", () => {
    for (const form of ["short", "long"] as const) {
      expect(Object.keys(sv.weekCheckChoice.count[form])).toEqual(["load", "over", "under", "unknown", "refused"]);
      expect(Object.keys(en.weekCheckChoice.count[form])).toEqual(["load", "over", "under", "unknown", "refused"]);
    }
    expect(swedish("count.long.under", { below: 85 })).toBe("under 85 % av ramtiden");
    // A week over the supply is only a lower bound of its tightest period (the engine stops counting at the first period it
    // refuses), so it is said "minst" and as a sentence of its own, never as the second half of a "from → to".
    expect(swedish("count.short.over", { percent: 114 })).toBe("minst 114 %");
    expect(english("count.short.over", { percent: 114 })).toBe("at least 114 %");
    expect(swedish("count.long.over", { percent: 114, demandMinutes: 2610, capacityMinutes: 2275 })).toBe(
      "minst 114 %, mer än ramtiden ger (minst 2610 av 2275 minuter)",
    );
    expect(english("count.long.over", { percent: 114, demandMinutes: 2610, capacityMinutes: 2275 })).toBe(
      "at least 114 %, more than the frame time gives (at least 2610 of 2275 minutes)",
    );
    expect(swedish("whatIf.lineOver", { subject: "Hemkunskap", to: "minst 109 %" })).toBe(
      "En andra lärare i Hemkunskap: veckan ligger fortfarande över ramtiden (minst 109 %)",
    );
    expect(english("whatIf.lineOver", { subject: "Home economics", to: "at least 109 %" })).toBe(
      "A second teacher in Home economics: the week is still over the frame time (at least 109 %)",
    );
    expect(sv.weekCheckChoice.whatIf.stillOver).toContain("första period den nekar");
    expect(en.weekCheckChoice.whatIf.stillOver).toContain("first period it refuses");
    // A week below the supply that a second teacher brings from over it is the one "from → to": a bound and a value.
    expect(swedish("whatIf.line", { subject: "Hemkunskap", from: "minst 114 %", to: "97 %" })).toBe("En andra lärare i Hemkunskap: minst 114 % → 97 %");
  });

  it("says whether a second teacher would have to be found or the choice already exists, naming no person", () => {
    expect(swedish("whatIf.detail", { qualified: 0, moved: 1, of: 3 })).toBe("Ingen behörig lärare i dag. 1 av 3 poster går till den andra.");
    expect(swedish("whatIf.detail", { qualified: 1, moved: 2, of: 5 })).toBe(
      "1 behörig lärare i dag: en andra behöver hittas. 2 av 5 poster går till den andra.",
    );
    expect(swedish("whatIf.detail", { qualified: 2, moved: 2, of: 5 })).toBe(
      "2 behöriga lärare i dag: valet finns redan. 2 av 5 poster går till den andra.",
    );
    expect(english("whatIf.detail", { qualified: 1, moved: 2, of: 5 })).toBe(
      "1 qualified teacher today: a second would have to be found. 2 of 5 posts go to the second one.",
    );
  });

  it("names the tightest period in dates, and says when the same posts run in other weeks", () => {
    expect(swedish("period", { from: "11 januari 2027", to: "11 juni 2027", more: "no" })).toBe("Räknat för veckorna 11 januari 2027 – 11 juni 2027.");
    expect(swedish("period", { from: "a", to: "b", more: "yes" })).toContain("och övriga veckor med samma poster");
    expect(english("period", { from: "a", to: "b", more: "yes" })).toContain("and the other weeks with the same entries");
  });

  it("counts the subjects the time left out, and says the figures are bounds that do not make a timetable", () => {
    expect(swedish("notRun", { count: 1 })).toBe("1 ämne hann inte räknas om inom tiden.");
    expect(swedish("notRun", { count: 3 })).toBe("3 ämnen hann inte räknas om inom tiden.");
    expect(sv.weekCheckChoice.limits).toContain("nedre gränser");
    expect(sv.weekCheckChoice.limits).toContain("De säger inte att ett schema finns");
    expect(en.weekCheckChoice.limits).toContain("lower bounds");
    expect(en.weekCheckChoice.limits).toContain("do not say a timetable exists");
  });

  it("is the same keys in both languages", () => {
    expect(flat(en.weekCheckChoice).sort()).toEqual(flat(sv.weekCheckChoice).sort());
  });

  it("has a sentence for every way an ask can come to nothing and every status the gateway answers with", () => {
    // WeekCheckChoiceOutcome (lib/week-check-choice.ts) and WeekCheckChoiceStatus (the gateway's interface).
    expect(Object.keys(sv.weekCheckChoice.unavailable)).toEqual(["ENGINE_OLDER", "THROTTLED", "ERROR"]);
    expect(Object.keys(sv.weekCheckChoice.status)).toEqual(["NO_TIGHT_YEAR", "NOT_ASKED"]);
  });

  it("has no sentence that nothing says", () => {
    const code = SOURCE_DIRS.flatMap((dir) => sourcesOf(join(ROOT, dir))).join("\n");
    // unavailable.*, status.* and count.* are said through a template, which the components' tests hold.
    const unused = flat(sv.weekCheckChoice).filter(
      (key) =>
        !/^(unavailable|status|count)\./.test(key) &&
        !code.includes(`"${key}"`) &&
        !code.includes(`weekCheckChoice.${key}`),
    );
    expect(unused).toEqual([]);
  });
});
