import { IntlMessageFormat } from "intl-messageformat";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";

/*
 * WORDS THE CARD MAY NOT USE FOR WHAT THE ENGINE HAS NOT SHOWN (omgång 13, G6 Åtgärdsförslag vid vägran).
 *
 * "Löser veckan" is a claim with a proof behind it and is said only for a list the engine checked; a list it did not check, a floor
 * and a measurement are each said as what they are. The real Swedish and English texts are formatted here, because a word a school
 * reads is not what the component test's echo says.
 */

type Node = { [key: string]: string | Node };
const section = (messages: unknown): Node => (messages as { generate: { suggestions: Node } }).generate.suggestions;

const say = (messages: unknown, locale: string, path: string, values: Record<string, unknown> = {}): string => {
  let node: string | Node = section(messages);
  for (const key of path.split(".")) node = (node as Node)[key]!;
  return String(new IntlMessageFormat(node as string, locale).format(values));
};

const keysOf = (node: Node, prefix = ""): string[] =>
  Object.entries(node).flatMap(([key, value]) => (typeof value === "string" ? [`${prefix}${key}`] : keysOf(value, `${prefix}${key}.`)));

describe("the two languages say the same things", () => {
  it("have the same keys, and every text parses", () => {
    expect(keysOf(section(en)).sort()).toEqual(keysOf(section(sv)).sort());
    for (const [messages, locale] of [[sv, "sv"], [en, "en"]] as const) {
      for (const key of keysOf(section(messages))) {
        let node: string | Node = section(messages);
        for (const part of key.split(".")) node = (node as Node)[part]!;
        expect(() => new IntlMessageFormat(node as string, locale), `${locale} ${key}`).not.toThrow();
      }
    }
  });

  it("has a sentence for every code the gateway sends: its five failures and its three refusals", () => {
    const failures = ["ENGINE_LACKS_SUGGESTIONS", "ENGINE_BUSY", "ENGINE_FAILED", "NOTHING_TO_PLACE", "ABANDONED"];
    const refusals = ["SUGGESTIONS_NOT_FOR_THIS_RUN", "SUGGESTIONS_RUN_IS_OLD", "SUGGESTIONS_YEAR_BUSY", "OTHER"];
    expect(Object.keys(section(sv).failed as Node).sort()).toEqual([...failures].sort());
    expect(Object.keys(section(sv).refused as Node).sort()).toEqual([...refusals].sort());
    expect(Object.keys(section(en).failed as Node).sort()).toEqual([...failures].sort());
  });

  it("has a sentence and a link label for each of the five rules and each of the four pages", () => {
    const rules = ["TEACHER_DAILY_CAP", "TEACHER_DAILY_CAP_ANON", "TEACHER_WORK_DAYS", "SUBJECT_PER_DAY", "SUBJECT_DAYS_APART", "SUBJECT_DAYS_APART_REMOVE", "ROOM_LOCK", "ROOM_LOCK_UNNAMED"];
    expect(Object.keys(section(sv).change as Node).sort()).toEqual([...rules].sort());
    expect(Object.keys(section(sv).link as Node).sort()).toEqual(["constraints", "people", "requirements", "staffing"]);
  });
});

describe("what a proof is called", () => {
  it("says solved only for a list the engine checked", () => {
    expect(say(sv, "sv", "proof.SOLVED")).toBe("Löser veckan (kontrollerat)");
    expect(say(sv, "sv", "proof.SOLVED_TOGETHER")).toBe("Löser veckan tillsammans (kontrollerat)");
    expect(say(en, "en", "proof.SOLVED")).toBe("Solves the week (checked)");
    expect(say(en, "en", "proof.SOLVED_TOGETHER")).toBe("Solves the week together (checked)");
  });

  it("says a list that was not checked may help, and never solves", () => {
    expect(say(sv, "sv", "proof.MAY_HELP")).toMatch(/kan hjälpa.*inte kontrollerat/i);
    expect(say(sv, "sv", "proof.MAY_HELP")).not.toMatch(/löser|löst/i);
    expect(say(sv, "sv", "intro.MAY_HELP")).not.toMatch(/löser|löst/i);
    expect(say(en, "en", "proof.MAY_HELP")).not.toMatch(/solve/i);
    expect(say(en, "en", "intro.MAY_HELP")).not.toMatch(/solve/i);
  });

  it("says a floor as at least and a measurement as measured, and neither as solving", () => {
    for (const [messages, locale] of [[sv, "sv"], [en, "en"]] as const) {
      expect(say(messages, locale, "proof.AT_LEAST")).toMatch(/^(Minst|At least)$/);
      expect(say(messages, locale, "proof.MEASURED")).toMatch(/(Mätt|Measured)/);
      for (const key of ["known.capLesson", "known.capWeek", "known.measured.TEACHER_DAILY_CAP", "known.measured.TEACHER_WORK_DAYS", "known.measured.SUBJECT_SPREAD"]) {
        expect(say(messages, locale, key, { minutes: 60 }), `${locale} ${key}`).not.toMatch(/löser veckan|solves the week/i);
      }
    }
    expect(say(sv, "sv", "known.capWeek", { minutes: 305 })).toMatch(/minimum och inte en lösning/);
    expect(say(en, "en", "known.capWeek", { minutes: 305 })).toMatch(/minimum and not a solution/);
    expect(say(sv, "sv", "known.measured.TEACHER_DAILY_CAP")).toMatch(/visar inte att en höjning räcker/);
  });
});

describe("what a list may promise, and what it does not", () => {
  it("says a list of several works together and that none of them is shown to be enough alone", () => {
    expect(say(sv, "sv", "intro.SOLVED_TOGETHER", { total: 3 })).toMatch(/de 3 ändringarna tillsammans/);
    expect(say(sv, "sv", "intro.SOLVED_TOGETHER", { total: 3 })).toMatch(/Ingen av dem är visad räcka ensam/);
    expect(say(en, "en", "intro.SOLVED_TOGETHER", { total: 3 })).toMatch(/these 3 changes together/);
    expect(say(en, "en", "intro.SOLVED_TOGETHER", { total: 3 })).toMatch(/None of them is shown to be enough on its own/);
  });

  it("says the caveat the proof owes: a timetable that exists, not the next Generera's time, not the cheapest, and nothing changes until saved", () => {
    const caveat = say(sv, "sv", "caveat", { when: "5 mars 2027 10:01" });
    expect(caveat).toMatch(/inte hur lång tid nästa Generera tar/);
    expect(caveat).toMatch(/inte säkert att de är de billigaste/);
    expect(caveat).toMatch(/Ingenting ändras förrän du sparar på sidan som äger uppgiften/);
    expect(caveat).toContain("5 mars 2027 10:01");
    const english = say(en, "en", "caveat", { when: "5 Mar 2027, 10:01" });
    expect(english).toMatch(/not how long the next Generera takes/);
    expect(english).toMatch(/not necessarily the cheapest/);
    expect(english).toMatch(/Nothing changes until you save/);
  });

  it("says a list shown in part counts what is left, in the right number", () => {
    expect(say(sv, "sv", "more", { count: 1 })).toMatch(/Ytterligare 1 ändring hör/);
    expect(say(sv, "sv", "more", { count: 7 })).toMatch(/Ytterligare 7 ändringar hör/);
    expect(say(en, "en", "more", { count: 1 })).toMatch(/^1 more change belong/);
  });

  it("says a search that found nothing without calling the week impossible", () => {
    const text = say(sv, "sv", "verdict.NOT_FOUND", { seconds: 60 });
    expect(text).toMatch(/inget schema inom 60 s/);
    expect(text).toMatch(/Det är inget bevis för att veckan är omöjlig/);
    expect(say(en, "en", "verdict.NOT_FOUND", { seconds: 60 })).toMatch(/no proof that the week is impossible/);
    // And it says nothing of what the rules "probably" are: a probe before it may have measured one in the way.
    expect(text).not.toMatch(/troligen/);
    expect(say(en, "en", "verdict.NOT_FOUND", { seconds: 60 })).not.toMatch(/probably/);
  });

  it("says after a TIMEOUT that nothing is proved yet, so that the offer is not read as a promise", () => {
    expect(say(sv, "sv", "offerTimeout")).toMatch(/ingenting är bevisat om veckan än/);
    expect(say(en, "en", "offerTimeout")).toMatch(/nothing is proved about the week yet/);
    expect(say(sv, "sv", "offer")).toMatch(/lägger inget schema och ändrar ingenting/i);
  });

  it("says a week laid with nothing giving way as the run's shortage of time, and an unchecked one as unchecked", () => {
    expect(say(sv, "sv", "verdict.SOLVABLE_AS_IS")).toMatch(/hann bara inte hitta det/);
    expect(say(sv, "sv", "verdict.UNCHECKED")).toMatch(/hann inte kontrollera det/);
  });

  it("says a part-timer's days in one sentence with no figure and no name, and who may see the rest", () => {
    const sentence = say(sv, "sv", "change.TEACHER_WORK_DAYS");
    expect(sentence).not.toMatch(/\d/);
    expect(say(sv, "sv", "hidden")).toMatch(/rektor, en administratör med full behörighet och den med HR-läs/);
    expect(say(en, "en", "hidden")).toMatch(/principal, a full administrator and anyone with HR read access/);
  });

  it("says each rule's change with the figures it was given, from and to", () => {
    expect(say(sv, "sv", "change.TEACHER_DAILY_CAP", { teacher: "Anna Andersson", current: 300, needed: 330 })).toBe("Höj dagstaket för Anna Andersson från 300 till 330 minuter.");
    expect(say(sv, "sv", "change.SUBJECT_PER_DAY", { post: "Idrott för 8A", current: 1, needed: 2 })).toBe("Tillåt 2 lektioner per dag för Idrott för 8A (i dag högst 1).");
    expect(say(sv, "sv", "change.SUBJECT_PER_DAY", { post: "Idrott för 8A", current: 1, needed: 1 })).toMatch(/1 lektion per dag/);
    expect(say(sv, "sv", "change.ROOM_LOCK", { post: "Matematik för 7B", rooms: "B12 och B13" })).toBe("Låt Matematik för 7B också få använda B12 och B13.");
    expect(say(en, "en", "change.SUBJECT_DAYS_APART_REMOVE", { post: "PE for 8A", current: 2 })).toBe("Remove the requirement of days apart for PE for 8A (today 2).");
  });
});
