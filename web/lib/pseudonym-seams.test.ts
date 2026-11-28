import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { KEEP, type Treatment } from "@/lib/pseudonym-headers";
import { parseText } from "@/lib/pseudonym-input";
import { planFile, pseudonymise } from "@/lib/pseudonym-run";
import { bridgeFlow, countBridges, flowOf } from "@/lib/pseudonym-seams";

/*
 * A NUMBER CUT BY A LINE BREAK, OR BY A COMMA READ AS A DELIMITER (the reviews of #396 L-3 and #398).
 *
 * Every cell and every line was searched on its own, so "Elev 19000101" and "TF01 ingår i grupp 7A" on two lines held no number. The seams of a text that is no table, and of a table of ONE column,
 * are now bridged where there is text beside the number; the seams of a table of several columns are not (report.limit2 says so, and so do the tests below, so that the sentence cannot go untrue).
 */

const parse = (text: string) => parseText(text, "file", "UTF-8", false)!;

/** The page's way: every column the page has no opinion on is kept. */
function run(text: string) {
  const input = parse(text);
  const treatments: Record<number, Treatment> = {};
  for (const column of planFile(input).columns) if (column.proposal === null) treatments[column.index] = KEEP;
  const result = pseudonymise([input], { files: [{ treatments }] });
  if (!result.ok) throw new Error("undecided");
  return result;
}

describe("a number cut by a line break in running text is one number", () => {
  const LIST = (a: string, b: string, eol = "\r\n") => ["Elevlista för terminen", `Elev ${a}${eol}${b} ingår i grupp 7A`, "Och en rad till;a;b", ""].join(eol);

  it("a TF number cut at the blank before TF: the marker is where the number began, and what stands beyond it stays", () => {
    const result = run(LIST("19000101", "TF01"));
    expect(result.files[0]!.text).toBe("Elevlista för terminen\r\nElev TF-0001\r\n ingår i grupp 7A\r\nOch en rad till;a;b\r\n");
    expect(result.report.totals.tf).toEqual({ occurrences: 1, distinct: 1 });
    expect(result.check.passed).toBe(true);
  });

  it("a TF number cut anywhere, as a text wrapped at a fixed width is: with no blank to put between the halves", () => {
    for (const [a, b] of [["190", "00101TF01"], ["19000", "101TF01"], ["19000101T", "F01"], ["19000101TF0", "1"], ["19000101TF", "01"], ["19000101-", "TF01"], ["19000101 TF-", "01"]]) {
      const result = run(LIST(a, b));
      expect(result.report.totals.tf, `${a} / ${b}`).toEqual({ occurrences: 1, distinct: 1 });
      expect(result.files[0]!.text, `${a} / ${b}`).not.toMatch(/1900|TF01/);
    }
  });

  it("with a line feed and with a carriage return alone, as with a carriage return and a line feed", () => {
    for (const eol of ["\n", "\r"]) {
      const result = run(LIST("19000101", "TF01", eol));
      expect(result.report.totals.tf.occurrences, JSON.stringify(eol)).toBe(1);
      expect(result.files[0]!.text, JSON.stringify(eol)).not.toMatch(/1900|TF01/);
      // The line ending of the file is the file's own.
      expect(result.files[0]!.text.includes(eol), JSON.stringify(eol)).toBe(true);
    }
  });

  it("a personnummer cut after its hyphen, and a telephone number cut at a blank", () => {
    const pnr = run(LIST("800101-", "1234"));
    expect(pnr.report.totals.pnr).toEqual({ occurrences: 1, distinct: 1 });
    expect(pnr.files[0]!.text).not.toMatch(/800101|1234/);
    const tel = run(LIST("070-123", "45 67"));
    expect(tel.report.totals.tel).toEqual({ occurrences: 1, distinct: 1 });
    expect(tel.files[0]!.text).not.toMatch(/070|45 67/);
  });

  it("is counted as the number it is, in the check digit line and among the spellings, like one found whole (the review of #403)", () => {
    const pnr = run(LIST("800101-", "1234"));
    expect(pnr.report.checkDigit.pnr.holds + pnr.report.checkDigit.pnr.fails).toBe(1);
    expect(pnr.report.spellings).toEqual([{ spelling: "ÅÅMMDD-NNNN", count: 1 }]);
    const tf = run(LIST("19000101", "TF01"));
    expect(tf.report.spellings).toEqual([{ spelling: "ÅÅÅÅMMDDTFNN", count: 1 }]);
    // ... and no check digit is asked of a TF number.
    expect(tf.report.checkDigit.pnr.holds + tf.report.checkDigit.pnr.fails + tf.report.checkDigit.sam.holds + tf.report.checkDigit.sam.fails).toBe(0);
  });

  it("counts both halves among the cells of the column it changed (the report says how many cells of a column were replaced)", () => {
    const result = run(["Elevlista", "Elev 19000101", "TF01 ingår i grupp 7A", "Tack", ""].join("\r\n"));
    expect(result.report.files[0]!.columns[0]!.changed).toBe(2);
  });

  it("is the same marker as the same number written whole, and counts once", () => {
    const text = ["Brev om eleven", "Vi har noterat att eleven med id 19000101", "TF01 inte har kommit idag.", "Hälsningar skolan", "Och 19000101TF01 igen.", ""].join("\r\n");
    const result = run(text);
    expect(result.files[0]!.text.match(/TF-\d{4}/g)).toEqual(["TF-0001", "TF-0001"]);
    expect(result.report.totals.tf).toEqual({ occurrences: 2, distinct: 1 });
  });

  it("running it again on what came out changes nothing", () => {
    const first = run(LIST("19000101", "TF01")).files[0]!.text;
    expect(run(first).files[0]!.text).toBe(first);
  });

  it("a text that is not a table at all, line by line", () => {
    const text = ["Brev till vårdnadshavare;a", "Vi har noterat att eleven med id 19000101", "TF01 saknas idag", "Tack;för;hjälpen;nu", "Välkommen;igen", "Med vänlig hälsning;skolan;rektor;Ma", ""].join("\r\n");
    expect(parse(text).body.shape).toBe("lines");
    const result = run(text);
    expect(result.report.totals.tf).toEqual({ occurrences: 1, distinct: 1 });
    expect(result.files[0]!.text).not.toMatch(/1900|TF01/);
  });
});

describe("a comma in running text that was read as the delimiter of a list", () => {
  it("does not cut a personnummer in two cells: the number is put together across the comma", () => {
    const text = ["Brev om eleven", "Vi har noterat att eleven 800101,1234 saknas idag.", "Hälsningar skolan", ""].join("\r\n");
    expect(parse(text).facts.delimiter).toBe(",");
    const result = run(text);
    expect(result.report.totals.pnr).toEqual({ occurrences: 1, distinct: 1 });
    // The comma was the number's: it goes with it, and the delimiter that was read between the cells is written back between them.
    expect(result.files[0]!.text).toBe("Brev om eleven\r\nVi har noterat att eleven PNR-0001, saknas idag.\r\nHälsningar skolan\r\n");
    expect(result.check.passed).toBe(true);
  });
});

describe("a comma read as a delimiter is put back as the comma it was", () => {
  it("so a comma that is no separator of a number does not make two halves one: 070 and 1234567 are two words, not a telephone number", () => {
    const text = ["Brev om eleven", "Ring på 070,1234567 om något", "Hälsningar skolan", ""].join("\r\n");
    expect(parse(text).facts.delimiter).toBe(",");
    const result = run(text);
    expect(result.report.totals.tel.occurrences).toBe(0);
    expect(result.files[0]!.text).toBe(text);
  });
});

describe("where a seam is NOT bridged", () => {
  it("a list of dates on one line each and times on the next: no text beside the numbers, so no personnummer of a date and a time", () => {
    const text = ["Datum och tid", "20261121", "0810", "20261122", "0900", ""].join("\r\n");
    const result = run(text);
    expect(result.files[0]!.text).toBe(text);
    expect(result.report.totals.pnr.occurrences).toBe(0);
  });

  it("a number cut in two with nothing else on either line is left (the cost of the rule, and what report.limit2 says)", () => {
    const text = ["Id", "19000101", "TF01", ""].join("\r\n");
    expect(run(text).files[0]!.text).toBe(text);
  });

  it("a table of several columns: the last cell of a row and the first of the next are different records (report.limit2)", () => {
    const text = ["Klass;Notis", "7A;Se 20261121", "0810;ok", "7B;ok", ""].join("\r\n");
    const result = run(text);
    expect(result.files[0]!.text).toBe(text);
    expect(result.report.totals.pnr.occurrences).toBe(0);
    expect(flowOf(parse(text).body, ";")).toBeNull();
  });

  it("is the price said in the manual: a line that ends with a date and a line that begins with four digits (a time) are a personnummer in a list of one column, as on one line", () => {
    const text = ["Schema", "Datum 20261121", "0810 Matematik i sal 4", "Datum 20261122", "0900 Svenska i sal 5", ""].join("\r\n");
    const result = run(text);
    expect(result.report.totals.pnr.occurrences).toBe(2);
    expect(result.files[0]!.text).toBe("Schema\r\nDatum PNR-0001\r\n Matematik i sal 4\r\nDatum PNR-0002\r\n Svenska i sal 5\r\n");
  });

  it("is no longer a price: a time written without a colon at the end of a line and digits at the start of the next are eight digits and left as they are (X1b, the review of #403, M-1); the manual says so", () => {
    const text = ["Schema", "Tid 0815", "0810 Matematik i sal 4", "Tid 0900", "1000 Svenska i sal 5", ""].join("\r\n");
    const result = run(text);
    expect(result.report.totals.tel.occurrences).toBe(0);
    expect(result.files[0]!.text).toBe(text);
  });

  it("does not end a number in the middle of a word on the second line: a list of lessons with no delimiter keeps the row numbers and the classes (X1b, the review of #403, M-1)", () => {
    const text = ["Lektioner", "0001 7A MAT 0815 0900", "0002 7A ENG 0910 0955", "0003 7B SVE 1010 1055", ""].join("\r\n");
    expect(run(text).files[0]!.text).toBe(text);
  });

  it("still puts a telephone number of nine or ten digits together that a line break cut, and one cut right after its plus", () => {
    expect(run(["Brev till vårdnadshavare", "Ring mig på 070 123 45", "67 om det brådskar", ""].join("\r\n")).files[0]!.text).toBe(
      ["Brev till vårdnadshavare", "Ring mig på TEL-0001", " om det brådskar", ""].join("\r\n"),
    );
    expect(run(["Brev till vårdnadshavare", "Ring mig på +", "46 70 910 72 78 om det brådskar", ""].join("\r\n")).report.totals.tel.occurrences).toBe(1);
  });

  it("is said in the manual, next to the price of a date and four digits: a time without a colon that is left, the Stockholm number that is not found, and what 46 costs in the telephone row (the review of #403)", () => {
    const manual = readFileSync(resolve(process.cwd(), "../docs/manual/anvandarmanual.html"), "utf8").replace(/\s+/g, " ");
    expect(manual).toContain("<em>Tid 0815</em> och <em>0810 Matematik</em>");
    expect(manual).toContain("<em>Vecka 46 20261116</em>");
    expect(manual).toContain("har nio siffror eller fler");
    expect(manual).toContain("lämnas som det är");
    expect(manual).not.toContain("märket tar början av den andra raden med sig");
  });

  it("wants two letters in a row beside the number, and one letter is not text: 'Å 20261121' and '0810' are left", () => {
    const text = ["Schema", "Å 20261121", "0810", "B 20261122", "0900", ""].join("\r\n");
    expect(run(text).files[0]!.text).toBe(text);
  });

  it("is numbered in the order of the file: a number at the end of a line before one at its start is the first, whichever the search finds first", () => {
    const text = ["Brev om eleven", "Först 800101-1234 sedan 820303-3456", "Namn 5 poäng och mer", "Hälsningar skolan", "Tack för hjälpen", ""].join("\r\n");
    const result = run(text);
    expect(result.files[0]!.text).toBe("Brev om eleven\r\nFörst PNR-0001 sedan PNR-0002\r\nNamn 5 poäng och mer\r\nHälsningar skolan\r\nTack för hjälpen\r\n");
  });

  it("an address cut by a line break is not put together: report.limit2 does not say it is", () => {
    const text = ["Brev om eleven", "Skriv till anna.svensson2@", "skola3.se om det behövs", "Hälsningar skolan", ""].join("\r\n");
    expect(run(text).files[0]!.text).toBe(text);
  });

  it("a number that is a number already on its first line, grown by what the next line begins with: 070-123 45 and 67 are one telephone number (the review of #403)", () => {
    const text = ["Brev om eleven", "Ring 070-123 45", "67 om något har hänt", "Hälsningar skolan", ""].join("\r\n");
    const result = run(text);
    expect(result.report.totals.tel).toEqual({ occurrences: 1, distinct: 1 });
    expect(result.files[0]!.text).toBe("Brev om eleven\r\nRing TEL-0001\r\n om något har hänt\r\nHälsningar skolan\r\n");
  });

  it("a hard-wrapped text: lines of seventy and eighty characters, which is what a wrapped letter has and the seam search looks at the end of, not the start (the review of #403)", () => {
    const long = "Vi skriver för att berätta att det blivit en ändring för eleven som heter";
    expect(long.length).toBeGreaterThan(64);
    const text = ["Brev", `${long} 19000101`, `TF01 och som går i grupp sju. ${"Det gäller från och med nästa vecka.".padEnd(60, " ")}`, "Hälsningar", ""].join("\r\n");
    const result = run(text);
    expect(result.report.totals.tf).toEqual({ occurrences: 1, distinct: 1 });
    expect(result.files[0]!.text.split("\r\n")[1]).toBe(`${long} TF-0001`);
    expect(result.files[0]!.text).not.toMatch(/1900|TF01/);
    expect(result.check.passed).toBe(true);
  });

  it("a number whole at the end of a line stays one, and the digits that begin the next line are not taken into it", () => {
    const text = ["Brev om eleven", "Elev 800101-1234", "5678 ingår i grupp 7A", "Hälsningar skolan", ""].join("\r\n");
    const result = run(text);
    expect(result.files[0]!.text).toBe("Brev om eleven\r\nElev PNR-0001\r\n5678 ingår i grupp 7A\r\nHälsningar skolan\r\n");
    expect(result.report.totals.pnr).toEqual({ occurrences: 1, distinct: 1 });
  });

  it("two numbers, one whole at the end of a line and one at the start of the next: neither is made into a third", () => {
    const text = ["Brev om eleven", "Skolan 072 745 74 56 19580410-6309", "151122-2166 Ida", "Hälsningar skolan", "Tack för hjälpen", "Vi ses snart", "Med vänlig hälsning", ""].join("\r\n");
    const result = run(text);
    expect(result.report.totals.tel.occurrences).toBe(1);
    expect(result.report.totals.pnr.occurrences).toBe(2);
    expect(result.files[0]!.text).toBe("Brev om eleven\r\nSkolan TEL-0001 PNR-0001\r\nPNR-0002 Ida\r\nHälsningar skolan\r\nTack för hjälpen\r\nVi ses snart\r\nMed vänlig hälsning\r\n");
  });
});

describe("the flow", () => {
  it("of a text that is not a table has a line break between each line, and a table of one column too, with the delimiter between the cells of a row that has more", () => {
    expect(flowOf(parse("A;B\r\nC;D\r\nE;F\r\n").body, ";")).toBeNull();
    const list = flowOf(parse("Namn\r\nBo, Ek\r\nCia\r\nDan\r\n").body, ",");
    expect(list!.segments).toEqual(["Namn", "Bo", " Ek", "Cia", "Dan"]);
    expect(list!.seams).toEqual(["\n", ",", "\n", "\n"]);
    const text = flowOf({ shape: "lines", lines: ["a", "b", "c"] }, null);
    expect(text!.seams).toEqual(["\n", "\n"]);
    expect(text!.rebuild(["x", "y", "z"])).toEqual({ shape: "lines", lines: ["x", "y", "z"] });
  });

  it("counts a number across a seam, and none once it is replaced: the check on the finished text", () => {
    const flow = flowOf({ shape: "lines", lines: ["Elev 19000101", "TF01 ingår"] }, null)!;
    expect(countBridges(flow)).toBe(1);
    const replaced = bridgeFlow(flow, () => "TF-0001");
    expect(replaced).toEqual(["Elev TF-0001", " ingår"]);
    expect(countBridges({ ...flow, segments: replaced })).toBe(0);
  });

  it("leaves the digits of a marker alone: a marker next to digits is not part of a number", () => {
    const flow = flowOf({ shape: "lines", lines: ["Elev PNR-0001", "2345 6789 ingår i gruppen"] }, null)!;
    expect(countBridges(flow)).toBe(0);
  });
});
