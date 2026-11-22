import { describe, expect, it } from "vitest";
import { columnStats, proposalFor } from "@/lib/pseudonym-headers";

/*
 * A COLUMN OF NUMBERS IS NOT ALWAYS STRUCTURE (review of #377).
 *
 * A column in which every filled cell is a number, a time or a date is kept without asking. Excel stores a telephone number typed as 0701234567 as the
 * number 701234567, and a personnummer of someone born after 1999 (0101011234) as 101011234, so a workbook's column of mobile numbers under a header the
 * lists do not know was a column of numbers, kept whole, and the user was never asked. A column with a number of seven digits or more is asked about.
 */

describe("a column of numbers", () => {
  it("is asked about when a number in it has seven digits or more", () => {
    const stats = columnStats(["701234567", "708765432", "736543210"]);
    expect(proposalFor("Ring", stats)).toBeNull();
    expect(stats.longNumbers).toBe(3);
    expect(proposalFor("", columnStats(["12", "101011234"]))).toBeNull();
  });

  it("is still kept when its numbers are lessons, weeks, minutes, years and times", () => {
    expect(proposalFor("", columnStats(["1", "45", "2026", "08:10", "2026-08-17", "0,5", "123456"]))).toEqual({ treatment: { kind: "keep" }, reason: "values", detail: "numbers" });
  });

  it("does not override a header the lists know", () => {
    expect(proposalFor("Id", columnStats(["101011234", "201011234"]))).toEqual({ treatment: { kind: "keep" }, reason: "header", detail: "structure" });
    expect(proposalFor("Telefon", columnStats(["701234567"]))?.treatment).toEqual({ kind: "mark", marker: "tel" });
  });
});
