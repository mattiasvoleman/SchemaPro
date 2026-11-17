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
    expect(text).toContain("en klass har högst 60 minuter egna lektioner i veckan");
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
    expect(some).toContain("a class has at most 60 minutes of lessons of its own a week");
    expect(render(english, { ...base, classes: 5, classMinutes: 0, classOwn: "none" })).not.toContain("fewer classes");
  });
});
