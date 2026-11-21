/**
 * A pasted table or a CSV file as rows and cells, and a mapped table written back as CSV (Kolumnmappning, X2).
 *
 * The read side is a port of src/schedule-exchange/csv.ts (the gateway's reader of the flat table), and for the reason the
 * mapping is made in the browser at all: what this module writes is read by that reader, so both must cut a file into
 * records and fields the same way, and the row numbers a message names must be the rows the user sees. lib/csv.ts's own
 * parser assumes the header is the first line and cuts every row to its length, so it cannot hold a title above the
 * header or a column the header row does not name; this one keeps every record whole.
 *
 *   - Three delimiters, ';' , ',' and tab: a table copied out of a page or a spreadsheet is tab-separated. The delimiter is
 *     chosen over the first ten non-empty records, so a title line with a comma in it does not tip it.
 *   - Rows keep their number. Empty records are dropped from `rows`, but `rowNumbers` counts them: the number Excel shows.
 *   - An unterminated quote is reported, not swallowed.
 *   - A cell the formula guard was put on (a spreadsheet would run it) has its one apostrophe taken off, as the gateway's
 *     reader does, and the writer puts it back, so guard and unguard are inverses for every value.
 *
 * Written text is UTF-8, ';'-separated, CRLF and without a byte order mark: it is handed to the gateway's own reader as it
 * is, which takes any of them.
 */

export type TableDelimiter = ";" | "," | "\t";

export interface RawTable {
  /** Non-empty records, cells exactly as written (the formula guard taken off), not trimmed. */
  rows: string[][];
  /** For each row, the 1-based number of the record it came from, empty records counted. */
  rowNumbers: number[];
  delimiter: TableDelimiter;
  /** True when a quoted field never closed: the last field then ends at the end of input. */
  unterminated: boolean;
}

const DELIMITERS: readonly TableDelimiter[] = [";", ",", "\t"];

/** How many non-empty records the delimiter is chosen from. */
const SNIFF_RECORDS = 10;

// ---------------------------------------------------------------------------
// The formula guard (src/schedule-exchange/csv.ts guardFormula / unguardFormula)
// ---------------------------------------------------------------------------

const GUARD_SHAPE = /^('*)\s*[=+\-@\t\r]/;
const GUARDED_SHAPE = /^'+\s*[=+\-@\t\r]/;

function isPlainNumber(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed !== "" && Number.isFinite(Number(trimmed))) return true;
  return /^-?\d+(,\d+)?$/.test(value);
}

/** One apostrophe in front of a cell a spreadsheet would run, a plain number excepted; a cell that already looks guarded gets one too. */
export function guardFormula(value: string): string {
  const shape = GUARD_SHAPE.exec(value);
  if (shape === null) return value;
  if (shape[1] === "" && isPlainNumber(value)) return value;
  return `'${value}`;
}

/** The inverse of guardFormula; a cell that was never guarded comes back unchanged. */
export function unguardFormula(value: string): string {
  return GUARDED_SHAPE.test(value) ? value.slice(1) : value;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

interface Tokens {
  rows: string[][];
  rowNumbers: number[];
  unterminated: boolean;
}

/**
 * Splits `input` into records and fields for ONE delimiter, stopping after `maxRows` non-empty records. RFC 4180 with
 * leniency: a quote opens a quoted field only at the START of a field, a doubled quote inside one is a literal quote, and
 * characters after the closing quote are kept. A record ends at LF, CRLF or a lone CR outside quotes.
 */
function tokenise(input: string, delimiter: TableDelimiter, maxRows: number): Tokens {
  const rows: string[][] = [];
  const rowNumbers: number[] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  let atFieldStart = true;
  let endedRecords = 0;

  const endField = (): void => {
    record.push(unguardFormula(field));
    field = "";
    atFieldStart = true;
  };
  const endRecord = (): void => {
    endField();
    endedRecords += 1;
    // A record of nothing but empty cells is a blank line, not data. It still counts as a record: Excel numbers its rows from the top.
    if (record.some((cell) => cell.trim() !== "")) {
      rows.push(record);
      rowNumbers.push(endedRecords);
    }
    record = [];
  };

  let full = false;
  for (let i = 0; i < input.length && !full; i += 1) {
    const char = input[i]!;
    if (inQuotes) {
      if (char !== '"') {
        field += char;
      } else if (input[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        inQuotes = false;
      }
    } else if (char === '"' && atFieldStart) {
      inQuotes = true;
      atFieldStart = false;
    } else if (char === delimiter) {
      endField();
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[i + 1] === "\n") i += 1;
      endRecord();
      full = rows.length >= maxRows;
    } else {
      field += char;
      atFieldStart = false;
    }
  }
  const unterminated = inQuotes;
  if (!full && (field !== "" || record.length > 0 || inQuotes)) endRecord();
  return { rows, rowNumbers, unterminated };
}

/** The delimiter whose count, over the first records, is highest; ties go ';' then ',' then tab. */
function detectDelimiter(input: string): TableDelimiter {
  let best: TableDelimiter = ";";
  let bestScore = -1;
  for (const candidate of DELIMITERS) {
    const { rows } = tokenise(input, candidate, SNIFF_RECORDS);
    const score = rows.reduce((sum, row) => sum + row.length - 1, 0);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/** Parses text into a table. Never throws: whatever the text, a result comes back. A leading BOM is removed. */
export function readTable(text: string): RawTable {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const delimiter = detectDelimiter(input);
  const { rows, rowNumbers, unterminated } = tokenise(input, delimiter, Infinity);
  return { rows, rowNumbers, delimiter, unterminated };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** A field is quoted when it holds a quote, a line break or ANY delimiter the reader can detect, not only the one in use. */
function quoteField(value: string): string {
  if (!/[";,\t\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

const line = (cells: readonly string[]): string => cells.map((cell) => quoteField(guardFormula(cell))).join(";");

/**
 * The mapped table as text: the header on the row it stood on, each data row on the row it came from, and an empty line for
 * every number between them. The reader at the other end drops empty records but counts them, so "rad 12" in one of its
 * messages is row 12 of the text the user pasted. A row number that is not in `rowNumbers` is written empty.
 */
export function writeMappedTable(headerRowNumber: number, headers: readonly string[], rows: readonly (readonly string[])[], rowNumbers: readonly number[]): string {
  const byNumber = new Map<number, readonly string[]>();
  rows.forEach((cells, index) => byNumber.set(rowNumbers[index]!, cells));
  // A loop, not Math.max(...rowNumbers): a spread of a few hundred thousand numbers is a RangeError, and a paste may be 5 MB of short rows.
  let last = headerRowNumber;
  for (const number of rowNumbers) if (number > last) last = number;
  const lines: string[] = [];
  // A file with no header row (headerRowNumber 0: lib/skola24-format.ts blockWithoutHeader) has its header written FIRST, on a record of
  // its own, and every row one record later: there is no record number before the first row to put the header on. The reader at the other
  // end then numbers a row one higher than the user's file does. Only the flat timetable is read there, and no file of it lacks a header.
  if (headerRowNumber === 0) lines.push(line(headers));
  for (let n = 1; n <= last; n += 1) {
    lines.push(n === headerRowNumber ? line(headers) : byNumber.has(n) ? line(byNumber.get(n)!) : "");
  }
  return lines.map((text) => `${text}\r\n`).join("");
}
