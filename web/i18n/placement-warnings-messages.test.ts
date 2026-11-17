import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";

/**
 * Varningar medan man lägger as the reader hears and sees it. The component tests echo keys, so they prove which sentence is said and with
 * which values, never what it says: rendered here with the real catalogues in both languages, plurals and all. (The sentence of each
 * code, with each of its values, is lib/placement-warnings.test.ts's.)
 */

const t = (locale: "sv" | "en") =>
  createTranslator({ locale, messages: locale === "sv" ? sv : en, namespace: "placementWeek.warnings" } as never) as unknown as (key: string, values?: Record<string, unknown>) => string;

const CODES = [
  "TEACHER_DAY_TOO_LONG",
  "TEACHER_WEEK_TOO_MANY_DAYS",
  "TEACHER_WEEK_TOO_MANY_DAYS_HIDDEN",
  "TEACHER_STRETCH_TOO_LONG",
  "TEACHER_STRETCH_TOO_LONG_HIDDEN",
  "CLASS_HAS_NO_LUNCH",
  "NO_ROOM_FREE",
];

describe("placementWeek.warnings", () => {
  it("has a sentence for every code the gateway sends, and the general one, in both languages", () => {
    for (const locale of ["sv", "en"] as const) {
      const catalogue = (locale === "sv" ? sv : en).placementWeek.warnings as Record<string, string>;
      for (const code of [...CODES, "UNKNOWN"]) expect(catalogue[code], `${locale} ${code}`).toBeTruthy();
    }
  });

  it("says the count, one and many, ahead of what is said (the card's name, the line read out after a save, the toast on the timplan)", () => {
    expect(t("sv")("said", { count: 1, sentences: "Ett." })).toBe("En varning: Ett.");
    expect(t("sv")("said", { count: 3, sentences: "Ett. Två. Tre." })).toBe("3 varningar: Ett. Två. Tre.");
    expect(t("en")("said", { count: 1, sentences: "One." })).toBe("One warning: One.");
    expect(t("en")("said", { count: 3, sentences: "One. Two. Three." })).toBe("3 warnings: One. Two. Three.");
  });

  it("says what a refusal means, and what the lack of one means: that the warning does not stop Generera, and no more (the gateway promises nothing the other way)", () => {
    expect(t("sv")("refuses")).toBe("Generera kommer att vägra veckan på grund av detta.");
    expect(t("sv")("standsAnyway")).toBe("Lektionen är sparad, och den här varningen stoppar inte Generera.");
    expect(t("en")("refuses")).toBe("Generate will refuse the week because of this.");
    expect(t("en")("standsAnyway")).toBe("The lesson is saved, and this warning does not stop Generate.");
  });

  it("marks the card with a sign AND a word, so that it is never a colour alone, and with a stronger word for a refusal", () => {
    for (const locale of ["sv", "en"] as const) {
      expect(t(locale)("badge")).toMatch(/^⚠︎ \S+/);
      expect(t(locale)("badgeRefuses")).toMatch(/^⚠︎ \S+/);
      expect(t(locale)("badge")).not.toBe(t(locale)("badgeRefuses"));
    }
    expect(t("sv")("badge")).toBe("⚠︎ Varning");
    expect(t("sv")("badgeRefuses")).toBe("⚠︎ Vägrar");
  });

  it("names the other schools that hold a teacher or a room", () => {
    expect(t("sv")("hold", { schools: "Östra skolan och Södra skolan" })).toBe("Bokad på Östra skolan och Södra skolan");
    expect(t("en")("hold", { schools: "East School" })).toBe("Booked at East School");
  });

  it("explains both marks in the legend, and names them as the cards do", () => {
    expect(t("sv")("legend")).toContain("Märket Varning");
    expect(t("sv")("legend")).toContain("Märket Vägrar");
    expect(t("en")("legend")).toContain("Warning mark");
    expect(t("en")("legend")).toContain("Refuses mark");
  });
});
