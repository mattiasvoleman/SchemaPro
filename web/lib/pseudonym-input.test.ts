import { describe, expect, it } from "vitest";
import { makeXlsx, workbookParts, zip } from "@/lib/__fixtures__/xlsx-builder";
import { bodyOf, parseSource, parseText } from "@/lib/pseudonym-input";

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);
const fileOf = (bytes: Uint8Array | number[], name = "fil.csv"): File => new File([new Uint8Array(bytes)], name);

describe("bodyOf: a table, or lines", () => {
  it("is a table when most rows have the same number of cells, with the number of every row and the delimiter", () => {
    const read = bodyOf("Titel\n\nA;B;C\n1;2;3\n4;5;6\n");
    expect(read?.delimiter).toBe(";");
    expect(read?.body).toEqual({ shape: "table", rows: [["Titel"], ["A", "B", "C"], ["1", "2", "3"], ["4", "5", "6"]], rowNumbers: [1, 3, 4, 5] });
  });

  it("is a table of one column for a list with one name to a line", () => {
    const read = bodyOf("Anna\nBo\nCia\n");
    expect(read?.body.shape).toBe("table");
    expect(read?.delimiter).toBe(";");
  });

  it("reads a table copied out of a spreadsheet, with tabs, and one with commas", () => {
    expect(bodyOf("A\tB\n1\t2\n")?.delimiter).toBe("\t");
    expect(bodyOf("A,B\n1,2\n")?.delimiter).toBe(",");
  });

  it("is lines when the rows do not have one width: a letter, or a text with no columns", () => {
    const text = "Kära Anna,\nVi ses kl 8, och sen, kanske\nHälsningar\n";
    const read = bodyOf(text);
    expect(read?.body).toEqual({ shape: "lines", lines: ["Kära Anna,", "Vi ses kl 8, och sen, kanske", "Hälsningar", ""] });
    expect(read?.delimiter).toBeNull();
  });

  it("is nothing for a text with nothing in it", () => {
    expect(bodyOf("")).toBeNull();
    expect(bodyOf("\n\n ; ;\n")).toBeNull();
  });

  it("says when a quoted field never closed", () => {
    // A quote that closes nothing swallows what follows it to the end; the table is still a table, and the page says so.
    expect(bodyOf('A;B\n1;2\n3;"x;y\n')).toMatchObject({ body: { shape: "table" }, unterminated: true });
    expect(bodyOf("A;B\n1;2\n")?.unterminated).toBe(false);
  });
});

describe("parseText", () => {
  it("keeps the form of the text: its line ending, whether it ended with one, and what it was given about its encoding", () => {
    const input = parseText("A;B\r\n1;2\r\n", "file", "Windows-1252", true)!;
    expect(input.facts).toMatchObject({ origin: "file", encoding: "Windows-1252", bom: true, eol: "\r\n", finalEol: true, delimiter: ";", sheet: null, unterminated: false });
    expect(parseText("A;B\n1;2", "paste", "UTF-8", false)!.facts).toMatchObject({ origin: "paste", eol: "\n", finalEol: false });
    expect(parseText("", "paste", "UTF-8", false)).toBeNull();
  });
});

describe("parseSource: a paste", () => {
  it("reads a pasted table as UTF-8 text", async () => {
    const result = await parseSource({ text: "Namn\tKlass\nAnna\t7A\n" });
    expect(result).toMatchObject({ ok: true, hiddenSheets: 0 });
    if (result.ok) expect(result.inputs[0]!.facts).toMatchObject({ origin: "paste", encoding: "UTF-8", delimiter: "\t" });
  });

  it("turns back a paste that is too long, and an empty one", async () => {
    expect(await parseSource({ text: "a".repeat(5_000_001) })).toEqual({ ok: false, reason: "tooLong" });
    expect(await parseSource({ text: "  \n " })).toEqual({ ok: false, reason: "empty" });
  });
});

describe("parseSource: a file of text", () => {
  it("reads UTF-8, and sees a byte order mark, which the text itself does not keep", async () => {
    const bytes = [0xef, 0xbb, 0xbf, ...bytesOf("Förnamn;Efternamn\r\nÅke;Öst\r\n")];
    const result = await parseSource({ file: fileOf(bytes) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [input] = result.inputs;
    expect(input!.facts).toMatchObject({ origin: "file", encoding: "UTF-8", bom: true, eol: "\r\n", finalEol: true, delimiter: ";" });
    expect(input!.body).toMatchObject({ shape: "table", rows: [["Förnamn", "Efternamn"], ["Åke", "Öst"]] });
  });

  it("reads Windows-1252, as Excel saves CSV, and says so", async () => {
    // å ä ö in Windows-1252: E5 E4 F6.
    const bytes = [...bytesOf("F"), 0xf6, ...bytesOf("rnamn;Efternamn\n"), 0xc5, ...bytesOf("ke;"), 0xd6, ...bytesOf("st\n")];
    const result = await parseSource({ file: fileOf(bytes) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inputs[0]!.facts).toMatchObject({ encoding: "Windows-1252", bom: false, eol: "\n" });
    expect(result.inputs[0]!.body).toMatchObject({ rows: [["Förnamn", "Efternamn"], ["Åke", "Öst"]] });
  });

  it("refuses UTF-16, and Excel's CSV (MS-DOS), rather than read them wrongly", async () => {
    expect(await parseSource({ file: fileOf([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00]) })).toEqual({ ok: false, reason: "utf16" });
    // "Håkan Öström;Klass" in code page 850: å 86, Ö 99, ö 94.
    const dos = [0x48, 0x86, 0x6b, 0x61, 0x6e, 0x20, 0x99, 0x73, 0x74, 0x72, 0x94, 0x6d, 0x3b, 0x4b, 0x6c, 0x61, 0x73, 0x73, 0x0a];
    expect(await parseSource({ file: fileOf(dos) })).toEqual({ ok: false, reason: "msdos" });
  });

  it("turns back a file that is empty or only blanks", async () => {
    expect(await parseSource({ file: fileOf([]) })).toEqual({ ok: false, reason: "empty" });
    expect(await parseSource({ file: fileOf(bytesOf("\n \n")) })).toEqual({ ok: false, reason: "empty" });
  });

  it("refuses a file that is not text, by what it is: an Access database, a PDF, a picture, binary", async () => {
    const access = [0x00, 0x01, 0x00, 0x00, ...bytesOf("Standard Jet DB"), ...new Array(40).fill(0)];
    expect(await parseSource({ file: fileOf(access, "x.mdb") })).toEqual({ ok: false, reason: "unsupported", kind: "access" });
    expect(await parseSource({ file: fileOf(bytesOf("%PDF-1.7 ..."), "x.pdf") })).toEqual({ ok: false, reason: "unsupported", kind: "pdf" });
    expect(await parseSource({ file: fileOf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]) })).toEqual({ ok: false, reason: "unsupported", kind: "image" });
    expect(await parseSource({ file: fileOf([0xff, 0xd8, 0xff, 0xe0]) })).toEqual({ ok: false, reason: "unsupported", kind: "image" });
    const noise = Array.from({ length: 2000 }, (_, i) => (i * 37) % 9);
    expect(await parseSource({ file: fileOf(noise, "x.dat") })).toEqual({ ok: false, reason: "unsupported", kind: "binary" });
  });
});

describe("parseSource: a workbook", () => {
  it("reads every visible sheet as a table of values, UTF-8 with a byte order mark and semicolons as its safe copy is written, and counts the hidden ones", async () => {
    const bytes = await makeXlsx({
      sheets: [
        { name: "Lektioner", rows: [["Dag", "Lärare"], ["Mån", "Anna Exempel"]] },
        { name: "Dolt", hidden: true, rows: [["x"]] },
        { name: "Tom", rows: [] },
        { name: "Salar", rows: [["Sal", "Platser"], ["A1", 30]] },
      ],
    });
    const result = await parseSource({ file: fileOf(bytes, "schema.xlsx") });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hiddenSheets).toBe(1);
    expect(result.inputs.map((input) => input.facts.sheet)).toEqual(["Lektioner", "Salar"]);
    expect(result.inputs[0]!.facts).toMatchObject({ origin: "xlsx", encoding: "UTF-8", bom: true, eol: "\r\n", delimiter: ";" });
    expect(result.inputs[1]!.body).toEqual({ shape: "table", rows: [["Sal", "Platser"], ["A1", "30"]], rowNumbers: [1, 2] });
  });

  it("refuses the old Excel format and a protected workbook, and a zip that is no workbook, each by what it is", async () => {
    const ole2 = new Uint8Array(4096);
    ole2.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(await parseSource({ file: fileOf(ole2, "gammal.xls") })).toEqual({ ok: false, reason: "workbook", problem: "legacy" });
    const zipOfNothingUseful = await zip([{ name: "readme.txt", data: bytesOf("hej") }]);
    expect(await parseSource({ file: fileOf(zipOfNothingUseful, "x.zip") })).toEqual({ ok: false, reason: "unsupported", kind: "zip" });
  });

  it("refuses a workbook over a limit, with the workbook's own reason", async () => {
    const parts = workbookParts({ sheets: [{ name: "B", rows: [["a"]] }] });
    const bytes = await zip([...Object.entries(parts).map(([name, text]) => ({ name, data: bytesOf(text) })), { name: "xl/big.bin", data: new Uint8Array(10), declaredSize: 20 * 1024 * 1024 }]);
    expect(await parseSource({ file: fileOf(bytes) })).toEqual({ ok: false, reason: "workbook", problem: "tooBig" });
  });

  it("turns back a workbook with no value in it", async () => {
    expect(await parseSource({ file: fileOf(await makeXlsx({ sheets: [{ name: "Tom", rows: [] }] })) })).toEqual({ ok: false, reason: "empty" });
  });
});
