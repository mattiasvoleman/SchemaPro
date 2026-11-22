/**
 * A pseudonymised table or text as the bytes of a file, in the form the original had (Pseudonymiseraren, X1).
 *
 * THE FORM IS EVIDENCE. What a reader of Skola24's files has to learn first is how the file is made: its delimiter, its line
 * ending, whether it has a byte order mark and in which code page it was saved (Windows-1252, not UTF-8). The safe file keeps all
 * four, so that a school's file with its people taken out still shows them. Row numbers are kept too: an empty record in the
 * original is an empty line in the copy, so "rad 12" is row 12 in both. What is NOT kept: which fields were quoted (a field is quoted when it
 * has to be, as lib/column-table.ts writes), the width of a fixed-width file, and anything in a workbook but its values.
 *
 * A file that was Windows-1252 or Mac Roman is written back as that, through the inverse of what TextDecoder reads it with. A
 * character the code page cannot hold (it cannot be one from the file, which was read in it, but a marker is ASCII and a
 * name from a word list the user typed might not be) makes the whole file UTF-8 instead, and the report says so.
 */

import { guardFormula } from "@/lib/column-table";

export type OutputEncoding = "UTF-8" | "Windows-1252" | "Mac Roman";
export type LineEnding = "\r\n" | "\n" | "\r";

/** The encoding readSource names (null for UTF-8) as an output encoding. */
export function encodingFromName(name: string | null): OutputEncoding {
  return name === "Windows-1252" ? "Windows-1252" : name === "Mac Roman" ? "Mac Roman" : "UTF-8";
}

/** The line ending most of the text's lines have; a text with no line break gets CRLF (what a Windows school's file has). */
export function lineEndingOf(text: string): LineEnding {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (const match of text.matchAll(/\r\n|\n|\r/g)) {
    if (match[0] === "\r\n") crlf += 1;
    else if (match[0] === "\n") lf += 1;
    else cr += 1;
  }
  if (crlf === 0 && lf === 0 && cr === 0) return "\r\n";
  if (crlf >= lf && crlf >= cr) return "\r\n";
  return lf >= cr ? "\n" : "\r";
}

/** Whether the text ends with a line break. */
export const endsWithLineBreak = (text: string): boolean => /[\r\n]$/.test(text);

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

const TABLES = new Map<OutputEncoding, Map<string, number>>();

/** The character -> byte table of a single-byte encoding, built from what TextDecoder reads each byte as. */
function tableOf(encoding: "Windows-1252" | "Mac Roman"): Map<string, number> {
  let table = TABLES.get(encoding);
  if (table === undefined) {
    const all = new Uint8Array(256).map((_, i) => i);
    const text = new TextDecoder(encoding === "Windows-1252" ? "windows-1252" : "macintosh").decode(all);
    table = new Map();
    for (let byte = 0; byte < 256; byte += 1) table.set(text[byte]!, byte);
    TABLES.set(encoding, table);
  }
  return table;
}

export interface Encoded {
  bytes: Uint8Array;
  /** The encoding the bytes are in: UTF-8 when the wanted one could not hold every character. */
  encoding: OutputEncoding;
  /** True when the wanted encoding could not hold the text and UTF-8 was used. */
  fellBack: boolean;
}

const BOM_BYTES = [0xef, 0xbb, 0xbf];

export function encodeText(text: string, encoding: OutputEncoding, bom: boolean): Encoded {
  if (encoding !== "UTF-8") {
    const table = tableOf(encoding);
    const bytes = new Uint8Array(text.length);
    let n = 0;
    let holds = true;
    for (let i = 0; i < text.length && holds; i += 1) {
      const code = text.charCodeAt(i);
      if (code < 0x80) {
        bytes[n++] = code;
        continue;
      }
      const byte = table.get(text[i]!);
      if (byte === undefined) holds = false;
      else bytes[n++] = byte;
    }
    if (holds) return { bytes: bytes.subarray(0, n), encoding, fellBack: false };
    const utf8 = new TextEncoder().encode(text);
    return { bytes: utf8, encoding: "UTF-8", fellBack: true };
  }
  const body = new TextEncoder().encode(text);
  if (!bom) return { bytes: body, encoding, fellBack: false };
  const out = new Uint8Array(body.length + BOM_BYTES.length);
  out.set(BOM_BYTES);
  out.set(body, BOM_BYTES.length);
  return { bytes: out, encoding, fellBack: false };
}

// ---------------------------------------------------------------------------
// Writing a table
// ---------------------------------------------------------------------------

/** A field is quoted when it holds a quote, a line break or ANY delimiter the reader can detect, not only the one in use. */
function quoteField(value: string): string {
  return /[";,\t\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export interface WrittenTable {
  text: string;
  /** Cells that got the formula guard (an apostrophe in front of what a spreadsheet would run). */
  guarded: number;
}

/**
 * The rows as text, each on the line it came from and an empty line for every number between them, joined by the original's
 * delimiter and line ending. A cell a spreadsheet would run (=, +, -, @ first) gets the apostrophe of lib/column-table.ts's
 * guard, so that the file is safe to open as well as safe to read.
 */
export function writeTable(rows: readonly (readonly string[])[], rowNumbers: readonly number[], delimiter: string, eol: LineEnding, finalEol: boolean): WrittenTable {
  const byNumber = new Map<number, readonly string[]>();
  rows.forEach((cells, index) => byNumber.set(rowNumbers[index]!, cells));
  let last = 0;
  for (const number of rowNumbers) if (number > last) last = number;
  let guarded = 0;
  const lines: string[] = [];
  for (let n = 1; n <= last; n += 1) {
    const cells = byNumber.get(n);
    lines.push(
      cells === undefined
        ? ""
        : cells
            .map((cell) => {
              const safe = guardFormula(cell);
              if (safe !== cell) guarded += 1;
              return quoteField(safe);
            })
            .join(delimiter),
    );
  }
  return { text: lines.join(eol) + (finalEol && lines.length > 0 ? eol : ""), guarded };
}
