import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";

/**
 * The product's user-visible name is Rastra Schema in Swedish and Rastra timetable in English (the manual and the rest of the
 * catalogue say so). The omfattning card's words are new text: they must not say a bare "Rastra".
 */
const strings = (node: unknown): string[] =>
  typeof node === "string" ? [node] : node && typeof node === "object" ? Object.values(node).flatMap(strings) : [];

describe("the omfattning card's words name the product in full", () => {
  it.each([
    ["sv", strings(sv.staffing.scope), /Rastra(?! Schema)/],
    ["en", strings(en.staffing.scope), /Rastra(?! timetable)/],
  ])("%s", (_locale, texts, bare) => {
    expect(texts.filter((text) => bare.test(text))).toEqual([]);
  });
});
