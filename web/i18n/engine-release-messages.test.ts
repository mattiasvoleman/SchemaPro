import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";

/**
 * Släppta poster and the second confirmation of Föreslå bemanning, as the reader hears them. The component tests render the
 * Swedish catalogue for the sentences they assert; this holds the plurals of both languages, which a test in one language
 * cannot see.
 */

const t = (locale: "sv" | "en", namespace: string) =>
  createTranslator({ locale, messages: locale === "sv" ? sv : en, namespace } as never) as unknown as (
    key: string,
    values?: Record<string, unknown>,
  ) => string;

describe("staffing.engineRelease: the card", () => {
  it("says how many staffed posts are released, in the singular and the plural", () => {
    expect(t("sv", "staffing.engineRelease")("summary", { released: 3, staffed: 12 })).toBe("Släppta för motorn: 3 av 12 bemannade poster.");
    expect(t("sv", "staffing.engineRelease")("summary", { released: 0, staffed: 1 })).toBe("Släppta för motorn: 0 av 1 bemannad post.");
    expect(t("en", "staffing.engineRelease")("summary", { released: 3, staffed: 12 })).toBe("Released for the engine: 3 of 12 staffed entries.");
    expect(t("en", "staffing.engineRelease")("summary", { released: 0, staffed: 1 })).toBe("Released for the engine: 0 of 1 staffed entry.");
  });

  it("says what a press did, and that nothing changed when nothing did", () => {
    expect(t("sv", "staffing.engineRelease")("doneReleased", { count: 0 })).toBe("Inga poster ändrades.");
    expect(t("sv", "staffing.engineRelease")("doneReleased", { count: 1 })).toBe("1 post släpptes för motorn.");
    expect(t("sv", "staffing.engineRelease")("doneReleased", { count: 4 })).toBe("4 poster släpptes för motorn.");
    expect(t("sv", "staffing.engineRelease")("doneTakenBack", { count: 4 })).toBe("4 poster togs tillbaka.");
    expect(t("en", "staffing.engineRelease")("doneReleased", { count: 0 })).toBe("No entries changed.");
    expect(t("en", "staffing.engineRelease")("doneReleased", { count: 1 })).toBe("1 entry was released for the engine.");
    expect(t("en", "staffing.engineRelease")("doneTakenBack", { count: 4 })).toBe("4 entries were taken back.");
  });

  it("names a row by subject and årskurs, förskoleklass in words, in both languages", () => {
    for (const [locale, grade7, preschool] of [
      ["sv", "åk 7", "förskoleklass"],
      ["en", "year 7", "preschool class"],
    ] as const) {
      expect(t(locale, "staffing.engineRelease")("grade", { grade: 7 })).toBe(grade7);
      expect(t(locale, "staffing.engineRelease")("grade", { grade: 0 })).toBe(preschool);
    }
  });

  it("names the press by how many it would release, and by its row, so that forty of them are told apart", () => {
    expect(t("sv", "staffing.engineRelease")("releaseAll", { count: 1 })).toBe("Släpp 1 bemannad");
    expect(t("sv", "staffing.engineRelease")("releaseAllNamed", { count: 3, line: "Matematik · åk 7" })).toBe(
      "Släpp 3 bemannade: Matematik · åk 7",
    );
    // The accessible name starts with the visible words (WCAG 2.5.3).
    expect(t("sv", "staffing.engineRelease")("releaseAllNamed", { count: 3, line: "x" }).startsWith(t("sv", "staffing.engineRelease")("releaseAll", { count: 3 }))).toBe(true);
    expect(t("sv", "staffing.engineRelease")("takeBackAllNamed", { line: "x" }).startsWith(t("sv", "staffing.engineRelease")("takeBackAll"))).toBe(true);
    expect(t("en", "staffing.engineRelease")("takeBackAllNamed", { line: "x" }).startsWith(t("en", "staffing.engineRelease")("takeBackAll"))).toBe(true);
    // The switch's name starts with its visible word.
    expect(t("sv", "staffing.engineRelease")("releaseRow", { row: "Matematik för 7A" }).startsWith(t("sv", "staffing.engineRelease")("released"))).toBe(true);
    expect(t("en", "staffing.engineRelease")("releaseRow", { row: "Maths for 7A" }).startsWith(t("en", "staffing.engineRelease")("released"))).toBe(true);
  });
});

describe("staffing.proposal: released posts and new teaching", () => {
  it("names the years a change gives a teacher, one and many", () => {
    expect(t("sv", "staffing.proposal")("badgeNewYears", { count: 1, years: "8" })).toBe("Ny årskurs 8");
    expect(t("sv", "staffing.proposal")("badgeNewYears", { count: 2, years: "8, 9" })).toBe("Nya årskurser 8, 9");
    expect(t("en", "staffing.proposal")("badgeNewYears", { count: 1, years: "8" })).toBe("New year group 8");
    expect(t("en", "staffing.proposal")("badgeNewYears", { count: 2, years: "8, 9" })).toBe("New year groups 8, 9");
  });

  it("says how many posts are released, and that they were left as they are when only the unstaffed were asked for", () => {
    expect(t("sv", "staffing.proposal")("releasedCount", { count: 1 })).toBe("1 post är släppt för motorn.");
    expect(t("sv", "staffing.proposal")("releasedCount", { count: 3 })).toBe("3 poster är släppta för motorn.");
    expect(t("sv", "staffing.proposal")("releasedSkipped", { count: 3 })).toBe(
      "3 poster är släppta för motorn men lämnas som de är, eftersom du valde bara obemannade poster.",
    );
    expect(t("en", "staffing.proposal")("releasedCount", { count: 3 })).toBe("3 entries are released for the engine.");
    expect(t("en", "staffing.proposal")("releasedSkipped", { count: 1 })).toBe(
      "1 entry is released for the engine but is left as it is, because you chose only unstaffed entries.",
    );
  });

  it("words the second step's button and heading in both languages", () => {
    expect(t("sv", "staffing.proposal")("confirmApply", { count: 3 })).toBe("Bekräfta och tillämpa 3 valda");
    expect(t("sv", "staffing.proposal")("confirmApply", { count: 1 })).toBe("Bekräfta och tillämpa 1 vald");
    expect(t("en", "staffing.proposal")("confirmApply", { count: 3 })).toBe("Confirm and apply 3 selected");
    expect(t("sv", "staffing.proposal")("confirmTitle")).toBe("Bekräfta ny undervisning");
    expect(t("en", "staffing.proposal")("confirmTitle")).toBe("Confirm new teaching");
  });

  it("says how many of the refused changes had no confirmation", () => {
    expect(t("sv", "staffing.proposal")("newTeachingUnconfirmed", { count: 1 })).toContain("Förslaget ger en ändring ny undervisning");
    expect(t("sv", "staffing.proposal")("newTeachingUnconfirmed", { count: 4 })).toContain("Förslaget ger 4 ändringar ny undervisning");
    expect(t("en", "staffing.proposal")("newTeachingUnconfirmed", { count: 1 })).toContain("gives one change new teaching");
    expect(t("en", "staffing.proposal")("newTeachingUnconfirmed", { count: 4 })).toContain("gives 4 changes new teaching");
  });

  it("addresses the reader as 'du', as the rest of the app does, and never says a teacher is moved without the school's say", () => {
    for (const key of ["onlyUnstaffedOffHint", "confirmBody", "releasedSkipped", "nothingToDoRelease"]) {
      expect(t("sv", "staffing.proposal")(key, { count: 2 }), key).not.toMatch(/\b(ni|er|ert|era)\b/i);
    }
    expect(t("sv", "staffing.engineRelease")("hint")).not.toMatch(/\b(ni|er|ert|era)\b/i);
    expect(t("sv", "staffing.proposal")("onlyUnstaffedOffHint")).toContain("flyttas aldrig");
    expect(t("en", "staffing.proposal")("onlyUnstaffedOffHint")).toContain("never moved");
  });
});
