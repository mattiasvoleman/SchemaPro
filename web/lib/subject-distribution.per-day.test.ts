import { describe, expect, it } from "vitest";
import { MAX_LESSONS_PER_DAY_MAX, MAX_LESSONS_PER_DAY_MIN, perDayInRange, perDayValue } from "@/lib/subject-distribution";

/*
 * The per-day field of the two dialogs that write the ämnesfördelning (a subject's, and a post's own rule on /admin/requirements): empty is no
 * limit and otherwise a whole number inside the bounds of the DTO, the CHECK and the engine. The functions moved here from
 * components/timplan/distribution-fields.tsx with the lazy split of the requirements dialog (omgång 12, B8); the dialogs' own tests reach them only
 * by typing a value, and nothing there typed the top of the range.
 */
describe("perDayInRange", () => {
  it("has the bounds the DTO, the CHECK and the engine have", () => {
    expect([MAX_LESSONS_PER_DAY_MIN, MAX_LESSONS_PER_DAY_MAX]).toEqual([1, 20]);
  });

  it("takes an empty field as no limit, and a whole number from the lowest bound to the highest, with or without spaces around it", () => {
    for (const value of ["", "   ", "1", "2", "19", "20", " 7 "]) expect(perDayInRange(value), `"${value}"`).toBe(true);
  });

  it("refuses what the API would: none a day, one over the top, a fraction, a negative, a comma and words", () => {
    for (const value of ["0", "21", "100", "1.5", "-1", "2,5", "abc", "1 2"]) expect(perDayInRange(value), `"${value}"`).toBe(false);
  });
});

describe("perDayValue", () => {
  it("reads an empty field as null, which is no limit, and any other as its number", () => {
    expect(perDayValue("")).toBeNull();
    expect(perDayValue("   ")).toBeNull();
    expect(perDayValue("3")).toBe(3);
    expect(perDayValue(" 20 ")).toBe(20);
  });
});
