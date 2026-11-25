import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import { engineMessage, type MessageLookup } from "@/lib/engine-message";

/*
 * The hours of STAFF_TEACHER_OVER_SCOPE as the gateway writes them are text with the Swedish decimal comma ("602,5": hoursText writes no grouping,
 * so "1122,5"). A gateway that wrote them through Intl would write the Swedish space for the thousands, a no-break space ("1 122,5"), and the
 * English reader would be left with the code in place of the sentence, because a figure that is not a number gets no numeric twin. The space is no
 * part of the figure.
 */
const english = createTranslator({ locale: "en", messages: en, namespace: "engineMessages" }) as unknown as MessageLookup;
const sentence = (hours: string, limit: string) => engineMessage(english, { code: "STAFF_TEACHER_OVER_SCOPE", message: "The engine's English.", params: { role: "TEACHER", hours, limit } });

describe("STAFF_TEACHER_OVER_SCOPE: a figure with a space for the thousands", () => {
  it.each([
    ["a space", "1 122,5", "1 100"],
    ["a no-break space", "1 122,5", "1 100"],
    ["a narrow no-break space", "1 122,5", "1 100"],
  ])("is read as the number it is, with %s", (_name, hours, limit) => {
    const text = sentence(hours, limit);
    expect(text).toContain("would get 1,122.5 hours");
    expect(text).toContain("highest level of 1,100 hours");
  });

  it("still shows the engine's English for a figure that is not a number even with its spaces taken away", () => {
    const quiet = createTranslator({ locale: "en", messages: en, namespace: "engineMessages", onError: () => {} }) as unknown as MessageLookup;
    expect(engineMessage(quiet, { code: "STAFF_TEACHER_OVER_SCOPE", message: "The engine's English.", params: { role: "TEACHER", hours: "1 2 abc", limit: "600" } })).toBe(
      "The engine's English.",
    );
  });
});
