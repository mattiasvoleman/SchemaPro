import { describe, expect, it } from "vitest";
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
