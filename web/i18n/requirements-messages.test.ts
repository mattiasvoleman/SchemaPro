import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";

/**
 * Two sentences of Timplansposter as the reader hears and sees them.
 *
 * The page test echoes keys — `cellLabelSet(7A|Slöjd|1|60)` — so it proves
 * which sentence a cell gets and with which values, but never what the
 * sentence then says. A count glued to a plural noun and an enum value
 * written into Swedish prose pass every row there. Rendered here with the
 * real messages.
 */

const svT = createTranslator({ locale: "sv", messages: sv, namespace: "requirements" });
const enT = createTranslator({ locale: "en", messages: en, namespace: "requirements" });

describe("a Timplansposter cell's name", () => {
  const cell = { subject: "Slöjd", group: "7A", minutes: 60 };

  it("says one lesson in the singular", () => {
    // A post with one lesson a week was read out as "1 lektioner à 60 minuter".
    expect(svT("cellLabelSet", { ...cell, lessons: 1 })).toBe(
      "Slöjd för 7A: 1 lektion à 60 minuter",
    );
    expect(svT("cellLabelPeriod", { ...cell, lessons: 1, note: "udda veckor" })).toBe(
      "Slöjd för 7A: 1 lektion à 60 minuter, udda veckor",
    );
    expect(enT("cellLabelSet", { ...cell, lessons: 1 })).toBe(
      "Slöjd for 7A: 1 lesson of 60 minutes",
    );
    expect(enT("cellLabelPeriod", { ...cell, lessons: 1, note: "odd weeks" })).toBe(
      "Slöjd for 7A: 1 lesson of 60 minutes, odd weeks",
    );
  });

  it("still says lessons in the plural from two", () => {
    expect(svT("cellLabelSet", { ...cell, lessons: 2 })).toBe(
      "Slöjd för 7A: 2 lektioner à 60 minuter",
    );
    expect(svT("cellLabelPeriod", { ...cell, lessons: 2, note: "udda veckor" })).toBe(
      "Slöjd för 7A: 2 lektioner à 60 minuter, udda veckor",
    );
    expect(enT("cellLabelSet", { ...cell, lessons: 2 })).toBe(
      "Slöjd for 7A: 2 lessons of 60 minutes",
    );
    expect(enT("cellLabelPeriod", { ...cell, lessons: 2, note: "odd weeks" })).toBe(
      "Slöjd for 7A: 2 lessons of 60 minutes, odd weeks",
    );
  });
});

describe("the co-teacher hint", () => {
  it("names the two teachers' roles in words, not by the values the gateway stores", () => {
    // "publicerade lektioner får ett LEAD + ASSISTANT-par" — the
    // LessonAssignment roles, in English capitals in a Swedish sentence.
    for (const text of [svT("coTeacherHint"), enT("coTeacherHint")]) {
      expect(text).not.toMatch(/LEAD|ASSISTANT/);
    }
    // The words the rest of sv.json already uses for the two: the rollover's
    // "samma lärare som huvudläraren", and medlärare on the people page and
    // in tjänstefördelningen.
    expect(svT("coTeacherHint")).toMatch(/huvudläraren/);
    expect(svT("coTeacherHint")).toMatch(/medläraren/);
  });
});
