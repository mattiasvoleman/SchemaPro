import { describe, expect, it } from "vitest";
import { findPersonalData } from "@/lib/pseudonym-detect";
import { expandExponents, wholeNumberOf } from "@/lib/pseudonym-exponent";
import { KEEP, type Treatment } from "@/lib/pseudonym-headers";
import { parseText } from "@/lib/pseudonym-input";
import { planFile, pseudonymise } from "@/lib/pseudonym-run";

/*
 * X1b: the gaps the reviews of #377, #398 and #403 named and the page said it could not find. Each case is a file or a cell written the way the review wrote it, and what is asked is what the page does:
 * the number is gone and a marker stands, or (for what is NOT a number) the text stands as it was.
 */

/** The page's way, with every column the page has no opinion on kept: what it hands out. */
function run(text: string): { out: string; asked: number } {
  const input = parseText(text, "file", "UTF-8", false);
  if (input === null) throw new Error("nothing to read");
  const plan = planFile(input, undefined, Date.UTC(2026, 10, 26));
  const treatments: Record<number, Treatment> = {};
  let asked = 0;
  for (const column of plan.columns) {
    if (column.proposal === null) {
      treatments[column.index] = KEEP;
      asked += 1;
    }
  }
  const result = pseudonymise([input], { files: [{ treatments }] });
  if (!result.ok) throw new Error("undecided");
  return { out: result.files[0]!.text, asked };
}

const found = (text: string): [string, string][] => findPersonalData(text).map((f) => [f.kind, text.slice(f.start, f.end)]);

describe("a number written with an exponent (the review of #398, H-1: found in the xlsx reader, and a CSV is text)", () => {
  it("writes out a whole number of ten to twelve digits and says where each of its characters stood", () => {
    expect(wholeNumberOf("8.001011234E9")).toBe("8001011234");
    expect(wholeNumberOf("8,001011234E+09")).toBe("8001011234");
    expect(wholeNumberOf("1.98001011234E11")).toBe("198001011234");
    expect(wholeNumberOf("8,00101E+09")).toBe("8001010000");
    expect(wholeNumberOf("8.001011234e9")).toBe("8001011234");
    const view = expandExponents("Id 8.001011234E9 klass");
    expect(view!.text).toBe("Id 8001011234 klass");
    // "Id " is itself; the ten digits all stand for the whole number, columns 3 to 16; " klass" is itself again.
    expect(view!.startAt[2]).toBe(2);
    expect(view!.startAt[3]).toBe(3);
    expect(view!.endAt[3]).toBe(16);
    expect(view!.startAt[12]).toBe(3);
    expect(view!.endAt[12]).toBe(16);
    expect(view!.startAt[13]).toBe(16);
    expect(view!.endAt[13]).toBe(17);
  });

  it.each([
    ["a fraction", "1.5E-3"],
    ["a number that is not whole", "2.5E0"],
    ["more zeros than a number has", "1E400"],
    ["nine digits (a telephone number with its 0 left off: the page asks about a column of them as it does)", "7.01234567E8"],
    ["thirteen digits", "1.234567890123E12"],
    ["a minus", "-8.001011234E9"],
    ["a letter stuck to it", "x8.001011234E9"],
    ["no digit before the E", "E9"],
    ["a word", "1e"],
  ])("does not write out %s", (_name, text) => {
    expect(wholeNumberOf(text)).toBeNull();
    expect(expandExponents(`Se ${text} igen`)).toBeNull();
  });

  it("is found as the personnummer it stands for, with the number as written as the span, and the same key as the plain number", () => {
    const text = "Se 8.001011234E9 och 8001011234 igen";
    const all = findPersonalData(text);
    expect(all.map((f) => [f.kind, text.slice(f.start, f.end)])).toEqual([
      ["pnr", "8.001011234E9"],
      ["pnr", "8001011234"],
    ]);
    expect(all[0]!.key).toBe(all[1]!.key);
    expect(all[0]!.spelling).toBe("ÅÅMMDDNNNN (tal med exponent)");
    // A century, a comma for the decimal point, a plus in the exponent, a lower-case e.
    expect(found("1,98001011234E+11")).toEqual([["pnr", "1,98001011234E+11"]]);
    expect(found("8,001011234e9")).toEqual([["pnr", "8,001011234e9"]]);
  });

  it("is found as a number that an export has cut to six digits (Excel in Swedish settings saves 8,00101E+09): what is left of it is the date and a part of the rest", () => {
    expect(found("8,00101E+09")).toEqual([["pnr", "8,00101E+09"]]);
  });

  it("is not found where nothing in it is a personnummer, or where it is a different kind of number", () => {
    // A month of 13, a quantity of ten digits, a version, a measurement.
    expect(found("8,613011234E9")).toEqual([]);
    expect(found("1.5E10 kr")).toEqual([]);
    expect(found("v2.0E5")).toEqual([]);
    expect(found("3,0E8 m/s")).toEqual([]);
  });

  it("takes a column of them out of a file, where it was KEPT whole under the header Id (it was a personnummer in a column the header called a structure)", () => {
    const text = "Id;Klass\r\n8.001011234E9;7A\r\n7.001011239E9;7B\r\n";
    const { out, asked } = run(text);
    expect(out).toBe("Id;Klass\r\nPNR-0001;7A\r\nPNR-0002;7B\r\n");
    expect(asked).toBe(0);
    expect(run("Id;Klass\r\n8,001011234E+09;7A\r\n7,00101E+09;7B\r\n").out).toBe("Id;Klass\r\nPNR-0001;7A\r\nPNR-0002;7B\r\n");
  });

  it("takes one out of running text, with the same marker as the plain number", () => {
    const { out } = run("Klass;Notis\r\n7A;Elev 8.001011234E9 saknas\r\n7B;Elev 8001011234 saknas\r\n7C;ok\r\n7D;ok\r\n7E;ok\r\n7F;ok\r\n");
    expect(out).toBe("Klass;Notis\r\n7A;Elev PNR-0001 saknas\r\n7B;Elev PNR-0001 saknas\r\n7C;ok\r\n7D;ok\r\n7E;ok\r\n7F;ok\r\n");
  });

  it("leaves a quantity alone", () => {
    const text = "Klass;Belopp\r\n7A;1.5E10\r\n7B;2.5E3\r\n";
    expect(run(text).out).toBe(text);
  });
});

describe("a line break inside a quoted cell (the review of #403, L-5 b)", () => {
  it("is read as a line feed is: 8001<CRLF>011234 is a personnummer as 8001<LF>011234 is", () => {
    expect(found("Elev 8001\n011234 saknas")).toEqual([["pnr", "8001\n011234"]]);
    expect(found("Elev 8001\r\n011234 saknas")).toEqual([["pnr", "8001\r\n011234"]]);
    const cell = (eol: string): string => `Klass;Notis\r\n7A;"Se 8001${eol}011234 igen"\r\n7B;ok\r\n7C;ok\r\n`;
    expect(run(cell("\n")).out).toBe(run(cell("\r\n")).out);
    expect(run(cell("\r\n")).out).toContain("PNR-0001");
    expect(run(cell("\r\n")).out).not.toContain("011234");
  });

  it("is read as a line feed is for a telephone number and a TF number too, and two of them in a row are two blanks as two line feeds are", () => {
    expect(found("Ring 070 123\r\n45 67 nu")).toEqual([["tel", "070 123\r\n45 67"]]);
    expect(found("Elev 19000101\r\nTF01")).toEqual([["tf", "19000101\r\nTF01"]]);
    expect(found("8001\r\n\r\n011234")).toEqual(found("8001\n\n011234"));
  });

  it("leaves two numbers on two lines two numbers, as it did", () => {
    const text = "Ring 0701234567\r\n0812345678 nu";
    expect(found(text).map(([kind]) => kind)).toEqual(found(text.replace(/\r\n/g, "\n")).map(([kind]) => kind));
  });
});

describe("a control character between the digits (the review of #403, L-6 c)", () => {
  it.each([
    ["one", "8001\u0001011234"],
    ["several", "80\u000101\u000201\u0003\u00071234"],
    ["a delete and a C1 control", "800101\u007f12\u009034"],
    ["with a hyphen", "800101-\u00011234"],
  ])("is no gap in a personnummer: %s", (_name, text) => {
    expect(found(`Elev ${text} saknas`).map(([kind]) => kind)).toEqual(["pnr"]);
    expect(findPersonalData(`Elev ${text} saknas`)[0]!.key).toBe("8001011234");
  });

  it("is no gap in a telephone number or a TF number either", () => {
    expect(found("Ring 070\u0001123\u000245\u000367 nu").map(([kind]) => kind)).toEqual(["tel"]);
    expect(found("Elev 1900\u00010101TF\u000201").map(([kind]) => kind)).toEqual(["tf"]);
  });

  it("leaves a tab and a line break to be what they are: blanks", () => {
    expect(found("Elev 800101\t1234 saknas").map(([kind]) => kind)).toEqual(["pnr"]);
    expect(found("Ring 070\t123\t45\t67 nu").map(([kind]) => kind)).toEqual(["tel"]);
  });
});

describe("a symbol between the date and the last four (the review of #403, L-6 a)", () => {
  it.each(["*", "|", "\u2022", "\u00b7", "~", "#", "=", ";"])("%s is taken as a colon is", (symbol) => {
    const text = `Elev 800101${symbol}1234 saknas`;
    expect(found(text), text).toEqual([["pnr", `800101${symbol}1234`]]);
    expect(findPersonalData(text)[0]!.key).toBe("8001011234");
    expect(findPersonalData(text)[0]!.spelling).toBe(`ÅÅMMDD${symbol}NNNN`);
  });

  it("is taken with a century, with the date written with hyphens, and with a blank on each side", () => {
    expect(found("Elev 19800101*1234").map(([kind]) => kind)).toEqual(["pnr"]);
    expect(found("Elev 1980-01-01|1234").map(([kind]) => kind)).toEqual(["pnr"]);
    expect(found("Elev 800101 * 1234").map(([kind]) => kind)).toEqual(["pnr"]);
  });

  it("is not taken anywhere but between a date and four digits that nothing follows: a time, an amount, a sum", () => {
    for (const text of ["Tid 10*12 1234", "Pris 1 250*3", "5*1234", "20261116* 1 250 kr", "7A*7B", "Mån 08:10 | Tis 09:10", "a=1234"]) {
      expect(found(text), text).toEqual([]);
    }
  });

  it("is not taken with a letter, which is no mark: 800101x1234", () => {
    expect(found("Elev 800101x1234 saknas")).toEqual([]);
  });
});

describe("a telephone number with full stops and blanks or hyphens mixed (the review of #403, L-6 b)", () => {
  it.each(["070.123 45 67", "070-123.45.67", "070 123.45 67", "46.31 333 29 00", "+46 70.123 45 67", "08.123 456 78", "0046.70 123 45 67"])("%s is one number", (number) => {
    // Whether it is labelled a telephone number or a personnummer depends on its digits (a ten-digit number that begins with 0 and has a full stop in it reads as either); it is one span, and it is taken.
    expect(found(`Ring ${number} nu`).map(([, span]) => span), number).toEqual([number]);
  });

  it("has one key for the same number written two ways", () => {
    expect(findPersonalData("070.123 45 67")[0]!.key).toBe(findPersonalData("070-123 45 67")[0]!.key);
  });

  it("is not taken for a time, a date, a version or an amount", () => {
    for (const text of ["08.10-09.00", "07.45 12 30", "0.5 - 1.5 2 3", "Tid 07.45 - 08.30", "10.0.0.1 2", "v 1.2 3 4 5", "Pris 0.50 12 34", "2026-08-17 12.30"]) {
      expect(found(text).map(([kind]) => kind), text).toEqual([]);
    }
  });
});
