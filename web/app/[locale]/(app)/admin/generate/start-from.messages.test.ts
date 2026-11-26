import { IntlMessageFormat } from "intl-messageformat";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";

/*
 * The sentences of Utgå från ett schema (M9) as a school reads them: every key has both languages, every placeholder is filled by the
 * values the page gives it, and the plural forms say a count right in Swedish and in English. The page's own tests echo the keys; this
 * is what the catalogue makes of them.
 */

type Catalogue = Record<string, unknown>;
const generate = (messages: unknown): Catalogue => (messages as { generate: Catalogue }).generate;
const say = (messages: unknown, locale: string, path: string[], values: Record<string, unknown>): string => {
  let node: unknown = generate(messages);
  for (const part of path) node = (node as Catalogue)[part];
  return new IntlMessageFormat(node as string, locale).format(values) as string;
};

const START_KEYS = Object.keys(generate(sv)).filter((key) => key.startsWith("start"));

describe("the catalogue of Utgå från ett schema", () => {
  it("has the same keys in both languages, nested ones included", () => {
    const flat = (node: unknown, prefix = ""): string[] =>
      typeof node === "object" && node !== null
        ? Object.entries(node).flatMap(([key, value]) => flat(value, `${prefix}${key}.`))
        : [prefix.slice(0, -1)];
    const only = (messages: unknown) => flat(Object.fromEntries(START_KEYS.map((key) => [key, generate(messages)[key]]))).sort();
    expect(only(en)).toEqual(only(sv));
    expect(START_KEYS.length).toBeGreaterThan(15);
  });

  it("has a sentence for every reason a lesson of the schedule can be left out", () => {
    for (const reason of ["NO_SUCCESSOR", "NO_POST", "NOT_IN_WEEK", "OTHER_WEEKS", "AMBIGUOUS", "NOT_STARTABLE", "MORE_THAN_ASKED"]) {
      for (const [messages, locale] of [[sv, "sv"], [en, "en"]] as const) {
        const said = say(messages, locale, ["startDrop", reason], { count: 8 });
        expect(said, `${locale} ${reason}`).toContain("8");
        expect(said).not.toMatch(/[{}]/);
      }
    }
  });

  it("does not say that a post the run does not lay is locked: a post placed by hand or following another block is not in the week either", () => {
    // The gateway leaves a post out of the week when every lesson of it is answered by a lock or a förläggning, and a mirrored follower
    // block is written at its leader's times: its lessons are NOT_IN_WEEK, whichever of the three it was.
    expect(say(sv, "sv", ["startDrop", "NOT_IN_WEEK"], { count: 4 })).toMatch(/förlagda/);
    expect(say(sv, "sv", ["startDrop", "NOT_IN_WEEK"], { count: 4 })).toMatch(/annat block/);
    expect(say(en, "en", ["startDrop", "NOT_IN_WEEK"], { count: 4 })).toMatch(/placed by hand/);
    expect(say(en, "en", ["startDrop", "NOT_IN_WEEK"], { count: 4 })).toMatch(/another block/);
  });

  it("says the counts of a run in whole sentences, with the plural of one lesson right", () => {
    expect(say(sv, "sv", ["startNoteCounts"], { total: 180, held: 171, moved: 9, laid: 0 })).toBe(
      "Av 180 lektioner hölls 171 där de låg, 9 flyttades och 0 lades nya.",
    );
    expect(say(sv, "sv", ["startNoteCounts"], { total: 1, held: 1, moved: 0, laid: 0 })).toContain("Av 1 lektion hölls");
    expect(say(en, "en", ["startNoteCounts"], { total: 180, held: 171, moved: 9, laid: 0 })).toBe(
      "Of 180 lessons, 171 were held where they were, 9 were moved and 0 were laid new.",
    );
    expect(say(en, "en", ["startNoteCounts"], { total: 1, held: 1, moved: 0, laid: 0 })).toContain("Of 1 lesson,");
  });

  it("names what a run started from, and the saved version by the name the school gave it", () => {
    for (const source of ["CURRENT", "PREVIOUS_YEAR", "VERSION"]) {
      expect(say(sv, "sv", ["startNoteSource", source], {})).toBeTruthy();
      expect(say(en, "en", ["startNoteSource", source], {})).toBeTruthy();
    }
    expect(say(sv, "sv", ["startNoteSourceNamed"], { name: "Före ändringen" })).toBe("den sparade versionen ”Före ändringen”");
    expect(say(sv, "sv", ["startNoteTitle"], { what: "årets grundschema" })).toBe("Utgick från årets grundschema.");
    // An engine that could not start from the schedule asks, it does not claim: the line is not "Utgick från".
    expect(say(sv, "sv", ["startNoteAsked"], { what: "årets grundschema" })).toBe("Du bad om att utgå från årets grundschema.");
    expect(say(en, "en", ["startNoteAsked"], { what: "this year's grundschema" })).toBe("You asked to start from this year's grundschema.");
  });

  it("lists a saved version with its name, its date and its lessons", () => {
    expect(say(sv, "sv", ["startVersionOption"], { name: "V1", date: "24 nov. 2026", count: 150 })).toBe("V1 · 24 nov. 2026 · 150 lektioner");
    expect(say(en, "en", ["startVersionOption"], { name: "V1", date: "24 Nov 2026", count: 1 })).toBe("V1 · 24 Nov 2026 · 1 lesson");
  });

  it("says that the grundschema is not a lock, in the card's own text, so that a school that reads 'hålls' as 'låst' is told otherwise", () => {
    expect(generate(sv)["startHint"]).toMatch(/inget lås/);
    expect(generate(en)["startHint"]).toMatch(/not a lock/);
  });

  it("says that the choice is for the run and not for the timetable proposals", () => {
    expect(generate(sv)["startHint"]).toMatch(/[Ss]chemaförslagen/);
    expect(generate(en)["startHint"]).toMatch(/timetable proposals/);
  });
});
