import { describe, expect, it } from "vitest";
import { makeXlsx, workbookParts, zip, type BuiltSheet, type ZipPart } from "@/lib/__fixtures__/xlsx-builder";
import { excelSerialToText, isDateFormatCode, readWorkbook, XlsxRefusal, XLSX_LIMITS, type XlsxProblem } from "@/lib/pseudonym-xlsx";

const encoder = new TextEncoder();

/** What readWorkbook refuses with, or null when it reads the file. */
async function refusalOf(bytes: Uint8Array): Promise<XlsxProblem | null> {
  try {
    await readWorkbook(bytes);
    return null;
  } catch (error) {
    if (error instanceof XlsxRefusal) return error.problem;
    throw error;
  }
}

const SHEET: BuiltSheet = {
  name: "Lektioner",
  rows: [
    ["Dag", "Start", "Lärare"],
    ["Mån", "08:10", "Anna Exempel"],
    ["Tis", "09:00", "Bo Prov"],
  ],
};

describe("readWorkbook, on a workbook of strings", () => {
  it.each([
    ["shared strings", false],
    ["inline strings", true],
  ])("reads the values of a sheet as %s, row n being row n of the sheet", async (_name, inlineStrings) => {
    const book = await readWorkbook(await makeXlsx({ sheets: [SHEET], inlineStrings }));
    expect(book.hidden).toBe(0);
    expect(book.sheets).toHaveLength(1);
    expect(book.sheets[0]!.name).toBe("Lektioner");
    expect(book.sheets[0]!.rows).toEqual([
      ["Dag", "Start", "Lärare"],
      ["Mån", "08:10", "Anna Exempel"],
      ["Tis", "09:00", "Bo Prov"],
    ]);
    expect(book.sheets[0]!.rowNumbers).toEqual([1, 2, 3]);
  });

  it("keeps the number of every row, drops the empty ones from the rows and pads a short row to the width of the widest", async () => {
    const sheet: BuiltSheet = {
      name: "Blad",
      rows: [["Titel"], null, null, ["A", "B", "C"], [null, "x"]],
    };
    const [read] = (await readWorkbook(await makeXlsx({ sheets: [sheet] }))).sheets;
    expect(read!.rowNumbers).toEqual([1, 4, 5]);
    expect(read!.rows).toEqual([
      ["Titel", "", ""],
      ["A", "B", "C"],
      ["", "x", ""],
    ]);
  });

  it("reads a workbook stored without compression as it reads a deflated one", async () => {
    const stored = await readWorkbook(await makeXlsx({ sheets: [SHEET], stored: true }));
    const deflated = await readWorkbook(await makeXlsx({ sheets: [SHEET] }));
    expect(stored).toEqual(deflated);
  });

  it("reads every visible sheet in workbook order and counts, without reading, the hidden ones", async () => {
    const book = await readWorkbook(
      await makeXlsx({
        sheets: [
          { name: "Ett", rows: [["a"]] },
          { name: "Dolt", hidden: true, rows: [["hemligt namn"]] },
          { name: "Tre", rows: [["c"]] },
        ],
      }),
    );
    expect(book.sheets.map((sheet) => sheet.name)).toEqual(["Ett", "Tre"]);
    expect(book.hidden).toBe(1);
    expect(JSON.stringify(book)).not.toContain("hemligt");
  });

  it("returns a number as it is stored, and decodes the _xHHHH_ escapes of a string", async () => {
    const sheet: BuiltSheet = { name: "B", rows: [[12, 1.5, "rad_x000D_slut", "_x005F_x0041_"]] };
    const [read] = (await readWorkbook(await makeXlsx({ sheets: [sheet] }))).sheets;
    expect(read!.rows[0]).toEqual(["12", "1.5", "rad\rslut", "_x0041_"]);
  });
});

describe("readWorkbook, on dates and times", () => {
  it("returns a cell with a date format as the date, the time or both, by its value", async () => {
    const sheet: BuiltSheet = {
      name: "D",
      rows: [[{ serial: 46251 }, { serial: 0.3402777777777778 }, { serial: 46251.5 }, 46251]],
    };
    const [read] = (await readWorkbook(await makeXlsx({ sheets: [sheet] }))).sheets;
    // The fourth cell has no date format: a number stays the number it is stored as.
    expect(read!.rows[0]).toEqual(["2026-08-17", "08:10", "2026-08-17 12:00", "46251"]);
  });

  it("counts from 1904 when the workbook says so", async () => {
    const [read] = (await readWorkbook(await makeXlsx({ sheets: [{ name: "D", rows: [[{ serial: 1 }]] }], date1904: true }))).sheets;
    expect(read!.rows[0]).toEqual(["1904-01-02"]);
  });

  it("knows Excel's invented 29 February 1900 and counts on from 1899-12-30 after it", () => {
    expect(excelSerialToText("59", false)).toBe("1900-02-28");
    expect(excelSerialToText("60", false)).toBe("1900-02-29");
    expect(excelSerialToText("61", false)).toBe("1900-03-01");
  });

  it("rounds a time to the second before it is split, and does not roll 0.99999999 into the next day", () => {
    expect(excelSerialToText("0.34027777777777773", false)).toBe("08:10");
    expect(excelSerialToText("0.9999999999", false)).toBe("23:59");
  });

  it.each(["", "abc", "-1", "9999999", "NaN"])("is not a serial for %j", (raw) => {
    expect(excelSerialToText(raw, false)).toBeNull();
  });

  it.each([
    ["yyyy-mm-dd", true],
    ["hh:mm", true],
    ["[h]:mm", true],
    ["0.00", false],
    ['"d"0', false],
    ["\\d0", false],
    ["[Red]0", false],
    ['"d', false],
    ["[h", false],
  ])("number format %j is a date format: %s", (code, isDate) => {
    expect(isDateFormatCode(code)).toBe(isDate);
  });
});

describe("what a workbook holds that is never read", () => {
  it("does not open the document properties, the comments or the hidden sheets: the output holds nothing of them", async () => {
    const author = "Fiktiv Författare";
    const book = await readWorkbook(await makeXlsx({ sheets: [SHEET], author }));
    const text = JSON.stringify(book);
    expect(text).not.toContain("Fiktiv");
    expect(text).not.toContain("Författare");
    expect(text).not.toContain("AB");
  });

  it("proves it by not failing on parts that could not be read: a corrupt properties part and a comments part that is not XML are never opened", async () => {
    const parts = workbookParts({ sheets: [SHEET] });
    const bytes = await zip([
      ...Object.entries(parts).map(([name, text]) => ({ name, data: encoder.encode(text) })),
      { name: "docProps/core.xml", data: encoder.encode("<<< not xml"), method: 8 },
      { name: "xl/comments1.xml", data: encoder.encode("inte xml alls"), method: 8 },
      { name: "xl/media/image1.png", data: new Uint8Array(1000).fill(7), method: 8 },
    ]);
    expect((await readWorkbook(bytes)).sheets[0]!.rows[0]).toEqual(["Dag", "Start", "Lärare"]);
  });
});

describe("readWorkbook refuses what it cannot or will not read, with a code and never with text from the file", () => {
  const ole2 = (inside = ""): Uint8Array => {
    const bytes = new Uint8Array(4096);
    bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    // UTF-16LE, as an OLE2 directory writes a stream's name.
    Array.from(inside).forEach((char, i) => (bytes[600 + i * 2] = char.charCodeAt(0)));
    return bytes;
  };

  it("takes an OLE2 file for a legacy workbook, or an Access database, and one with an encrypted package for a protected one", async () => {
    expect(await refusalOf(ole2())).toBe("legacy");
    expect(await refusalOf(ole2("EncryptedPackage"))).toBe("encrypted");
  });

  it("refuses a file that is no zip, an empty one, and a zip that is no workbook", async () => {
    expect(await refusalOf(encoder.encode("Dag;Start\nMån;08:10\n"))).toBe("notWorkbook");
    expect(await refusalOf(new Uint8Array(0))).toBe("notWorkbook");
    expect(await refusalOf(await zip([{ name: "readme.txt", data: encoder.encode("hej") }]))).toBe("notWorkbook");
  });

  it("refuses a workbook with no sheet to read", async () => {
    expect(await refusalOf(await makeXlsx({ sheets: [] }))).toBe("notWorkbook");
  });

  it("refuses a DOCTYPE or an entity in any part it reads", async () => {
    const parts = workbookParts({ sheets: [SHEET] });
    parts["xl/worksheets/sheet1.xml"] = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><worksheet xmlns="x"><sheetData/></worksheet>`;
    const bytes = await zip(Object.entries(parts).map(([name, text]) => ({ name, data: encoder.encode(text) })));
    expect(await refusalOf(bytes)).toBe("damaged");
  });

  it("refuses XML that is not well formed, and a deflate stream that does not inflate", async () => {
    const parts = workbookParts({ sheets: [SHEET] });
    parts["xl/worksheets/sheet1.xml"] = "<worksheet><sheetData><row></worksheet>";
    expect(await refusalOf(await zip(Object.entries(parts).map(([name, text]) => ({ name, data: encoder.encode(text) }))))).toBe("damaged");

    const good = workbookParts({ sheets: [SHEET] });
    const entries: ZipPart[] = Object.entries(good).map(([name, text]) => ({ name, data: encoder.encode(text) }));
    const sheetAt = entries.findIndex((entry) => entry.name === "xl/worksheets/sheet1.xml");
    entries[sheetAt] = { ...entries[sheetAt]!, method: 8, rawBody: new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x00, 0x13]) };
    expect(await refusalOf(await zip(entries))).toBe("damaged");
  });

  it("refuses a cell that points at a shared string that is not there", async () => {
    const parts = workbookParts({ sheets: [SHEET] });
    parts["xl/worksheets/sheet1.xml"] = parts["xl/worksheets/sheet1.xml"]!.replace('<v>0</v>', "<v>99</v>");
    expect(await refusalOf(await zip(Object.entries(parts).map(([name, text]) => ({ name, data: encoder.encode(text) }))))).toBe("damaged");
  });

  it("refuses two entries of one name, which a reader and a program could disagree on", async () => {
    const parts = workbookParts({ sheets: [SHEET] });
    const entries = Object.entries(parts).map(([name, text]) => ({ name, data: encoder.encode(text) }));
    expect(await refusalOf(await zip([...entries, entries[0]!]))).toBe("damaged");
  });

  it("refuses a zip that says it is smaller than it unpacks to, and stops unpacking at what it said", async () => {
    const parts = workbookParts({ sheets: [SHEET] });
    const entries: ZipPart[] = Object.entries(parts).map(([name, text]) => ({ name, data: encoder.encode(text) }));
    const at = entries.findIndex((entry) => entry.name === "xl/worksheets/sheet1.xml");
    entries[at] = { name: "xl/worksheets/sheet1.xml", data: new Uint8Array(3 * 1024 * 1024).fill(0x20), method: 8, declaredSize: 400 };
    expect(await refusalOf(await zip(entries))).toBe("tooBig");
  });

  it("refuses a part declared larger than the limit, and a ratio over 200:1 on a part over 1 MB", async () => {
    const parts = workbookParts({ sheets: [SHEET] });
    const base = Object.entries(parts).map(([name, text]) => ({ name, data: encoder.encode(text) }));
    expect(await refusalOf(await zip([...base, { name: "xl/big.bin", data: new Uint8Array(10), declaredSize: XLSX_LIMITS.part + 1 }]))).toBe("tooBig");
    expect(await refusalOf(await zip([...base, { name: "xl/zeros.bin", data: new Uint8Array(2 * 1024 * 1024), method: 8 }]))).toBe("tooBig");
  });

  it("refuses more entries than the limit, from the directory and before anything is unpacked", async () => {
    const parts = workbookParts({ sheets: [SHEET] });
    const base = Object.entries(parts).map(([name, text]) => ({ name, data: encoder.encode(text) }));
    const many = Array.from({ length: XLSX_LIMITS.entries + 1 }, (_, i) => ({ name: `x/${i}.txt`, data: new Uint8Array(0), method: 0 as const }));
    expect(await refusalOf(await zip([...base, ...many], { stored: true }))).toBe("tooBig");
  });

  it("refuses rows, columns and cells over the limits, by what is in them", async () => {
    const lastRow = new Array<string[] | null>(XLSX_LIMITS.rows).fill(null);
    lastRow.push(["x"]);
    expect(await refusalOf(await makeXlsx({ sheets: [{ name: "R", rows: lastRow }] }))).toBe("tooBig");
    const wide = Array.from({ length: XLSX_LIMITS.columns + 1 }, (_, i) => `c${i}`);
    expect(await refusalOf(await makeXlsx({ sheets: [{ name: "K", rows: [wide] }] }))).toBe("tooBig");
    expect(await refusalOf(await makeXlsx({ sheets: [{ name: "C", rows: [["x".repeat(XLSX_LIMITS.cellChars + 1)]] }] }))).toBe("tooBig");
    // The same number of columns and the longest cell the limits allow are read.
    expect(await refusalOf(await makeXlsx({ sheets: [{ name: "K", rows: [wide.slice(0, XLSX_LIMITS.columns)] }] }))).toBeNull();
    expect(await refusalOf(await makeXlsx({ sheets: [{ name: "C", rows: [["x".repeat(XLSX_LIMITS.cellChars)]] }] }))).toBeNull();
  });

  it("a refusal is a code: it carries no text of the file", async () => {
    const parts = workbookParts({ sheets: [{ name: "19800101-1234", rows: [["a"]] }] });
    parts["xl/worksheets/sheet1.xml"] = "<worksheet>19800101-1234";
    const error = await readWorkbook(await zip(Object.entries(parts).map(([name, text]) => ({ name, data: encoder.encode(text) })))).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(XlsxRefusal);
    expect((error as Error).message).toBe("damaged");
  });
});
