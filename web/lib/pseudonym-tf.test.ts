import { describe, expect, it } from "vitest";
import { findPersonalData } from "@/lib/pseudonym-detect";
import { KEEP, mark } from "@/lib/pseudonym-headers";
import { parseText } from "@/lib/pseudonym-input";
import { isMarker, keyOf, MARKER_PATTERN, markerText } from "@/lib/pseudonym-markers";
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

  it("finds nothing in the forms no file has shown, and in a code a school writes", () => {
    for (const text of ["TF01", "19000101TF", "19000101TF1", "19000101 TF 01", "1900 0101TF01", "7ATF12", "TF2026", "Block TF-12"]) expect(findPersonalData(text), text).toEqual([]);
  });
});

describe("a TF number has a marker", () => {
  it("is TF-0001, one marker per value however it was written", () => {
    expect(markerText("tf", 1)).toBe("TF-0001");
    expect(markerText("tf", 12)).toBe("TF-0012");
    expect(keyOf("tf", "19000101-tf01")).toBe("19000101TF01");
    expect(keyOf("tf", "19000101 TF01")).toBe(keyOf("tf", "19000101TF01"));
    expect(keyOf("tf", "19000102TF01")).not.toBe(keyOf("tf", "19000101TF01"));
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
