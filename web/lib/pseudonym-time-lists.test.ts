import { describe, expect, it } from "vitest";
import { findPersonalData } from "@/lib/pseudonym-detect";

/*
 * A LIST OF TIMES WRITTEN WITH FULL STOPS AND BLANKS IS NO TELEPHONE NUMBER (the review of #496).
 *
 * X1b takes a number written with full stops among blanks and hyphens (070.123 45 67). "Tider 08.10 08.55 09.10 10.00", the way a Swedish timetable writes its times, has five groups of two digits and ten
 * digits, and was a telephone number on the head of #496 where main left it as it was: the times of a lesson list became TEL-0001.
 * (What main already does, and is not changed here: "Tider: 08.10 09.00 10.15 11.30" has a group "00" that begins an international number, and "00 10.15 11.30" is one.)
 */

const kinds = (text: string): string[] => findPersonalData(text).map((found) => found.kind);

describe("times written with full stops, one after the other", () => {
  it.each(["Tider 08.10 08.55 09.10 10.00 imorgon", "Tider 08.10 09.30 10.15 11.30 klart", "Pass 07.45 08.30 09.15 10.00 11.00"])("%s is left as it is", (text) => {
    expect(kinds(text)).toEqual([]);
  });
});

describe("a telephone number with full stops and blanks mixed is still one", () => {
  it.each(["Ring 070.123 45 67 nu", "Ring 070-123.45.67 nu", "Ring 08.12 34 56 78 nu", "Ring 46.70 123 45 67 nu", "Ring 031.123 456 78 nu"])("%s", (text) => {
    expect(kinds(text)).toEqual(["tel"]);
  });
});
