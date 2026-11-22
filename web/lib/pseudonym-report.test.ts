import { describe, expect, it } from "vitest";
import enMessages from "@/messages/en.json";
import svMessages from "@/messages/sv.json";
import { KEEP } from "@/lib/pseudonym-headers";
import { flattenLabels, sayWith, type Labels } from "@/lib/pseudonym-labels";
import { parseText, type ParsedInput } from "@/lib/pseudonym-input";
import { renderReport } from "@/lib/pseudonym-report";
import { pseudonymise, type RunResult } from "@/lib/pseudonym-run";

const SV = flattenLabels(svMessages.pseudonymiserare) as Labels;
const EN = flattenLabels(enMessages.pseudonymiserare) as Labels;

const input = (text: string): ParsedInput => parseText(text, "file", "UTF-8", false)!;
const run = (inputs: ParsedInput[], words: string[] = [], keep: number[] = []): Extract<RunResult, { ok: true }> => {
  const result = pseudonymise(inputs, { words, files: inputs.map(() => ({ treatments: Object.fromEntries(keep.map((c) => [c, KEEP])) })) });
  if (!result.ok) throw new Error(JSON.stringify(result.undecided));
  return result;
};

/** Invented people, numbers and addresses, which the report must not hold in any spelling. */
const SECRETS = ["Svensson", "Anna", "Bo Ek", "Lindgren", "800101", "070-123 45 67", "0701234567", "skola.se", "anna.svensson", "1234"];

const TABLE = [
  "Skola;Björkskolan",
  "Lärare;E-post;Telefon;Personnummer;Klass;Notis",
  "Anna Svensson;anna.svensson@skola.se;070-123 45 67;800101-1234;7A;Anna ringde",
  "Bo Ek;bo.ek@skola.se;08-123 456 78;19800202-2345;7B;Se Lindgren",
  "Anna Svensson;anna.svensson@skola.se;070-123 45 67;800101-1234;7B;ok",
].join("\n");

describe.each([
  ["Swedish", SV, "sv"],
  ["English", EN, "en"],
] as const)("the report, in %s", (_name, labels, locale) => {
  const say = sayWith(labels, locale);

  it("holds not one original value, whatever the file: a table, a table with no header, text that is no table, a workbook's sheet, several files", () => {
    const cases: [string, ParsedInput[], string[], number[]][] = [
      ["a table", [input(TABLE)], [], [5]],
      ["a table with a word list", [input(TABLE)], ["Lindgren", "Svensson"], [5]],
      ["lines", [input("Anna Svensson ringde 070-123 45 67\nMejla anna.svensson@skola.se, tack\nHälsning Bo Ek, och mer, text")], ["Anna", "Bo Ek"], []],
      ["two files", [input(TABLE), input("Namn;Klass\nAnna Svensson;7A\nBo Ek;7B\n")], [], [5]],
    ];
    for (const [name, inputs, words, keep] of cases) {
      const text = renderReport(run(inputs, words, keep).report, say);
      for (const secret of SECRETS) expect(text, `${name}: ${secret}`).not.toContain(secret);
      // A title above a table is on the safe file's preview and not in the report.
      expect(text, name).not.toContain("Björkskolan");
    }
  });

  it("has every placeholder filled in: no {name} and no plural left as written", () => {
    const text = renderReport(run([input(TABLE), input("Anna Svensson ringde 070-123 45 67\nMejla anna@skola.se, tack\nHälsning, och mer, text")], ["Anna"], [5]).report, say);
    expect(text).not.toMatch(/[{}]/);
    expect(text).not.toMatch(/\bundefined\b|\bNaN\b/);
  });

  it("says what was replaced per kind, how each column was treated and by whom, and what the tool cannot judge", () => {
    const text = renderReport(run([input(TABLE)], [], [5]).report, say);
    expect(text).toContain(say("report.title"));
    expect(text).toContain(say("kind.pnr"));
    expect(text).toContain(say("kind.epost"));
    expect(text).toContain(say("kind.tel"));
    expect(text).toContain(say("report.limits"));
    expect(text).toContain(say("report.limit1"));
    expect(text).toContain(say("report.limit7"));
    expect(text).toContain(say("report.offline"));
    // The columns, by their headers as they stand in the safe file.
    expect(text).toContain("Lärare");
    expect(text).toContain("Notis");
    // The spellings of personnummer, as patterns.
    expect(text).toContain("ÅÅMMDD-NNNN");
    expect(text).toContain("ÅÅÅÅMMDD-NNNN");
  });

  it("says what was replaced of TF numbers under their own name, how they were written as a pattern, and nothing of a check digit", () => {
    const text = renderReport(run([input("Id;Kod;Notis\n19000101TF01;19000102tf01;Se 19000101-TF01\n19000101TF02;19000102tf01;ok\n")], [], [2]).report, say);
    expect(text).toContain(say("kind.tf"));
    // Not a line of the summary under personnummer: the numbers are TF numbers, and the report says what the column was marked as in the words of the page.
    expect(text).not.toMatch(new RegExp(`^- ${say("kind.pnr")}:`, "m"));
    expect(text).toContain(say("treatment.mark", { kind: say("group.pnr") }));
    expect(text).toContain(say("report.spellings"));
    expect(text).toContain("ÅÅÅÅMMDDTFNN");
    expect(text).toContain("ÅÅÅÅMMDD-TFNN");
    expect(text).toContain("ÅÅÅÅMMDDtfNN");
    // No value, not the date's digits and not the two after TF.
    expect(text).not.toMatch(/1900|TF0\d|tf01/);
    expect(text).not.toContain(say("report.checkDigit", { kind: say("kind.pnr"), holds: 0, fails: 0 }));
    expect(text).not.toMatch(/[{}]/);
  });

  it("says the form of the file: its encoding, delimiter and line ending", () => {
    const text = renderReport(run([input(TABLE)], [], [5]).report, say);
    expect(text).toMatch(/UTF-8/);
    expect(text).toContain("LF");
  });

  it("says nothing was replaced when nothing was, and nothing more", () => {
    const text = renderReport(run([input("Klass;Dag\n7A;Mån\n7B;Tis\n")]).report, say);
    expect(text).toContain(say("report.nothingReplaced"));
    expect(text).not.toContain(say("report.spellings"));
  });
});

describe("the report names no file", () => {
  it("has no name of a file, a sheet's name as it stands in the safe copy only", () => {
    const parsed: ParsedInput = { ...input("Lärare;Klass\nAnna;7A\n"), facts: { ...input("a;b\n").facts, sheet: "800101-1234" } };
    const text = renderReport(run([parsed]).report, sayWith(SV, "sv"));
    expect(text).toContain("PNR-0001");
    expect(text).not.toContain("800101");
  });
});
