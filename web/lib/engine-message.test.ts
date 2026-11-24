import { createTranslator } from "use-intl";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import { engineMessage, type MessageLookup } from "@/lib/engine-message";

function lookup(
  messages: Record<string, (values: Record<string, string | number>) => string>,
): MessageLookup {
  const t = ((key: string, values: Record<string, string | number> = {}) => {
    const render = messages[key];
    if (!render) throw new Error(`missing key ${key}`);
    return render(values);
  }) as MessageLookup;
  t.has = (key: string) => key in messages;
  return t;
}

describe("engineMessage", () => {
  const swedish = lookup({
    LUNCH_HALL_TOO_SMALL: (v) => `Matsalens ${v.seats} platser räcker inte.`,
  });

  it("renders the Swedish for a code the web knows", () => {
    expect(
      engineMessage(swedish, {
        code: "LUNCH_HALL_TOO_SMALL",
        message: "The dining hall's 115 seats are not enough.",
        params: { seats: 115 },
      }),
    ).toBe("Matsalens 115 platser räcker inte.");
  });

  it("shows the engine's English for a sentence the web has not translated", () => {
    // The engine and the web deploy separately, so a new sentence arriving
    // before its translation is an ordinary Tuesday. Untranslated reads
    // poorly; empty tells an admin whose run just failed nothing at all.
    expect(
      engineMessage(swedish, {
        code: "SOME_NEW_SENTENCE",
        message: "A rule the web has never heard of.",
        params: {},
      }),
    ).toBe("A rule the web has never heard of.");
  });

  it("shows the English for a row written before the engine named its sentences", () => {
    expect(engineMessage(swedish, { message: "An older run's text." })).toBe(
      "An older run's text.",
    );
    expect(
      engineMessage(swedish, { code: null, message: "An older run's text." }),
    ).toBe("An older run's text.");
  });

  it("shows the English rather than throwing when a param is missing", () => {
    // next-intl throws inside the render when the Swedish names an argument
    // the engine did not send. That must not take the page down with it.
    const strict = lookup({
      LUNCH_HALL_TOO_SMALL: (v) => {
        if (!("seats" in v)) throw new Error("missing seats");
        return `Matsalens ${v.seats} platser räcker inte.`;
      },
    });

    expect(
      engineMessage(strict, {
        code: "LUNCH_HALL_TOO_SMALL",
        message: "The dining hall's seats are not enough.",
      }),
    ).toBe("The dining hall's seats are not enough.");
  });
});

/**
 * A shared teacher's line says what the classes lose (the engine's SharedTeacher.classes and
 * class_minutes), and the web and the engine deploy apart, and a job's result is stored with
 * the params it had. Rendered through the real ICU of the real catalogue: a stub would not
 * throw where next-intl does.
 */
describe("TEACHER_SHARED_BY_PARALLEL_GROUPS", () => {
  const CODE = "TEACHER_SHARED_BY_PARALLEL_GROUPS";
  const swedish = createTranslator({ locale: "sv", messages: sv, namespace: "engineMessages" }) as unknown as MessageLookup;
  const english = createTranslator({ locale: "en", messages: en, namespace: "engineMessages" }) as unknown as MessageLookup;
  const base = { groups: 5, minutes: 800, grades: "9" };
  const ENGLISH = "The engine's English.";
  const render = (t: MessageLookup, params: Record<string, string | number>) =>
    engineMessage(t, { code: CODE, message: ENGLISH, params });

  /** What the line said before it said what the classes lose, word for word. */
  const OLD_SV =
    "En lärare undervisar 5 grupper i åk 9 som tar elever ur samma klasser, 800 minuter i veckan tillsammans. " +
    "En lärare kan inte vara på två ställen, så grupperna kan inte gå samtidigt, och varje klass de delar måste " +
    "sitta igenom dem en i taget. Ge varje grupp en egen lärare och kör dem som ett parallellt block, eller låt " +
    "varje grupp ta elever ur färre klasser.";
  const OLD_EN =
    "One teacher stands on 5 groups of year 9 that take pupils from the same classes, 800 minutes a week in all. " +
    "A teacher cannot be in two places, so those groups cannot run at the same time, and every class they share has " +
    "to sit through them one after the other. Give each group a teacher of its own and run them as a parallel block, " +
    "or let each group take pupils from fewer classes.";

  it("says how many minutes of their own a class has, and keeps the advice about fewer classes", () => {
    const text = render(swedish, { ...base, classes: 5, classMinutes: 60, classOwn: "some" });
    expect(text).toContain("en klass har högst 60 minuter egna lektioner kvar att lägga i veckan");
    expect(text).toContain("låt varje grupp ta elever ur färre klasser");
    expect(text).toContain("kör dem som ett parallellt block");
    expect(text).not.toContain("måste sitta igenom dem en i taget");
  });

  it("says it is the teacher's queue and not the classes when they have no lessons of their own, with no advice about fewer classes", () => {
    const text = render(swedish, { ...base, classes: 5, classMinutes: 0, classOwn: "none" });
    expect(text).toContain("Klasserna de delar har inga egna lektioner");
    expect(text).toContain("lärarens kö och inte klasserna");
    expect(text).toContain("kör dem som ett parallellt block");
    expect(text).not.toContain("färre klasser");
  });

  it("says the class and not the classes when it is one class the groups take pupils from (review of #342, LÅG-6)", () => {
    const sv1 = render(swedish, { ...base, groups: 2, classes: 1, classMinutes: 0, classOwn: "none" });
    expect(sv1).toContain("Klassen de delar har ingen egen lektion kvar att lägga");
    expect(sv1).toContain("lärarens kö och inte klassen som fyller veckan");
    expect(sv1).not.toContain("Klasserna");
    // The first sentence agrees with it: the groups take pupils from the same class, not the same classes.
    expect(sv1).toContain("som tar elever ur samma klass, 800 minuter");
    const en1 = render(english, { ...base, groups: 2, classes: 1, classMinutes: 0, classOwn: "none" });
    expect(en1).toContain("The class they share has no lesson of its own left to place");
    expect(en1).toContain("the teacher's queue and not the class that fills the week");
    expect(en1).not.toContain("The classes they share");
    expect(en1).toContain("that take pupils from the same class, 800 minutes");
  });

  it("keeps the plural for two classes and more, and reads a line with none of the count as several", () => {
    for (const classes of [2, 5]) {
      const text = render(swedish, { ...base, classes, classMinutes: 0, classOwn: "none" });
      expect(text).toContain("Klasserna de delar har inga egna lektioner kvar att lägga");
      expect(text).toContain("lärarens kö och inte klasserna som fyller veckan");
    }
    expect(render(english, { ...base, classes: 3, classMinutes: 0, classOwn: "none" })).toContain("the teacher's queue and not the classes that fill the week");
    // A row that says the classes have nothing and carries no count: the sentence it would have been before the count was read.
    expect(render(swedish, { ...base, classMinutes: 0, classOwn: "none" })).toContain("Klasserna de delar har inga egna lektioner");
  });

  it("reads a line stored before the classes were counted as the sentence it always was, in Swedish", () => {
    // No classOwn, no classes, no classMinutes: PARAM_DEFAULTS supplies "unknown", and the branch that is
    // not chosen needs nothing the row does not have.
    expect(render(swedish, base)).toBe(OLD_SV);
    expect(render(english, base)).toBe(OLD_EN);
  });

  it("does not throw on a missing figure in a branch it does not take", () => {
    // "none" says nothing of classMinutes, so a payload without it (or with it null) is read whole.
    expect(render(swedish, { ...base, classOwn: "none" })).toContain("inga egna lektioner");
    // The branch that does name it cannot be rendered: next-intl reports it and returns the key rather than
    // throwing (its default onError), so nothing here throws either, and the old-row default above is what
    // keeps a stored line out of that branch.
    expect(() => render(swedish, { ...base, classOwn: "some" })).not.toThrow();
  });

  it("shows the engine's English, not the key, when a figure the branch names is missing", () => {
    // The real translator reports a missing argument and answers with "engineMessages.<CODE>" (it does not throw),
    // so the catch in engineMessage is not what keeps a half-formed row off the screen.
    const quiet = (locale: string, messages: typeof sv) =>
      createTranslator({ locale, messages, namespace: "engineMessages", onError: () => {} }) as unknown as MessageLookup;
    const row = { ...base, classOwn: "some" }; // names classMinutes, which the row does not carry
    expect(render(quiet("sv", sv), row)).toBe(ENGLISH);
    expect(render(quiet("en", en), row)).toBe(ENGLISH);
    // And a row that is whole is still the catalogue's sentence.
    expect(render(quiet("sv", sv), { ...row, classMinutes: 60 })).toContain("högst 60 minuter");
  });

  it("is read by the older web too: a message that names none of the new params ignores them", () => {
    const older = createTranslator({
      locale: "sv",
      namespace: "engineMessages",
      messages: { engineMessages: { [CODE]: "{groups} grupper, {minutes} minuter i {grades}." } },
    }) as unknown as MessageLookup;
    expect(render(older, { ...base, classes: 5, classMinutes: 60, classOwn: "some" })).toBe("5 grupper, 800 minuter i 9.");
  });

  it("says the same in English as the engine does", () => {
    const some = render(english, { ...base, classes: 5, classMinutes: 60, classOwn: "some" });
    expect(some).toContain("a class has at most 60 minutes of lessons of its own left to place a week");
    expect(render(english, { ...base, classes: 5, classMinutes: 0, classOwn: "none" })).not.toContain("fewer classes");
  });
});

/**
 * The gateway writes the hours of STAFF_TEACHER_OVER_SCOPE as text with the Swedish decimal comma (src/staffing/staffing-checks.ts
 * hoursText: "602,5"), and an English sentence put them in as they came: "602,5 hours". The text is how the Swedish says them, and stays
 * (the gateway's own Swedish sentence is held equal to the Swedish catalogue by a spec on its side, which renders `{hours}` as a plain
 * argument); where the sentence is built the web adds a numeric twin of each figure, and the English writes that as a number. Rendered
 * through the real ICU of the real catalogue, because that is where the comma was.
 */
describe("STAFF_TEACHER_OVER_SCOPE: the hours a reader reads", () => {
  const CODE = "STAFF_TEACHER_OVER_SCOPE";
  const swedish = createTranslator({ locale: "sv", messages: sv, namespace: "engineMessages" }) as unknown as MessageLookup;
  const english = createTranslator({ locale: "en", messages: en, namespace: "engineMessages" }) as unknown as MessageLookup;
  const ENGLISH = "The engine's English.";
  const render = (t: MessageLookup, params: Record<string, string | number>) => engineMessage(t, { code: CODE, message: ENGLISH, params });

  it("says 602.5 in English and 602,5 in Swedish, from the gateway's 602,5", () => {
    const params = { role: "TEACHER", hours: "602,5", limit: "600" };
    expect(render(english, params)).toBe(
      "The teacher would get 602.5 hours of teaching over the school year against the ordinance's highest level of 600 hours (SFS 2026:1487 section 3).",
    );
    expect(render(swedish, params)).toBe(
      "Läraren skulle få 602,5 timmars undervisning under läsåret mot förordningens högsta nivå 600 timmar (SFS 2026:1487 3 §).",
    );
  });

  it("says the limit with its decimal as well as the hours", () => {
    const params = { role: "SUBSTITUTE", hours: "478,1", limit: "477,5" };
    expect(render(english, params)).toContain("would get 478.1 hours");
    expect(render(english, params)).toContain("highest level of 477.5 hours");
    expect(render(swedish, params)).toContain("skulle få 478,1 timmars");
    expect(render(swedish, params)).toContain("högsta nivå 477,5 timmar");
  });

  it("groups thousands in English as English does, and leaves the Swedish as the gateway wrote it (a four-digit number has no space in Swedish)", () => {
    const params = { role: "CO_TEACHER", hours: "1122,5", limit: "1100" };
    expect(render(english, params)).toContain("would get 1,122.5 hours");
    expect(render(english, params)).toContain("highest level of 1,100 hours");
    expect(render(swedish, params)).toContain("skulle få 1122,5 timmars");
  });

  it("reads a figure sent as a number in English as it reads one sent as text, so that a gateway that sends numbers needs no change there", () => {
    // The Swedish sentence takes the figure as it comes (`{hours}`), so a gateway that sends numbers would need it as a number, in the
    // catalogue and in the spec on the gateway's side that renders it; the gateway sends text.
    expect(render(english, { role: "TEACHER", hours: 602.5, limit: 600 })).toContain("would get 602.5 hours");
    expect(render(english, { role: "TEACHER", hours: "602,5", limit: 600 })).toContain("highest level of 600 hours");
  });

  it("shows the engine's English, not 'NaN', for a figure that is not a number", () => {
    const quiet = createTranslator({ locale: "en", messages: en, namespace: "engineMessages", onError: () => {} }) as unknown as MessageLookup;
    for (const hours of ["", "  ", "abc", "602,5,1"]) {
      expect(render(quiet, { role: "TEACHER", hours, limit: "600" }), hours).toBe(ENGLISH);
    }
  });

  it("gives each figure a numeric twin and leaves the text as it came", () => {
    const seen: Record<string, string | number>[] = [];
    const t = lookup({ [CODE]: (values) => (seen.push(values), "x") });
    engineMessage(t, { code: CODE, message: ENGLISH, params: { role: "TEACHER", hours: "602,5", limit: "600" } });
    expect(seen[0]).toEqual({ role: "TEACHER", hours: "602,5", limit: "600", hoursNumber: 602.5, limitNumber: 600 });
  });

  it("changes no other sentence's values: a figure written with a comma elsewhere stays as the gateway wrote it, with no twin", () => {
    const seen: Record<string, string | number>[] = [];
    const t = lookup({ SOME_OTHER_CODE: (values) => (seen.push(values), `${values.hours} h`) });
    expect(engineMessage(t, { code: "SOME_OTHER_CODE", message: "m", params: { hours: "602,5", limit: "600" } })).toBe("602,5 h");
    expect(seen[0]).toEqual({ hours: "602,5", limit: "600" });
  });
});
