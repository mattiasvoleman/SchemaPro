import { describe, expect, it } from "vitest";
import { KEEP, type Treatment } from "@/lib/pseudonym-headers";
import { findPersonalData } from "@/lib/pseudonym-detect";
import { parseText } from "@/lib/pseudonym-input";
import { planFile, pseudonymise } from "@/lib/pseudonym-run";

/*
 * A SYMBOL BETWEEN A DATE AND FOUR DIGITS IS A MASKED NUMBER ONLY WHERE THE CHECK DIGIT HOLDS (the review of #496).
 *
 * X1b took * | a bullet, a middle dot, ~ # = and ; between the date and the last four of a personnummer. A bar is what a file is delimited with, and the page reads only ; , and tab as delimiters,
 * so a file of "20261126|0900|7A" was read as ONE column and every row, a date and a time, was a personnummer: the whole file came out as PNR-0001, PNR-0002, SAM-0001. A real number has a
 * check digit that holds (about one date-and-time pair in ten has one by chance); the glued run of digits already asks for it.
 */

/** Written here by the rule, not taken from the page: the check digit of nine digits. */
function withCheckDigit(nine: string): string {
  let sum = 0;
  for (let i = 0; i < 9; i += 1) {
    let digit = Number(nine[i]);
    if (i % 2 === 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return nine + String((10 - (sum % 10)) % 10);
}

function run(text: string): string {
  const input = parseText(text, "file", "UTF-8", false)!;
  const plan = planFile(input);
  const treatments: Record<number, Treatment> = {};
  for (const column of plan.columns) if (column.proposal === null) treatments[column.index] = KEEP;
  const result = pseudonymise([input], { files: [{ treatments }] });
  if (!result.ok) throw new Error("undecided");
  return result.files[0]!.text;
}

describe("a date and a time with a symbol between them", () => {
  it("is no personnummer in a file delimited with a bar, which the page reads as one column", () => {
    const file = "Datum|Tid|Klass\r\n20261126|0900|7A\r\n20261127|0810|7B\r\n20261130|1040|7C\r\n";
    expect(run(file)).toBe(file);
    // The cost that is left, said here and in the handbook: about one date-and-time pair in ten has a check digit that holds by chance (20261128|0955 does) and is taken for a number.
    expect(findPersonalData("20261128|0955").map((found) => found.kind)).toEqual(["pnr"]);
  });

  it.each(["Lektion 20260115;0830", "Lektion 260115 | 0830", "Lektion 260115 # 0830", "Lektion 260115 * 0830", "| 20261126 | 0900 | 7A |", "Elev 7A;20261126=0900"])("%s is left as it is", (text) => {
    expect(findPersonalData(text)).toEqual([]);
  });
});

describe("a real number with a symbol between the date and the last four", () => {
  const number = withCheckDigit("800101123");
  it.each(["*", "|", "•", "·", "~", "#", "=", ";"])("is found with %s", (symbol) => {
    const text = `Elev ${number.slice(0, 6)}${symbol}${number.slice(6)} saknas`;
    const found = findPersonalData(text);
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("pnr");
    expect(text.slice(found[0]!.start, found[0]!.end)).toBe(`${number.slice(0, 6)}${symbol}${number.slice(6)}`);
  });

  it("is found with a century and a symbol, and with a blank beside the symbol", () => {
    expect(findPersonalData(`19${number.slice(0, 6)}*${number.slice(6)}`)).toHaveLength(1);
    expect(findPersonalData(`${number.slice(0, 6)} | ${number.slice(6)}`)).toHaveLength(1);
  });

  it("is found with a colon, a comma or an apostrophe whether or not its check digit holds (those are not what a file is delimited with)", () => {
    expect(findPersonalData("800101:1234")).toHaveLength(1);
    expect(findPersonalData("800101,1234")).toHaveLength(1);
    expect(findPersonalData("800101'1234")).toHaveLength(1);
  });
});
