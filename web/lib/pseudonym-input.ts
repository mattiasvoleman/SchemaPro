/**
 * What a file, a paste or a workbook is, as the pseudonymiser reads it (Pseudonymiseraren, X1): the text decoded in the code page
 * it was saved in, cut into a table when it is one, and the facts about its form that the safe copy keeps.
 *
 * Reads with what the page already has: `readSource` (lib/column-source.ts: UTF-8, Windows-1252 and Mac Roman, the 5 MB cap) and
 * `readTable` (lib/column-table.ts: the delimiter of ; , or tab, quotes, and the number of every row). A workbook is read by
 * pseudonym-xlsx.ts, its sheets becoming tables of values.
 *
 * TABLE OR LINES. A text is a table when most of its rows have the same number of cells. A text that is not (a fixed-width file,
 * a letter) has no columns to judge, and is read line by line: only what looks personal, and the user's own words, are replaced in it,
 * and the page says that the columns could not be judged. A file of one column (a list of names, one to a line) IS a table.
 *
 * WHAT IS NOT READ. A file that is not text is refused with what it is: an Access database (the .mdb of Export till Extens),
 * a PDF, a picture, a zip that is no workbook. It cannot be made safe here, and saying so is better than reading its bytes as text.
 */

import { MAX_TABLE_TEXT, readSource } from "@/lib/column-source";
import { readTable, type TableDelimiter } from "@/lib/column-table";
import { encodingFromName, endsWithLineBreak, lineEndingOf, type LineEnding, type OutputEncoding } from "@/lib/pseudonym-write";
import { readWorkbook, XlsxRefusal, type XlsxProblem } from "@/lib/pseudonym-xlsx";

export interface InputFacts {
  origin: "paste" | "file" | "xlsx";
  encoding: OutputEncoding;
  bom: boolean;
  eol: LineEnding;
  finalEol: boolean;
  /** The delimiter of a table; null for lines. */
  delimiter: TableDelimiter | null;
  /** The sheet's name for a workbook. */
  sheet: string | null;
  /** A quoted field that never closed. */
  unterminated: boolean;
}

export type Body = { shape: "table"; rows: string[][]; rowNumbers: number[] } | { shape: "lines"; lines: string[] };

export interface ParsedInput {
  facts: InputFacts;
  body: Body;
}

export type Unsupported = "access" | "pdf" | "image" | "zip" | "binary";

export type ParseFailure =
  | { ok: false; reason: "tooLong" }
  | { ok: false; reason: "empty" }
  /** UTF-16 ("Unicode-text") or Excel's CSV (MS-DOS): the encodings the page refuses rather than read wrongly. */
  | { ok: false; reason: "utf16" | "msdos" }
  | { ok: false; reason: "unsupported"; kind: Unsupported }
  | { ok: false; reason: "workbook"; problem: XlsxProblem };

export type ParseResult = { ok: true; inputs: ParsedInput[]; hiddenSheets: number } | ParseFailure;

/** The share of rows that must have the commonest width for a text to be a table. */
const TABLE_SHARE = 0.6;

/** A table, or lines, from decoded text; null for a text with nothing in it. */
export function bodyOf(text: string): { body: Body; delimiter: TableDelimiter | null; unterminated: boolean } | null {
  const table = readTable(text);
  if (table.rows.length === 0) return null;
  const counts = new Map<number, number>();
  for (const row of table.rows) counts.set(row.length, (counts.get(row.length) ?? 0) + 1);
  let commonest = 0;
  for (const count of counts.values()) if (count > commonest) commonest = count;
  if (commonest / table.rows.length >= TABLE_SHARE) {
    return { body: { shape: "table", rows: table.rows, rowNumbers: table.rowNumbers }, delimiter: table.delimiter, unterminated: table.unterminated };
  }
  return { body: { shape: "lines", lines: text.split(/\r\n|\n|\r/) }, delimiter: null, unterminated: false };
}

/** A decoded text as an input, with the form of the file it came from. Null for an empty text. */
export function parseText(text: string, origin: "paste" | "file", encoding: OutputEncoding, bom: boolean): ParsedInput | null {
  const read = bodyOf(text);
  if (read === null) return null;
  return {
    facts: { origin, encoding, bom, eol: lineEndingOf(text), finalEol: endsWithLineBreak(text), delimiter: read.delimiter, sheet: null, unterminated: read.unterminated },
    body: read.body,
  };
}

const startsWith = (bytes: Uint8Array, magic: readonly number[], at = 0): boolean => magic.every((byte, i) => bytes[at + i] === byte);

/** What a file's first bytes say it is, when that is not text. */
function sniff(head: Uint8Array): "xlsx" | "ole2" | Unsupported | null {
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) return "xlsx";
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0])) return "ole2";
  if (startsWith(head, [0x00, 0x01, 0x00, 0x00, 0x53, 0x74, 0x61, 0x6e, 0x64, 0x61, 0x72, 0x64])) return "access";
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46])) return "pdf";
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47]) || startsWith(head, [0xff, 0xd8, 0xff]) || startsWith(head, [0x47, 0x49, 0x46, 0x38])) return "image";
  return null;
}

export type InputSource = { text: string } | { file: File };

export async function parseSource(source: InputSource): Promise<ParseResult> {
  if ("text" in source) {
    const read = await readSource(source);
    if (!read.ok) return { ok: false, reason: "tooLong" };
    const input = parseText(read.text, "paste", "UTF-8", false);
    return input === null ? { ok: false, reason: "empty" } : { ok: true, inputs: [input], hiddenSheets: 0 };
  }

  const head = new Uint8Array(await source.file.slice(0, 16).arrayBuffer());
  const kind = sniff(head);
  if (kind === "xlsx" || kind === "ole2") return parseWorkbook(new Uint8Array(await source.file.arrayBuffer()));
  if (kind !== null) return { ok: false, reason: "unsupported", kind };

  const read = await readSource(source);
  if (!read.ok) {
    if (read.reason === "tooLong") return { ok: false, reason: "tooLong" };
    return { ok: false, reason: read.problem.includes("UTF-16") ? "utf16" : "msdos" };
  }
  // Text that is not text: a binary file read as a code page is mostly control characters.
  const sample = read.text.slice(0, 4096);
  const controls = (sample.match(/[\u0000-\u0008\u000e-\u001f]/g) ?? []).length;
  if (controls * 20 > sample.length) return { ok: false, reason: "unsupported", kind: "binary" };

  const bom = head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf;
  const input = parseText(read.text, "file", encodingFromName(read.encoding), bom);
  return input === null ? { ok: false, reason: "empty" } : { ok: true, inputs: [input], hiddenSheets: 0 };
}

async function parseWorkbook(bytes: Uint8Array): Promise<ParseResult> {
  let book;
  try {
    book = await readWorkbook(bytes);
  } catch (error) {
    if (error instanceof XlsxRefusal) {
      // A zip that is no workbook (or a workbook with no sheet at all) is said as what it is; the rest are the workbook's own refusals.
      return error.problem === "notWorkbook" ? { ok: false, reason: "unsupported", kind: "zip" } : { ok: false, reason: "workbook", problem: error.problem };
    }
    throw error;
  }
  const inputs: ParsedInput[] = [];
  let characters = 0;
  for (const sheet of book.sheets) {
    if (sheet.rows.length === 0) continue;
    for (const row of sheet.rows) for (const cell of row) characters += cell.length;
    if (characters > MAX_TABLE_TEXT) return { ok: false, reason: "tooLong" };
    inputs.push({
      facts: { origin: "xlsx", encoding: "UTF-8", bom: true, eol: "\r\n", finalEol: true, delimiter: ";", sheet: sheet.name, unterminated: false },
      body: { shape: "table", rows: sheet.rows, rowNumbers: sheet.rowNumbers },
    });
  }
  return inputs.length === 0 ? { ok: false, reason: "empty" } : { ok: true, inputs, hiddenSheets: book.hidden };
}
