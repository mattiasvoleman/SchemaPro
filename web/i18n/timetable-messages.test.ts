import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";

/**
 * The schedule's lesson count as the reader sees it, under the board, on a
 * filtered view and on each saved version. The pages echo the key, so only
 * the real messages show what the sentence says.
 */

const svT = createTranslator({ locale: "sv", messages: sv, namespace: "timetable" });
const enT = createTranslator({ locale: "en", messages: en, namespace: "timetable" });

describe("the lesson count", () => {
  it("says one lesson in the singular", () => {
    // A filter down to one lesson read "1 lektioner / vecka".
    expect(svT("lessonCount", { count: 1 })).toBe("1 lektion / vecka");
    expect(enT("lessonCount", { count: 1 })).toBe("1 lesson / week");
  });

  it("still says lessons in the plural for none and from two", () => {
    expect(svT("lessonCount", { count: 0 })).toBe("0 lektioner / vecka");
    expect(svT("lessonCount", { count: 2 })).toBe("2 lektioner / vecka");
    expect(enT("lessonCount", { count: 2 })).toBe("2 lessons / week");
  });
});
