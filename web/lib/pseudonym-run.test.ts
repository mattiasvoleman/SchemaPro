import { describe, expect, it } from "vitest";
import { CLEAR, KEEP, mark } from "@/lib/pseudonym-headers";
import { parseSource, parseText, type ParsedInput } from "@/lib/pseudonym-input";
import { KnownNames } from "@/lib/pseudonym-names";
import { leftIn, planFile, pseudonymise, resolveTreatments, type RunChoices, type RunResult } from "@/lib/pseudonym-run";

const input = (text: string): ParsedInput => parseText(text, "file", "UTF-8", false)!;
const run = (inputs: ParsedInput[], choices: RunChoices): Extract<RunResult, { ok: true }> => {
  const result = pseudonymise(inputs, choices);
  if (!result.ok) throw new Error(`undecided: ${JSON.stringify(result.undecided)}`);
  return result;
};

/** An invented school file: a title above the header, a column nobody has named, a name in a comment, and a telephone number and an address in text. */
const SCHOOL = [
  "Skola;Björkskolan",
  "Lärare;Ämne;Klass;Dag;Start;Notis",
  "Anna Svensson;Svenska;7A;Mån;08:10;Anna är sjuk, ring 070-123 45 67",
  "Bo Ek;Matte;7B;Tis;09:00;Se anna.svensson@skola.se",
  "Anna Svensson;Svenska;7B;Ons;10:00;",
  "Cia Lind;Engelska;8A;Tor;11:00;Byt sal i morgon",
  "Bo Ek;Matte;8B;Fre;12:00;Prov på fredag",
].join("\r\n") + "\r\n";

describe("planFile", () => {
  it("takes the first row that is nearly as full as the fullest as the header, so that a two-cell title above is a title", () => {
    const plan = planFile(input(SCHOOL));
    expect(plan.shape).toBe("table");
    expect(plan.headerRow).toBe(2);
    expect(plan.titleRows).toBe(1);
    expect(plan.columns.map((c) => c.header)).toEqual(["Lärare", "Ämne", "Klass", "Dag", "Start", "Notis"]);
  });

  it("proposes by the header where it knows it and by nothing where it does not, so that Notis is a column to decide", () => {
    const plan = planFile(input(SCHOOL));
    expect(plan.columns.map((c) => c.proposal?.treatment ?? null)).toEqual([mark("namn"), KEEP, KEEP, KEEP, KEEP, null]);
    expect(plan.columns[0]!.proposal).toMatchObject({ reason: "header", detail: "namn" });
  });

  it("lets the user say which row is the header, or that there is none, and falls back to the default for a row that is not there", () => {
    // The table is as wide as its widest row, whatever row the header stands on.
    expect(planFile(input(SCHOOL), 1).columns.map((c) => c.header)).toEqual(["Skola", "Björkskolan", "", "", "", ""]);
    expect(planFile(input(SCHOOL), null).columns.map((c) => c.header)).toEqual(["", "", "", "", "", ""]);
    expect(planFile(input(SCHOOL), 99).headerRow).toBe(2);
    expect(planFile(input(SCHOOL), null).titleRows).toBe(0);
  });

  it("offers the first ten rows as header candidates, and a list of one column has no header to guess", () => {
    expect(planFile(input(SCHOOL)).headerCandidates).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(planFile(input("Anna\nBo\nCia\n")).headerRow).toBeNull();
  });

  it("has no columns for lines", () => {
    const lines = parseText("Kära Anna,\nVi ses kl 8, och sen, kanske\nHälsningar\n", "file", "UTF-8", false)!;
    expect(planFile(lines)).toEqual({ shape: "lines", headerRow: null, headerCandidates: [], titleRows: 0, columns: [] });
  });

  it("resolves the user's choice before the proposal, and null for a column with neither", () => {
    const plan = planFile(input(SCHOOL));
    expect(resolveTreatments(plan, undefined)[5]).toBeNull();
    expect(resolveTreatments(plan, { treatments: { 5: KEEP, 1: CLEAR } })).toEqual([mark("namn"), CLEAR, KEEP, KEEP, KEEP, KEEP]);
  });
});

describe("pseudonymise: nothing is decided for the user in silence", () => {
  it("stops, writing nothing, and names the columns that have no proposal and no choice", () => {
    expect(pseudonymise([input(SCHOOL)], { files: [{}] })).toEqual({ ok: false, undecided: [{ file: 0, columns: [5] }] });
  });

  it("runs when every column has one", () => {
    expect(pseudonymise([input(SCHOOL)], { files: [{ treatments: { 5: KEEP } }] }).ok).toBe(true);
  });
});

describe("pseudonymise: an invented school file", () => {
  const result = run([input(SCHOOL)], { files: [{ treatments: { 5: KEEP } }] });

  it("replaces the names of the column, the telephone number and the address in the text and the known name in the comment, with stable markers, and keeps the rest as it was", () => {
    expect(result.files[0]!.text).toBe(
      [
        "Skola;Björkskolan",
        "Lärare;Ämne;Klass;Dag;Start;Notis",
        'NAMN-0001;Svenska;7A;Mån;08:10;"NAMN-0002 är sjuk, ring TEL-0001"',
        "NAMN-0003;Matte;7B;Tis;09:00;Se epost-0001@exempel.invalid",
        "NAMN-0001;Svenska;7B;Ons;10:00;",
        "NAMN-0004;Engelska;8A;Tor;11:00;Byt sal i morgon",
        "NAMN-0003;Matte;8B;Fre;12:00;Prov på fredag",
      ].join("\r\n") + "\r\n",
    );
  });

  it("counts each kind by where it was found, and the different values it made", () => {
    expect(result.report.totals.namn).toEqual({ occurrences: 6, distinct: 4 });
    expect(result.report.totals.tel).toEqual({ occurrences: 1, distinct: 1 });
    expect(result.report.totals.epost).toEqual({ occurrences: 1, distinct: 1 });
    expect(result.report.totals.pnr).toEqual({ occurrences: 0, distinct: 0 });
    const [file] = result.report.files;
    expect(file!.tally.namn).toEqual({ column: 5, content: 0, names: 1 });
    expect(file!.tally.tel).toEqual({ column: 0, content: 1, names: 0 });
    expect(result.report.knownNames).toBe(4);
  });

  it("says what each column was taken for, and by whom: the header, the values or the user", () => {
    const columns = result.report.files[0]!.columns;
    expect(columns[0]).toMatchObject({ header: "Lärare", treatment: mark("namn"), by: "header", detail: "namn", filled: 5, changed: 5 });
    expect(columns[1]).toMatchObject({ header: "Ämne", treatment: KEEP, by: "header", detail: "structure", changed: 0 });
    expect(columns[5]).toMatchObject({ header: "Notis", treatment: KEEP, by: "user", filled: 4, changed: 2 });
  });

  it("notes the rows above the header, which are free text and are shown, and the form of the file", () => {
    expect(result.report.notes).toContainEqual({ code: "titleRows", file: 0, rows: 1 });
    expect(result.report.files[0]).toMatchObject({
      facts: { origin: "file", encoding: "UTF-8", bom: false, eol: "\r\n", delimiter: ";" },
      shape: "table",
      rows: 7,
      headerRow: 2,
      titleRows: 1,
    });
  });

  it("holds not one original value: not a name, a number, an address or a school's name", () => {
    const report = JSON.stringify(result.report);
    for (const value of ["Svensson", "Anna", "Bo Ek", "070", "skola.se", "Björkskolan", "anna"]) expect(report, value).not.toContain(value);
  });

  it("passes its own check, and previews the title, the header and the rows with the numbers they have", () => {
    expect(result.check).toEqual({ passed: true, failures: [] });
    expect(result.files[0]!.preview.map((row) => row.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(result.files[0]!.preview[0]!.cells).toEqual(["Skola", "Björkskolan"]);
  });
});

describe("pseudonymise: the user's choices", () => {
  it("clears a column and keeps its header, and counts the cells it cleared", () => {
    const result = run([input(SCHOOL)], { files: [{ treatments: { 5: CLEAR, 3: CLEAR } }] });
    expect(result.files[0]!.text.split("\r\n")[2]).toBe("NAMN-0001;Svenska;7A;;08:10;");
    expect(result.files[0]!.text.split("\r\n")[1]).toBe("Lärare;Ämne;Klass;Dag;Start;Notis");
    expect(result.report.files[0]!.cleared).toBe(9);
  });

  it("replaces a column the header does not know with the kind the user chose, and a kept column that holds a personnummer still has it replaced", () => {
    const text = "Id;Anm;Klass\n1;Anna;7A\n2;Bo;7B 800101-1234\n3;Cia;7C\n4;Dan;7D\n";
    const result = run([input(text)], { files: [{ treatments: { 1: mark("fornamn") } }] });
    expect(result.files[0]!.text).toBe("Id;Anm;Klass\n1;FORNAMN-0001;7A\n2;FORNAMN-0002;7B PNR-0001\n3;FORNAMN-0003;7C\n4;FORNAMN-0004;7D\n");
  });

  it("lets the user turn a proposal off: a column the header calls names can be kept", () => {
    const result = run([input("Namn;Klass\nMatematik;7A\nSvenska;7B\n")], { files: [{ treatments: { 0: KEEP } }] });
    expect(result.files[0]!.text).toBe("Namn;Klass\nMatematik;7A\nSvenska;7B\n");
  });

  it("takes a header row the user chose, and no header row at all", () => {
    const text = "Anna;Svenska\nBo;Matte\n";
    expect(run([input(text)], { files: [{ headerRow: null, treatments: { 0: mark("fornamn"), 1: KEEP } }] }).files[0]!.text).toBe("FORNAMN-0001;Svenska\nFORNAMN-0002;Matte\n");
  });

  it("replaces the cells of the header row when the user says they are names, as in a matrix with a teacher to a column", () => {
    // "Tid" is a word the lists know as structure: the corner of the matrix stays.
    const text = "Tid;Anna Svensson;Bo Ek\n08:10;7A;7B\n";
    const result = run([input(text)], { files: [{ headersAreNames: true, treatments: { 1: KEEP, 2: KEEP } }] });
    expect(result.files[0]!.text).toBe("Tid;NAMN-0001;NAMN-0002\n08:10;7A;7B\n");
    expect(JSON.stringify(result.report)).not.toContain("Svensson");
  });
});

describe("pseudonymise: lists and kinds", () => {
  it("replaces a list of names item by item, and of addresses, keeping the separators and the blanks", () => {
    const text = 'Lärare;E-post\n"Anna Svensson ; Bo Ek/Cia Lind";"a@b.se, c@d.se"\nBo Ek;a@b.se\n';
    const result = run([input(text)], { files: [{}] });
    expect(result.files[0]!.text).toBe('Lärare;E-post\n"NAMN-0001 ; NAMN-0002/NAMN-0003";"epost-0001@exempel.invalid, epost-0002@exempel.invalid"\nNAMN-0002;epost-0001@exempel.invalid\n');
  });

  it("gives a signature column its own markers, in a list split on commas as well, and never looks for a signature in another column", () => {
    const text = "Sign;Ämne;Notis\nANSV, BOEK;ANSV;ok\nANSV;BOEK;ANSV sjuk idag\n";
    const result = run([input(text)], { files: [{ treatments: { 2: KEEP } }] });
    expect(result.files[0]!.text).toBe('Sign;Ämne;Notis\n"SIGN-0001, SIGN-0002";ANSV;ok\nSIGN-0001;BOEK;ANSV sjuk idag\n');
  });

  it("gives förnamn, efternamn, e-post, telefon and personnummer columns their kinds, and one person's number one marker however it was written", () => {
    const text = [
      "Förnamn;Efternamn;E-post;Telefon;Personnummer",
      "Anna;Svensson;anna@skola.se;070-123 45 67;800101-1234",
      "Anna;Lind;ANNA@Skola.se;+46 70 123 45 67;19800101-1234",
      "Bo;Svensson;bo@skola.se;08-123 456 78;800161-1234",
    ].join("\n");
    const result = run([input(text)], { files: [{}] });
    expect(result.files[0]!.text.split("\n")).toEqual([
      "Förnamn;Efternamn;E-post;Telefon;Personnummer",
      "FORNAMN-0001;EFTERNAMN-0001;epost-0001@exempel.invalid;TEL-0001;PNR-0001",
      "FORNAMN-0001;EFTERNAMN-0002;epost-0001@exempel.invalid;TEL-0001;PNR-0001",
      "FORNAMN-0002;EFTERNAMN-0001;epost-0002@exempel.invalid;TEL-0002;SAM-0001",
    ]);
    expect(result.report.totals.pnr).toEqual({ occurrences: 2, distinct: 1 });
    expect(result.report.totals.sam).toEqual({ occurrences: 1, distinct: 1 });
  });

  it("replaces a cell of a personnummer column that is no personnummer whole, so that nothing of it stays", () => {
    const result = run([input("Personnummer;Klass\n800101;7A\nsaknas;7B\n800101-1234;7C\n")], { files: [{}] });
    expect(result.files[0]!.text).toBe("Personnummer;Klass\nPNR-0001;7A\nPNR-0002;7B\nPNR-0003;7C\n");
  });

  it("counts how personnummer were written and whether their check digit holds, and never the numbers themselves", () => {
    const text = "Namn;Info\nA;1212121212\nB;19121212-1212\nC;121212-1213\n";
    const result = run([input(text)], { files: [{ treatments: { 0: KEEP, 1: KEEP } }] });
    expect(result.report.checkDigit.pnr).toEqual({ holds: 2, fails: 1 });
    expect(result.report.spellings).toEqual([
      { spelling: "ÅÅÅÅMMDD-NNNN", count: 1 },
      { spelling: "ÅÅMMDD-NNNN", count: 1 },
      { spelling: "ÅÅMMDDNNNN", count: 1 },
    ]);
    expect(JSON.stringify(result.report)).not.toMatch(/\d{6}/);
  });

  it("counts the personnummer of a column of them too, so that the spellings of the commonest case are not lost", () => {
    const result = run([input("Personnummer;Klass\n800101-1234;7A\n19800202-1235;7B\n")], { files: [{}] });
    expect(result.report.spellings.map((s) => s.spelling).sort()).toEqual(["ÅÅMMDD-NNNN", "ÅÅÅÅMMDD-NNNN"]);
  });
});

describe("pseudonymise: text that is not a table, and the user's own words", () => {
  const LETTER = "Kära Anna, kära Bo, hej\nRing 070-123 45 67 eller mejla a@b.se\nHälsningar Gunnar, och Cia\nNu slutar jag här\n";

  it("is read line by line: what looks personal, and the words the user typed, are replaced, and the page is told the columns could not be judged", () => {
    const result = run([input(LETTER)], { words: ["Anna", "Gunnar"], files: [{}] });
    expect(result.files[0]!.text).toBe("Kära NAMN-0001, kära Bo, hej\nRing TEL-0001 eller mejla epost-0001@exempel.invalid\nHälsningar NAMN-0002, och Cia\nNu slutar jag här\n");
    expect(result.report.notes).toContainEqual({ code: "lines", file: 0 });
    expect(result.report.files[0]!.shape).toBe("lines");
  });

  it("looks for the user's words in every cell of a table, one word cells included, and not for a word that is only part of another", () => {
    const text = "Klass;Ämne\n7A;Gunnar\n7B;Gunnarsson\n";
    const result = run([input(text)], { words: ["Gunnar"], files: [{ treatments: { 0: KEEP, 1: KEEP } }] });
    expect(result.files[0]!.text).toBe("Klass;Ämne\n7A;NAMN-0001\n7B;Gunnarsson\n");
  });
});

describe("pseudonymise: a safe file put through again", () => {
  it("is left as it is: a cell that is a marker already keeps its marker, and no number is given twice", () => {
    const first = run([input(SCHOOL)], { files: [{ treatments: { 5: KEEP } }] });
    const again = run([input(first.files[0]!.text)], { files: [{ treatments: { 5: KEEP } }] });
    expect(again.files[0]!.text).toBe(first.files[0]!.text);
    expect(again.check.passed).toBe(true);
  });
});

describe("pseudonymise: more than one file in a run", () => {
  it("gives the same value the same marker in every file, so that a teacher is one marker in the lessons and in the postings", () => {
    const lessons = input("Lärare;Klass\nAnna Svensson;7A\nBo Ek;7B\n");
    const postings = input("Namn;E-post\nBo Ek;bo@skola.se\nAnna Svensson;anna@skola.se\n");
    const result = run([lessons, postings], { files: [{}, {}] });
    expect(result.files[0]!.text).toBe("Lärare;Klass\nNAMN-0001;7A\nNAMN-0002;7B\n");
    expect(result.files[1]!.text).toBe("Namn;E-post\nNAMN-0002;epost-0001@exempel.invalid\nNAMN-0001;epost-0002@exempel.invalid\n");
    expect(result.report.totals.namn).toEqual({ occurrences: 4, distinct: 2 });
  });

  it("looks in one file for the names of another: a name column in the first is known in the comments of the second", () => {
    const first = input("Lärare;Klass\nAnna Svensson;7A\n");
    const second = input("Klass;Notis\n7A;Anna sjuk idag\n7B;hej\n");
    const result = run([first, second], { files: [{}, { treatments: { 1: KEEP } }] });
    expect(result.files[1]!.text).toBe("Klass;Notis\n7A;NAMN-0002 sjuk idag\n7B;hej\n");
  });

  it("names the undecided columns of each file", () => {
    const a = input("Lärare;Zz\nAnna;x\n");
    const b = input("Klass;Qq\n7A;y\n");
    expect(pseudonymise([a, b], { files: [{}, {}] })).toEqual({
      ok: false,
      undecided: [
        { file: 0, columns: [1] },
        { file: 1, columns: [1] },
      ],
    });
  });
});

describe("pseudonymise: the form of the file is kept", () => {
  it("writes a Windows-1252 file back as Windows-1252, with its line ending and no final line break if it had none", async () => {
    // "Lärare;Klass\nÅke Öst;7A" in Windows-1252: ä E4, Å C5, Ö D6.
    const bytes = new Uint8Array([...new TextEncoder().encode("L"), 0xe4, ...new TextEncoder().encode("rare;Klass\n"), 0xc5, ...new TextEncoder().encode("ke "), 0xd6, ...new TextEncoder().encode("st;7A")]);
    const parsed = await parseSource({ file: new File([bytes], "x.csv") });
    if (!parsed.ok) throw new Error("not read");
    const result = run(parsed.inputs, { files: [{}] });
    expect(result.files[0]!.encoding).toBe("Windows-1252");
    expect(new TextDecoder("windows-1252").decode(result.files[0]!.bytes)).toBe("Lärare;Klass\nNAMN-0001;7A");
    // The header's ä is still one byte, E4.
    expect(result.files[0]!.bytes[1]).toBe(0xe4);
  });

  it("writes a UTF-8 file with a byte order mark back with one, and keeps a tab and a comma as the delimiter", async () => {
    const parsed = await parseSource({ file: new File([new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("Lärare,Klass\nAnna,7A\n")])], "x.csv") });
    if (!parsed.ok) throw new Error("not read");
    const result = run(parsed.inputs, { files: [{}] });
    expect(Array.from(result.files[0]!.bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(result.files[0]!.text).toBe("Lärare,Klass\nNAMN-0001,7A\n");
    expect(run([input("Lärare\tKlass\nAnna\t7A\n")], { files: [{}] }).files[0]!.text).toBe("Lärare\tKlass\nNAMN-0001\t7A\n");
  });

  it("writes a workbook's sheet as UTF-8 with a byte order mark, semicolons and CRLF, and says the sheet's name as it stands in the copy", async () => {
    const { makeXlsx } = await import("@/lib/__fixtures__/xlsx-builder");
    const book = await makeXlsx({ sheets: [{ name: "800101-1234", rows: [["Lärare", "Klass"], ["Anna", "7A"]] }], author: "Fiktiv Författare" });
    const parsed = await parseSource({ file: new File([book as unknown as BlobPart], "x.xlsx") });
    if (!parsed.ok) throw new Error("not read");
    const result = run(parsed.inputs, { files: [{}] });
    expect(result.files[0]!.text).toBe("Lärare;Klass\r\nNAMN-0001;7A\r\n");
    expect(result.report.files[0]!.sheet).toBe("PNR-0001");
    expect(Array.from(result.files[0]!.bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(result.files[0]!.bytes)).not.toContain("Fiktiv");
  });

  it("keeps the number of every row: an empty row of the original is an empty line of the copy", () => {
    const result = run([input("Lärare;Klass\n\n\nAnna;7A\n")], { files: [{}] });
    expect(result.files[0]!.text).toBe("Lärare;Klass\n\n\nNAMN-0001;7A\n");
    expect(result.files[0]!.preview.map((row) => row.number)).toEqual([1, 4]);
  });

  it("puts the formula guard on a cell a spreadsheet would run, and counts it", () => {
    const result = run([input("Klass;Notis\n7A;=1+1\n")], { files: [{ treatments: { 1: KEEP } }] });
    expect(result.files[0]!.text).toBe("Klass;Notis\n7A;'=1+1\n");
    expect(result.report.files[0]!.guarded).toBe(1);
  });
});

describe("pseudonymise: notes of what could not be judged", () => {
  it("says when a kept column holds running text, and when a kept column had many cells replaced", () => {
    const rows = ["Klass;Notis;Id"];
    for (let i = 0; i < 10; i += 1) rows.push(`7A;Detta är en lång anteckning om något;070-123 45 6${i % 10}`);
    const result = run([input(rows.join("\n"))], { files: [{ treatments: { 1: KEEP, 2: KEEP } }] });
    expect(result.report.notes).toContainEqual({ code: "freeText", file: 0, column: 1 });
    expect(result.report.notes).toContainEqual({ code: "manyReplaced", file: 0, column: 2 });
  });

  it("says when a quote was never closed, and when the encoding could not hold a word of the user's", () => {
    const open = parseText('A;B\n1;2\n3;"x;y\n', "file", "UTF-8", false)!;
    expect(run([open], { files: [{ treatments: { 0: KEEP, 1: KEEP } }] }).report.notes).toContainEqual({ code: "unterminated", file: 0 });
    const latin = parseText("Klass;Notis\n7A;日本 sjuk\n", "file", "Windows-1252", false)!;
    const result = run([latin], { words: [], files: [{ treatments: { 0: KEEP, 1: KEEP } }] });
    expect(result.report.notes).toContainEqual({ code: "encodingFellBack", file: 0 });
    expect(result.files[0]!.encoding).toBe("UTF-8");
  });
});

describe("the check on the finished cells", () => {
  const names = new KnownNames();
  names.addCell("Anna Svensson", "namn");
  names.addLine("Gunnar");

  it("finds what was left: a personnummer, an address, a telephone number, a known name in running text", () => {
    expect(leftIn("800101-1234", names)).toBe(1);
    expect(leftIn("a@b.se", names)).toBe(1);
    expect(leftIn("070-123 45 67", names)).toBe(1);
    expect(leftIn("hej Anna sjuk", names)).toBe(1);
    expect(leftIn("Gunnar", names)).toBe(1);
  });

  it("does not take the markers for what they are made of: Text and Sign are words and Annas a name, but a marker is a marker", () => {
    const withWords = new KnownNames();
    withWords.addLine("Text");
    withWords.addLine("Sign");
    expect(leftIn("TEXT-0001 och SIGN-0002 och NAMN-0003 och epost-0004@exempel.invalid", withWords)).toBe(0);
    expect(leftIn("Klass 7A, sal 12, 08:10", names)).toBe(0);
    expect(leftIn("Svensson", names)).toBe(0);
  });
});

describe("pseudonymise: a school's size", () => {
  it("runs 20 000 rows of 8 columns, with a person in every row, in a few seconds, and passes its check", { timeout: 60_000 }, () => {
    const rows = ["Lärare;Ämne;Klass;Dag;Start;Slut;Personnummer;Notis"];
    for (let i = 0; i < 20_000; i += 1) {
      const day = String((i % 28) + 1).padStart(2, "0");
      rows.push(`Lärare ${i % 300};Svenska;7${"ABC"[i % 3]};Mån;08:10;09:00;19${70 + (i % 30)}01${day}-${String(1000 + (i % 9000))};Se Lärare ${i % 300} eller a${i % 50}@skola.se`);
    }
    const started = Date.now();
    const result = run([input(rows.join("\n"))], { files: [{ treatments: { 7: KEEP } }] });
    const took = Date.now() - started;
    expect(result.check.passed).toBe(true);
    expect(result.report.totals.pnr.occurrences).toBe(20_000);
    expect(took).toBeLessThan(30_000);
  });
});
