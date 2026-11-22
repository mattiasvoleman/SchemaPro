import { describe, expect, it } from "vitest";
import { findPersonalData, holdsPersonalData } from "@/lib/pseudonym-detect";
import { KEEP, mark } from "@/lib/pseudonym-headers";
import { parseText } from "@/lib/pseudonym-input";
import { isMarker, MARKER_PATTERN, markerText } from "@/lib/pseudonym-markers";
import { planFile, pseudonymise } from "@/lib/pseudonym-run";

/*
 * THE TF NUMBER IN THE PSEUDONYMISER (X3, 2026-11-22). Skola24's own files hold ÅÅÅÅMMDDTFnn where a personnummer goes. It has no check digit and is no
 * person's date and serial, so nothing that reads a personnummer's digits may read it: not the day (a samordningsnummer), not Luhn (a number whose digit
 * does not hold), not the spelling pattern ÅÅMMDDNNNN. It is its own kind with its own marker (TF-0001), counted as TF in the report.
 */

const parse = (text: string) => parseText(text, "file", "UTF-8", false)!;
const run = (text: string, treatments: Record<number, ReturnType<typeof mark> | typeof KEEP> = {}) => {
  const result = pseudonymise([parse(text)], { files: [{ treatments }] });
  if (!result.ok) throw new Error(`undecided: ${JSON.stringify(result.undecided)}`);
  return result;
};

describe("a TF number is found as one", () => {
  it("is its own kind: no check digit, never a personnummer or a samordningsnummer, and its key is its value in upper case", () => {
    const [found, ...rest] = findPersonalData("Id 19000101TF01");
    expect(rest).toEqual([]);
    expect(found).toMatchObject({ kind: "tf", key: "19000101TF01", spelling: "ÅÅÅÅMMDDTFNN" });
    expect("checkDigit" in found!).toBe(false);
  });

  it("is one key for every spelling, and one spelling pattern per way of writing it, with no digit of the value in it", () => {
    const found = findPersonalData("A 19000101TF01, B 19000101tf01, C 19000101-TF01, D 19000101 Tf01 och E １９０００１０１TF０１.");
    expect(found.map((f) => f.kind)).toEqual(Array(5).fill("tf"));
    expect(found.map((f) => f.key)).toEqual(Array(5).fill("19000101TF01"));
    expect(found.map((f) => f.spelling)).toEqual(["ÅÅÅÅMMDDTFNN", "ÅÅÅÅMMDDtfNN", "ÅÅÅÅMMDD-TFNN", "ÅÅÅÅMMDD TfNN", "ÅÅÅÅMMDDTFNN"]);
    expect(JSON.stringify(found.map((f) => f.spelling))).not.toMatch(/1900|01TF/);
  });

  it("is not read for a day: a date whose day reads as a samordningsnummer's is still a TF number", () => {
    for (const text of ["19000161TF01", "19000191TF01", "19000131TF01"]) {
      expect(findPersonalData(text).map((f) => [f.kind, f.key]), text).toEqual([["tf", text]]);
    }
  });

  it("is not taken for a telephone number, and not cut in two by one, whatever its digits look like", () => {
    expect(findPersonalData("07012345TF67").map((f) => [f.kind, f.start, f.end])).toEqual([["tf", 0, 12]]);
    expect(findPersonalData("0701234567 19000101TF01").map((f) => f.kind)).toEqual(["tel", "tf"]);
    expect(findPersonalData("19000101TF01 0701234567").map((f) => f.kind)).toEqual(["tf", "tel"]);
  });

  it("stands beside a personnummer and a samordningsnummer in the order of the text, never overlapping", () => {
    const found = findPersonalData("800101-1234 19000101TF01 800161-1234 anna@skola.se 19000102tf02");
    expect(found.map((f) => f.kind)).toEqual(["pnr", "tf", "sam", "epost", "tf"]);
    for (let i = 1; i < found.length; i += 1) expect(found[i]!.start).toBeGreaterThanOrEqual(found[i - 1]!.end);
  });

  it("changes nothing for the numbers it used to read: a personnummer keeps its kind, key, check digit and spelling", () => {
    expect(findPersonalData("800101-1234")).toEqual([{ kind: "pnr", start: 0, end: 11, key: "8001011234", checkDigit: false, spelling: "ÅÅMMDD-NNNN" }]);
    expect(findPersonalData("800161-1234")[0]).toMatchObject({ kind: "sam", key: "8001611234" });
  });

  it("finds nothing in what has not the digits of a TF number, and in a code a school writes", () => {
    for (const text of ["TF01", "19000101TF", "19000101TF1", "7ATF12", "TF2026", "Block TF-12"]) expect(findPersonalData(text), text).toEqual([]);
  });
});

/**
 * THE WIDE SEARCH (the review of #383, L-4). The shared door counts one form of a TF number as documented and a few as our reading, and refuses nothing else: a cell in another
 * spelling is read as text, which is a cost. In the pseudonymiser the same miss is a number left in a file that is sent on, so the pseudonymiser looks wider than the door: blanks and
 * hyphens around TF and between the parts of the date, a plus, a date written ÅÅÅÅ-MM-DD, a line break. The door itself is not changed (personal-number-cases.json says so).
 */
const NUMBER = "19000101TF01";

describe("a TF number in a spelling the shared shape does not know is found by the pseudonymiser", () => {
  it.each([
    ["blanks around TF", "19000101 TF 01"],
    ["a blank after TF", "19000101TF 01"],
    ["a blank inside the date", "1900 0101TF01"],
    ["a date as ÅÅÅÅ-MM-DD", "1900-01-01TF01"],
    ["a date as ÅÅÅÅ-MM-DD and a hyphen", "1900-01-01-TF01"],
    ["a date as ÅÅÅÅ-MM-DD and blanks", "1900-01-01 TF 01"],
    ["a plus before TF", "19000101+TF01"],
    ["a full stop and a slash", "1900.01.01/TF/01"],
    ["two blanks before TF", "19000101  TF01"],
    ["a Windows line break before TF", "19000101\r\nTF01"],
    ["a line feed after TF", "19000101TF\n01"],
    ["a soft hyphen", "19000101\u00adTF01"],
    ["a zero-width space between T and F", "19000101T\u200bF01"],
    ["a no-break space after TF", "19000101TF\u00a001"],
    ["lower case and blanks", "19000101 tf 01"],
    ["full-width digits and letters", "１９０００１０１ ＴＦ ０１"],
  ])("%s", (_name, text) => {
    const [found, ...rest] = findPersonalData(text);
    expect(rest, text).toEqual([]);
    expect(found, text).toMatchObject({ kind: "tf", key: NUMBER, start: 0, end: text.length });
    expect("checkDigit" in found!).toBe(false);
    // A pattern that says how it was written and holds no digit of the value.
    expect(found!.spelling).toMatch(/^ÅÅÅÅ[ -]*MM[ -]*DD[ +-]*[Tt][ -]?[Ff][ -]*NN$/);
  });

  it("is the same key and the same marker as the documented spelling, so that one person is one marker in every row", () => {
    const text = "Id;Namn\n19000101TF01;Anna\n19000101 TF 01;Bo\n1900-01-01-TF01;Cia\n19000101\r\nTF01;Dan\n19000102 TF 01;Eva\n";
    // (The line break in a quoted cell stays one cell.)
    const quoted = text.replace("19000101\r\nTF01", '"19000101\r\nTF01"');
    const result = run(quoted, { 1: mark("namn") });
    const lines = result.files[0]!.text.split(/\r?\n/).filter((line) => line !== "").slice(1).map((line) => line.split(";")[0]);
    expect(lines).toEqual(["TF-0001", "TF-0001", "TF-0001", "TF-0001", "TF-0002"]);
    expect(result.report.totals.tf).toEqual({ occurrences: 5, distinct: 2 });
    expect(result.report.totals.pnr).toEqual({ occurrences: 0, distinct: 0 });
    expect(result.files[0]!.text).not.toMatch(/1900|TF ?0|T F/);
    expect(result.check.passed).toBe(true);
  });

  it("is found in running text, where only the number is replaced", () => {
    const result = run("Namn;Anteckning\nAnna;Elev 19000101 TF 01 flyttad, tidigare 1900-01-01-TF01 och 19000102TF 02\n", { 0: mark("namn"), 1: KEEP });
    // (The cell is quoted: it holds a comma.)
    expect(result.files[0]!.text).toMatch(/"Elev TF-0001 flyttad, tidigare TF-0001 och TF-0002"\n/);
    expect(result.report.totals.tf).toEqual({ occurrences: 3, distinct: 2 });
    expect(result.check.passed).toBe(true);
  });

  it("is found in a file without a header row and under a header that says nothing", () => {
    const headerless = run("19000101 TF 01;Anna;ok\n1900-01-01-TF02;Bo;ok\n19000101TF03;Cia;ok\n", { 1: mark("namn"), 2: KEEP });
    expect(headerless.files[0]!.text).not.toMatch(/1900|TF ?0|Anna|Cia/);
    expect(headerless.report.totals.tf.distinct).toBe(3);
    expect(headerless.check.passed).toBe(true);
    for (const header of ["Id", "Kod"]) {
      const result = run(`${header};Namn\n19000101 TF 01;Anna\n1900-01-01-TF02;Bo\n19000101TF 03;Cia\n`, { 1: mark("namn") });
      expect(result.files[0]!.text, header).not.toMatch(/1900|TF ?0|Anna|Cia/);
      expect(result.report.totals.tf.distinct, header).toBe(3);
      expect(result.check.passed, header).toBe(true);
    }
  });

  it("is a matrix of every blank, hyphen, plus and break around TF: every one is found, whole, with the key of its number", () => {
    const dates = ["19000101", "1900-01-01", "1900 01 01", "1900 0101", "190001-01", "1900.01.01", "1900/01/01"];
    const before = ["", " ", "-", "+", "  ", "\r\n", "\u00a0", " - ", "\t"];
    const letters = ["TF", "tf", "Tf", "tF", "T F", "T-F"];
    const after = ["", " ", "-", "\n", "\r\n", " - "];
    let tried = 0;
    for (const date of dates) {
      for (const b of before) {
        for (const l of letters) {
          for (const a of after) {
            const text = `${date}${b}${l}${a}01`;
            const found = findPersonalData(`Elev ${text} flyttad`);
            expect(found.map((f) => [f.kind, f.key]), JSON.stringify(text)).toEqual([["tf", NUMBER]]);
            expect(found[0]!.end - found[0]!.start, JSON.stringify(text)).toBe(text.length);
            tried += 1;
          }
        }
      }
    }
    expect(tried).toBe(dates.length * before.length * letters.length * after.length);
  });

  it("is checked in the finished file with the same search: nothing in a wide spelling is left, and a marker is not taken for one", () => {
    const result = run("Id;Namn\n19000101 TF 01;Anna\n1900-01-01-TF02;Bo\n", { 1: mark("namn") });
    expect(result.check.passed).toBe(true);
    expect(holdsPersonalData(result.files[0]!.text)).toBe(false);
    expect(holdsPersonalData("Id;Namn\n19000101 TF 01;Anna")).toBe(true);
    // Run on its own output, it changes nothing.
    const again = run(result.files[0]!.text, { 1: mark("namn") });
    expect(again.files[0]!.text).toBe(result.files[0]!.text);
  });

  it("is told apart from a code a school writes: none of these is a TF number", () => {
    for (const text of [
      "7ATF12", "Ma7 TF12", "TF2026", "Block TF-12", "Sal TF12345678", "NV20TF12", "Åk 7 TF-12", "Hus 12 TF 12", "Sal 2026 TF 12", "Kurs 1900 TF 01",
      "TF 19000101", "T F 19000101", "TF-19000101-01", "1900 TF 01 01",
      // Not eight digits before, or not two after.
      "1900010 TF 01", "19000101 TF 1", "19000101 TF", "19000101 TFX01", "19000101 TF-X",
      // Dates and times a lesson list holds.
      "2026-11-21", "2026-11-21 Tis 08:10-09:10", "08:10 - 09:10 TF 12", "Vecka 47 TF 12 Sal 4", "19000101 Fre 12",
      // A TF number's own parts apart, and the markers.
      "19000101", "TF 01", "TF-0001", "TF-0002 och TF-0003", "PNR-0001 TF-0001",
    ]) {
      expect(findPersonalData(text), text).toEqual([]);
    }
  });

  it("costs a school a marker for a date that is followed by TF and two digits, as the shared door does: it is stated, not hidden", () => {
    expect(findPersonalData("Prov 20261121 TF 15").map((f) => [f.kind, f.key])).toEqual([["tf", "20261121TF15"]]);
  });

  // A record with no blank between its fields has digits next to the number. The door does not count such a number (a digit beside it is a longer number), and the pseudonymiser
  // must: the number is a TF number whatever stands beside it, and what stands beside it is left as it was (the review of #396).
  it.each([
    ["a class code that begins with a digit after it", "7A  19000101TF017A  Ma", "19000101TF01"],
    ["a course code that ends with a digit before it", "Ma719000101TF01", "19000101TF01"],
    ["a digit after it", "19000101TF0123", "19000101TF01"],
    ["digits both sides", "719000101TF0123", "19000101TF01"],
    ["a digit after a number written with blanks", "19000101 TF 012", "19000101 TF 01"],
    ["a digit before a number written with hyphens", "21900-01-01-TF01", "1900-01-01-TF01"],
  ])("takes a TF number with a digit stuck to it: %s, and only the number", (_name, text, span) => {
    const found = findPersonalData(text);
    expect(found.map((f) => [f.kind, text.slice(f.start, f.end)]), text).toEqual([["tf", span]]);
    expect(found[0]!.key, text).toBe(NUMBER);
  });

  it("replaces only the number when a digit stands beside it, and the rest of the cell stays", () => {
    const result = run("Namn;Rad\nAnna;7A  19000101TF017A  Ma\nBo;Ma719000102TF02\n", { 0: mark("namn"), 1: KEEP });
    expect(result.files[0]!.text).toBe("Namn;Rad\nNAMN-0001;7A  TF-00017A  Ma\nNAMN-0002;Ma7TF-0002\n");
    expect(result.files[0]!.text).not.toMatch(/1900|TF0\d/);
    expect(result.report.totals.tf).toEqual({ occurrences: 2, distinct: 2 });
    expect(result.check.passed).toBe(true);
  });

  it("does not take a date of six digits: no file has shown one", () => {
    expect(findPersonalData("Id 800101TF01 och 800101 TF 01")).toEqual([]);
  });

  it("is not cut in two by a telephone number nor merged with a personnummer beside it", () => {
    expect(findPersonalData("0701234567 19000101 TF 01").map((f) => f.kind)).toEqual(["tel", "tf"]);
    expect(findPersonalData("19000101 TF 01; 0701234567").map((f) => f.kind)).toEqual(["tf", "tel"]);
    // (Without a separator, "01 0701234567" reads as a twelve-digit personnummer in the shared shape: the span is taken whole as the TF number, and nothing of either is left.)
    expect(findPersonalData("19000101 TF 01 0701234567").map((f) => f.kind)).toEqual(["tf"]);
    expect(findPersonalData("800101-1234; 1900-01-01-TF01; 800161-1234").map((f) => f.kind)).toEqual(["pnr", "tf", "sam"]);
    expect(findPersonalData("anna@skola.se 19000101 TF 01").map((f) => f.kind)).toEqual(["epost", "tf"]);
  });

  it("takes linear time on a long cell, and finds the number at its end", () => {
    const started = Date.now();
    // A megabyte of words and groups of digits with one TF number at its end, and a megabyte of what the expression starts on at every place and cannot finish.
    expect(findPersonalData(`${"1234 ab ".repeat(125_000)}1900-01-01-TF01`).map((f) => [f.kind, f.key])).toEqual([["tf", NUMBER]]);
    findPersonalData("1900 01 01 ".repeat(100_000));
    findPersonalData("19000101TF 0".repeat(80_000));
    expect(Date.now() - started).toBeLessThan(8000);
  });
});

/**
 * THE LIMITS OF THE WIDE SEARCH (the review of #396). The PR text says what the search takes: one or two blanks or hyphens between year, month and day; up to four blanks, hyphens
 * or a plus before TF; one blank or hyphen between T and F; up to four blanks or hyphens after TF. The matrix above only goes as far as three characters and never puts two between
 * the parts of the date, so the limits themselves (the numbers 2 and 4 in the expression) could be moved by one without a test falling. Here each limit is stood on from both sides.
 */
describe("the wide search takes what the PR says it takes, and not one character more", () => {
  const found = (text: string): unknown[] => findPersonalData(`Elev ${text} flyttad`).map((f) => [f.kind, f.key, f.end - f.start]);
  const wholeOf = (text: string): unknown[] => [["tf", NUMBER, text.length]];

  it.each([
    ["two blanks between year and month", "1900  0101TF01"],
    ["two hyphens between year and month", "1900--0101TF01"],
    ["two blanks between month and day", "190001  01TF01"],
    ["two hyphens between month and day", "190001--01TF01"],
    ["two between every part of the date", "1900--01  01TF01"],
    ["four blanks before TF", "19000101    TF01"],
    ["a hyphen, a plus, a blank and a hyphen before TF", "19000101-+ -TF01"],
    ["four blanks after TF", "19000101TF    01"],
    ["blank, two hyphens and a blank after TF", "19000101TF -- 01"],
    ["a Windows line break twice before TF (four blanks after the fold)", "19000101\r\n\r\nTF01"],
    ["one blank between T and F", "19000101T F01"],
    ["one hyphen between T and F", "19000101T-F01"],
  ])("takes %s", (_name, text) => {
    expect(found(text), JSON.stringify(text)).toEqual(wholeOf(text));
  });

  it.each([
    ["three blanks between year and month", "1900   0101TF01"],
    ["three blanks between month and day", "190001   01TF01"],
    ["five blanks before TF", "19000101     TF01"],
    ["five hyphens before TF", "19000101-----TF01"],
    ["a Windows line break three times before TF", "19000101\r\n\r\n\r\nTF01"],
    ["five blanks after TF", "19000101TF     01"],
    ["two blanks between T and F", "19000101T  F01"],
    ["a plus after TF", "19000101TF+01"],
    ["a plus between the parts of the date", "1900+0101TF01"],
    ["a blank inside the year", "19 000101TF01"],
    ["a blank between the two digits after TF", "19000101TF0 1"],
  ])("does not take %s", (_name, text) => {
    expect(found(text), JSON.stringify(text)).toEqual([]);
  });

  // The pattern the report counts a spelling under: the date's digits by their place, and every separator and the letters as they stood. A test that only asks for "blanks and hyphens
  // somewhere" cannot see a separator dropped from the pattern, or a plus turned into the default.
  it.each([
    ["19000101TF01", "ÅÅÅÅMMDDTFNN"],
    ["19000101-tf01", "ÅÅÅÅMMDD-tfNN"],
    ["19000101 TF 01", "ÅÅÅÅMMDD TF NN"],
    ["19000101+TF01", "ÅÅÅÅMMDD+TFNN"],
    ["19000101TF-01", "ÅÅÅÅMMDDTF-NN"],
    ["1900-01-01TF01", "ÅÅÅÅ-MM-DDTFNN"],
    ["1900-01-01-TF01", "ÅÅÅÅ-MM-DD-TFNN"],
    ["1900 0101 Tf 01", "ÅÅÅÅ MMDD Tf NN"],
    ["190001 01tF01", "ÅÅÅÅMM DDtFNN"],
    ["1900 01 01 tf 01", "ÅÅÅÅ MM DD tf NN"],
    ["19000101\r\nTF01", "ÅÅÅÅMMDD  TFNN"],
    ["19000101T-F01", "ÅÅÅÅMMDDT-FNN"],
    ["19000101 + TF - 01", "ÅÅÅÅMMDD + TF - NN"],
  ])("writes %j as the pattern %j", (text, pattern) => {
    expect(findPersonalData(`Elev ${text} flyttad`).map((f) => f.spelling)).toEqual([pattern]);
  });
});

describe("a TF number has a marker", () => {
  it("is TF-0001, one marker per value however it was written", () => {
    expect(markerText("tf", 1)).toBe("TF-0001");
    expect(markerText("tf", 12)).toBe("TF-0012");
    // The key is made where the number is found (Finding.key): a book is given that, and never the text of a cell.
    expect(findPersonalData("19000101-tf01 19000101 TF01 19000102TF01").map((f) => f.key)).toEqual(["19000101TF01", "19000101TF01", "19000102TF01"]);
  });

  it("is a marker the pseudonymiser leaves as it is, and holds no personal data itself", () => {
    expect(isMarker("TF-0001")).toBe(true);
    expect("Se TF-0001 och TF-0002".match(MARKER_PATTERN)).toEqual(["TF-0001", "TF-0002"]);
    expect(findPersonalData("TF-0001")).toEqual([]);
    // Not a marker: a TF number with a prefix, and a number of digits no book hands out.
    expect(isMarker("TF-19000101")).toBe(false);
  });
});

/** Skola24's own course files: no header row, TF numbers in the ID columns (the guardians' file has two of them). */
const HEADERLESS = ["19000101TF01;19000102TF01;Åsa;Testsson;Åsa ringde idag", "19000101TF02;19000102TF02;Bo;Provsson;Bo sjuk", "19000101TF03;19000102TF01;Cia;Fiktiv;Cia kommer sent", ""].join("\n");

describe("a file of TF numbers through the pseudonymiser", () => {
  it("with no header row: the first row is a person, every TF number is replaced, and the report counts them as TF", () => {
    const plan = planFile(parse(HEADERLESS));
    expect(plan.headerRow).toBeNull();
    expect(plan.columns).toHaveLength(5);
    const result = run(HEADERLESS, { 2: mark("fornamn"), 3: mark("efternamn"), 4: KEEP });
    const text = result.files[0]!.text;
    // (A name of two letters in a comment that is kept stays: X1's rule for names that short, not the TF number's.)
    expect(text).not.toMatch(/TF0|1900|Åsa|Testsson|Provsson|Cia|Fiktiv/);
    expect(text.split("\n").filter((line) => line !== "")).toHaveLength(3);
    // Five different TF numbers (the guardian's 19000102TF01 stands twice) and six cells.
    expect(result.report.totals.tf).toEqual({ occurrences: 6, distinct: 5 });
    expect(result.report.totals.pnr).toEqual({ occurrences: 0, distinct: 0 });
    expect(result.report.totals.sam).toEqual({ occurrences: 0, distinct: 0 });
    // No check digit to report on, and no spelling mistaken for a personnummer's.
    expect(result.report.checkDigit).toEqual({ pnr: { holds: 0, fails: 0 }, sam: { holds: 0, fails: 0 } });
    expect(result.report.spellings).toEqual([{ spelling: "ÅÅÅÅMMDDTFNN", count: 6 }]);
    expect(result.check.passed).toBe(true);
  });

  it("gives one person one marker: the same TF number is the same TF-nnnn in every row", () => {
    const text = run(HEADERLESS, { 2: mark("fornamn"), 3: mark("efternamn"), 4: KEEP }).files[0]!.text;
    const lines = text.split("\n").filter((line) => line !== "");
    // Row 1 and row 3 hold the same guardian TF number (19000102TF01) in the second column.
    expect(lines[0]!.split(";")[1]).toBe(lines[2]!.split(";")[1]);
    expect(lines[0]!.split(";")[0]).not.toBe(lines[1]!.split(";")[0]);
    expect(lines[0]!.split(";")[0]).toMatch(/^TF-\d{4}$/);
  });

  it("gives a TF number one marker in a personnummer column however much text stands in its cell, and counts it as TF and never as a personnummer", () => {
    const text = "Personnummer;Namn\n19000101TF01;Anna\nID 19000101TF01;Bo\n19000101-tf01 (kopia);Cia\n19000101TF01 19000101TF01;Dan\n19000102TF01 vikarie;Eva\n19000102TF01;Fia\n";
    const result = run(text, { 1: mark("namn") });
    const markers = result.files[0]!.text.split("\n").filter((line) => line !== "").slice(1).map((line) => line.split(";")[0]);
    // (A cell that is only TF numbers, with a separator, keeps each as its own marker: the fourth row.)
    expect(markers).toEqual(["TF-0001", "TF-0001", "TF-0001", "TF-0001 TF-0001", "TF-0002", "TF-0002"]);
    expect(result.report.totals.tf.distinct).toBe(2);
    expect(result.report.totals.pnr).toEqual({ occurrences: 0, distinct: 0 });
    expect(result.files[0]!.text).not.toMatch(/PNR-|1900|TF0/);
    expect(result.check.passed).toBe(true);
  });

  it.each(["Id", "Kod", "Elev", "Nummer", "Klass"])("with the header %s, which says nothing: a column of TF numbers is proposed as personnummer and replaced", (name) => {
    const text = `${name};Namn;Anteckning\n19000101TF01;Anna;ok\n19000101TF02;Bo;ok\n19000101TF03;Cia;ok\n`;
    const result = run(text, { 1: mark("namn"), 2: KEEP });
    expect(result.files[0]!.text).not.toMatch(/TF0|1900|Anna|Bo;|Cia/);
    expect(result.files[0]!.text).toMatch(/TF-0001/);
    expect(result.report.totals.tf.distinct).toBe(3);
    expect(result.check.passed).toBe(true);
  });

  it("finds a TF number in a free cell of a column that is kept, and replaces it where it stands", () => {
    const result = run("Namn;Anteckning\nAnna;Se 19000101TF01 och 19000101-tf01 samt 19000102TF02\n", { 0: mark("namn"), 1: KEEP });
    const text = result.files[0]!.text;
    expect(text).toMatch(/Se TF-0001 och TF-0001 samt TF-0002/);
    expect(text).not.toMatch(/1900/);
    expect(result.report.totals.tf).toEqual({ occurrences: 3, distinct: 2 });
    expect(result.check.passed).toBe(true);
  });

  it("leaves a code a school writes: nothing is replaced for looking a little like one", () => {
    const result = run("Klass;Block\n7ATF12;TF2026\n8BTF3;Ma7 TF12\n", { 0: KEEP, 1: KEEP });
    expect(result.files[0]!.text).toContain("7ATF12");
    expect(result.report.totals.tf).toEqual({ occurrences: 0, distinct: 0 });
  });

  it("is a file of personnummer and TF numbers mixed: each keeps its own kind and its own count", () => {
    const text = "Id;Namn\n800101-1234;Anna\n19000101TF01;Bo\n810202-2345;Cia\n";
    const result = run(text, { 1: mark("namn") });
    expect(result.report.totals.pnr.distinct).toBe(2);
    expect(result.report.totals.tf.distinct).toBe(1);
    expect(result.report.checkDigit.pnr.holds + result.report.checkDigit.pnr.fails).toBe(2);
    expect(result.files[0]!.text).not.toMatch(/8001|8102|TF0|1900/);
  });
});
