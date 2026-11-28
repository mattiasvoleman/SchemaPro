import { describe, expect, it } from "vitest";
import { findPersonalData } from "@/lib/pseudonym-detect";
import { wholeNumberOf } from "@/lib/pseudonym-exponent";
import { KEEP, type Treatment } from "@/lib/pseudonym-headers";
import { parseText } from "@/lib/pseudonym-input";
import { planFile, pseudonymise } from "@/lib/pseudonym-run";

/*
 * A NUMBER WITH AN EXPONENT IS FOUND IN THE FORMS A WRITER GIVES IT (the review of #496).
 *
 * X1b writes a whole number of ten to twelve digits out of its exponent form and searches the digits. The exponent was one or two digits (Java, Excel, Python write E9 and E+09; .NET's "E" format writes E+009), and the
 * form was looked for in the text as it stood, so a character that shows nothing inside it (8.001011234<ZWSP>E9) or a digit in full width hid the number, where every other number is found through both.
 */

const found = (text: string): [string, string][] => findPersonalData(text).map((f) => [f.kind, text.slice(f.start, f.end)]);

function run(text: string): string {
  const input = parseText(text, "file", "UTF-8", false)!;
  const plan = planFile(input, undefined, Date.UTC(2026, 10, 26));
  const treatments: Record<number, Treatment> = {};
  for (const column of plan.columns) if (column.proposal === null) treatments[column.index] = KEEP;
  const result = pseudonymise([input], { files: [{ treatments }] });
  if (!result.ok) throw new Error("undecided");
  return result.files[0]!.text;
}

describe("an exponent of three digits (E+009)", () => {
  it("is a whole number as the shorter ones are", () => {
    expect(wholeNumberOf("8.001011234E+009")).toBe("8001011234");
    expect(wholeNumberOf("8,001011234e009")).toBe("8001011234");
    expect(wholeNumberOf("1.98001011234E+011")).toBe("198001011234");
  });

  it.each(["8.001011234E+009", "8.001011234e+009", "8,001011234E+009", "1.98001011234E+011"])("%s is a personnummer, in a column an id and in running text", (cell) => {
    expect(found(`Id ${cell} klass`).map(([kind]) => kind)).toEqual(["pnr"]);
    expect(run(`Id;Klass\r\n${cell};7A\r\n800101-1239;7B\r\n`)).toBe("Id;Klass\r\nPNR-0001;7A\r\nPNR-0002;7B\r\n");
  });

  it("leaves what is no whole number of that length as it was", () => {
    expect(found("Pris 1.5E+003 kr")).toEqual([]);
    expect(found("Tal 1E+0400")).toEqual([]);
  });
});

describe("a character that shows nothing, and a digit in full width, in a number with an exponent", () => {
  it.each([
    ["a zero-width space before the E", "8.001011234​E9"],
    ["a zero-width space after the point", "8.​001011234E9"],
    ["a soft hyphen in the digits", "8.0010­11234E+09"],
    ["a zero-width space in the exponent", "8.001011234E​9"],
    ["a control character before the E", "8,001011234\u0001E+09"],
    ["the digits in full width", "８.００１０１１２３４E9"],
  ])("%s is a personnummer", (_name, cell) => {
    expect(found(`Id ${cell} klass`).map(([kind]) => kind), JSON.stringify(cell)).toEqual(["pnr"]);
    const out = run(`Id;Klass\r\n${cell};7A\r\n800101-1239;7B\r\n`);
    expect(out).toBe("Id;Klass\r\nPNR-0001;7A\r\nPNR-0002;7B\r\n");
  });

  it("gives the number the key of the same number written plainly", () => {
    const key = (text: string) => findPersonalData(text)[0]!.key;
    expect(key("8.001011234​E9")).toBe(key("800101-1234"));
    expect(key("8.001011234E+009")).toBe(key("800101-1234"));
  });
});
