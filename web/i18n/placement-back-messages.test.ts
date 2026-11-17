import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";

/**
 * The way back to the week, as the reader hears it (A3). The component tests echo keys, so they prove which sentence is said and
 * with which values, never what it says: rendered here with the real catalogues in both languages, plurals and all.
 */

const t = (locale: "sv" | "en", namespace: string) =>
  createTranslator({ locale, messages: locale === "sv" ? sv : en, namespace } as never) as unknown as (key: string, values?: Record<string, unknown>) => string;

describe("generate.placed: the row before a run", () => {
  it("says how many lessons lie fixed, one and many", () => {
    expect(t("sv", "generate.placed")("fixed", { count: 1 })).toBe("1 lektion ligger fast.");
    expect(t("sv", "generate.placed")("fixed", { count: 12 })).toBe("12 lektioner ligger fast.");
    expect(t("en", "generate.placed")("fixed", { count: 1 })).toBe("1 lesson is fixed.");
    expect(t("en", "generate.placed")("fixed", { count: 12 })).toBe("12 lessons are fixed.");
  });

  it("says how many no longer hold, and that Generera will not run before they do", () => {
    expect(t("sv", "generate.placed")("failing", { count: 1 })).toBe("1 förläggning håller inte längre, och Generera körs inte förrän de gör det.");
    expect(t("sv", "generate.placed")("failing", { count: 3 })).toBe("3 förläggningar håller inte längre, och Generera körs inte förrän de gör det.");
    expect(t("en", "generate.placed")("failing", { count: 1 })).toContain("1 placement no longer holds");
    expect(t("en", "generate.placed")("failing", { count: 3 })).toContain("3 placements no longer hold");
  });

  it("names the refusal a link is about in the link's own name, so that a hundred of them are told apart", () => {
    const sentence = "Matematik för 7A, förlagd tisdag 10:00–11:00 i A12.";
    expect(t("sv", "generate.placed")("refusalLinkLabel", { sentence })).toBe(`Visa i veckan: ${sentence}`);
    expect(t("en", "generate.placed")("refusalLinkLabel", { sentence })).toBe(`View in the week: ${sentence}`);
    expect(t("sv", "generate.placed")("refusalLink")).toBe("Visa i veckan");
  });

  it("says the same about the week's red box as the week does (the sentence is shared in meaning, not copied)", () => {
    const week = t("sv", "placementWeek")("failingTitle", { count: 2 });
    expect(t("sv", "generate.placed")("failing", { count: 2 }).startsWith(week)).toBe(true);
  });
});

describe("placementWeek.fromRun: what the week says about the last run", () => {
  it("is the sentence the plan names", () => {
    expect(t("sv", "placementWeek.fromRun")("changed")).toBe("Ändrat sedan senaste schemat. Generera om.");
    expect(t("sv", "placementWeek.fromRun")("missing")).toBe("Förläggningen ligger inte längre där: den är flyttad eller borttagen.");
  });

  it("is said in both languages, with a way to Generera", () => {
    for (const locale of ["sv", "en"] as const) {
      for (const key of ["changed", "missing", "toGenerate"]) expect(t(locale, "placementWeek.fromRun")(key).length, `${locale} ${key}`).toBeGreaterThan(3);
    }
  });
});

describe("timetable: the grundschema's side", () => {
  it("names the week where lessons are laid by hand, in the empty state", () => {
    expect(t("sv", "timetable")("emptyHint")).toContain("i veckan");
    expect(t("sv", "timetable")("emptyAction2")).toBe("Lägg ut lektioner för hand");
    expect(t("en", "timetable")("emptyAction2")).toBe("Place lessons by hand");
    expect(t("en", "timetable")("emptyHint")).toContain("in the week");
  });

  it("marks a placed lesson with one word", () => {
    expect(t("sv", "timetable")("placedMark")).toBe("Förlagd");
    expect(t("en", "timetable")("placedMark")).toBe("Placed");
  });

  it("says where a placed lesson is changed: Förlägg i veckan for a post, the dialog Förlägg … under Block for a block (true before and after the block card)", () => {
    const sv = t("sv", "timetable")("lessonIsPlaced");
    expect(sv).toContain("Förlägg i veckan");
    expect(sv).toContain("Förlägg …");
    expect(sv).toContain("Block");
    const en = t("en", "timetable")("lessonIsPlaced");
    expect(en).toContain("Place in the week");
    expect(en).toContain("Place lessons …");
  });

  it("names the pages as the menu names them", () => {
    expect(sv.placementWeek.title).toBe("Förlägg i veckan");
    expect(en.placementWeek.title).toBe("Place in the week");
    expect(t("sv", "timetable")("lessonIsPlaced")).toContain(sv.placementWeek.title);
    expect(t("en", "timetable")("lessonIsPlaced")).toContain(en.placementWeek.title);
  });
});
