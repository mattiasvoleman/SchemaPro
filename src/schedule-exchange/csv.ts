/**
 * CSV reader and writer for the flat timetable (Schemat som tabell och i öppna
 * format, round 9 / S0). The same dialect the web app already speaks, so that a
 * school sees one CSV everywhere:
 *
 *   web/lib/csv.ts (reader) and web/lib/csv-export.ts (writer) are the model.
 *   Swedish Excel writes ';'-separated "CSV" (the comma is its decimal
 *   separator), needs a UTF-8 BOM to read å/ä/ö back, and ends lines with CRLF;
 *   so the writer produces exactly that, and the reader auto-detects the
 *   delimiter instead of trusting the file extension.
 *
 * WHERE THIS DIFFERS FROM THE WEB, AND WHY (each a decision, not an accident):
 *
 *   1. Three delimiters, not two. A table pasted out of a text editor or
 *      Google Sheets is tab-separated. The web importers never see those; the
 *      timetable table does, because a school moves a timetable between
 *      programs far more often than a roster.
 *
 *   2. The delimiter is chosen over the first TEN records, not the header line
 *      alone. Excel users put a title above the table ("Schema hösten 2026,
 *      Lillskolan"), and a comma in such a line would otherwise outvote a
 *      header that has a single ';' in it. Counting delimiters over a handful
 *      of records, with the same quote rules as the parser itself, cannot be
 *      tipped by one line and costs four tokenisations of ten records. A tie
 *      goes to ';' (the Swedish default, and what the web does), then ',', then
 *      tab; no delimiter at all (a one-column file) is ';'.
 *
 *   3. Rows keep their number. The reader drops fully empty rows (as the web
 *      does) but returns, beside `rows`, the 1-based number of the record each
 *      row came from, COUNTING the empty ones. That is the row number Excel
 *      shows when the same file is opened, and the lesson table's "rad N" in a
 *      refusal has to be the line the school's user sees. Without it every
 *      blank line in a file would move all later rad-numbers up by one.
 *
 *   4. An unterminated quote is reported (`unterminated`), not swallowed. The
 *      field ends at the end of input, as in the web parser, but the caller can
 *      tell the school that the file probably lost a quote somewhere instead of
 *      importing a last lesson with a three-line "subject".
 *
 *   5. The formula guard round-trips for EVERY value (see guardFormula): the
 *      web guard loses an apostrophe that belongs to the value ("'=x" comes
 *      back as "=x"); this one doubles it.
 *
 *   6. The writer quotes a cell that holds ANY of the three delimiters, not
 *      only the one in use (see quoteField): the reader guesses its delimiter,
 *      and the guess must not be tipped by a comma in a name.
 *
 * FORMULA INJECTION. A cell that starts with = + - @ (or a tab or CR, possibly
 * after whitespace) is a formula when a spreadsheet opens the CSV, and quoting
 * does not help: Excel evaluates a quoted field too. A teacher called
 * `=HYPERLINK("http://…"&A1)` is stored as faithfully as `Andersson`, does
 * nothing inside Rastra, and runs when an administrator opens the export. The
 * writer therefore prefixes such a cell with an apostrophe, which a spreadsheet
 * reads as "this is text" and does not display. The reader takes it off again.
 * Plain numbers ("-5", "-12,5") are left alone, exactly as the web does, so a
 * figure that sums stays a figure; a time "08:10" or a date never starts with
 * any of the characters and is never touched.
 *
 * Excel files (xlsx.ts) need no guard: every cell is written as a text cell,
 * which is never evaluated.
 */

export const CSV_BOM = '﻿';

export type CsvDelimiter = ',' | ';' | '\t';

export interface ParsedCsv {
  /** Non-empty records, cells exactly as written (the formula guard taken off), not trimmed. */
  rows: string[][];
  delimiter: CsvDelimiter;
  /** True when a quoted field never closed: the last field then ends at the end of input. */
  unterminated: boolean;
  /** For each row, the 1-based number of the record it came from, empty records counted (what Excel shows). */
  rowNumbers: number[];
}

/** In the order a tie between two delimiters is settled. */
const DELIMITERS: readonly CsvDelimiter[] = [';', ',', '\t'];

/** How many non-empty records the delimiter is chosen from. */
const SNIFF_RECORDS = 10;

// ---------------------------------------------------------------------------
// The formula guard
// ---------------------------------------------------------------------------

/**
 * The shape of a cell a spreadsheet would run: any number of apostrophes
 * (zero for a cell that has not been guarded yet), then whitespace, then one of
 * = + - @ or a tab or CR. The leading apostrophes are what makes the guard
 * reversible: see guardFormula.
 */
const GUARD_SHAPE = /^('*)\s*[=+\-@\t\r]/;

/** A cell the reader should take one apostrophe off: the same shape, with at least one apostrophe. */
const GUARDED_SHAPE = /^'+\s*[=+\-@\t\r]/;

/**
 * Plain numbers are exempt, exactly as in web/lib/csv-export.ts: a legitimate
 * -5 stays a number that sums instead of becoming text, and so does a Swedish
 * decimal ("-12,5"), which Number() refuses but Swedish Excel reads as a number
 * and which is never a formula (a run of digits with one comma).
 */
function isPlainNumber(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed !== '' && Number.isFinite(Number(trimmed))) return true;
  return /^-?\d+(,\d+)?$/.test(value);
}

/**
 * Makes a cell safe to put in a CSV that a spreadsheet will open, in a way
 * unguardFormula reverses for EVERY value.
 *
 * The rule: a cell with the dangerous shape gets one apostrophe in front,
 * unless it is a plain number. The dangerous shape deliberately includes cells
 * that ALREADY begin with apostrophes ("'=x"): such a cell is not dangerous in
 * itself, but it looks exactly like a guarded one, and without a second
 * apostrophe the reader would take away the one that belongs to the value.
 * (The web's guard has this hole: a name typed as '=x comes back as =x.) The
 * reader removes exactly one apostrophe from a cell that has at least one
 * followed by the dangerous start, so guard and unguard are inverses:
 *
 *   value        written      read back
 *   =1+1         '=1+1        =1+1
 *   '=1+1        ''=1+1       '=1+1
 *   -5           -5           -5          (a number, left alone)
 *   '-5          ''-5         '-5         (not a number: it has an apostrophe)
 *   08:10        08:10        08:10       (never starts with a trigger)
 *   'Anna'       'Anna'       'Anna'      (no trigger after the apostrophe)
 */
export function guardFormula(value: string): string {
  const shape = GUARD_SHAPE.exec(value);
  if (shape === null) return value;
  if (shape[1] === '' && isPlainNumber(value)) return value;
  return `'${value}`;
}

/** The inverse of guardFormula; a cell that was never guarded comes back unchanged. */
export function unguardFormula(value: string): string {
  return GUARDED_SHAPE.test(value) ? value.slice(1) : value;
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

interface Tokens {
  rows: string[][];
  rowNumbers: number[];
  unterminated: boolean;
}

/**
 * Splits `input` into records and fields for ONE delimiter. Stops after
 * `maxRows` non-empty records (the delimiter sniffing needs only the first few).
 *
 * The quote rules are RFC 4180 with the web parser's leniency: a quote opens a
 * quoted field only at the START of a field, a doubled quote inside one is a
 * literal quote, and characters after the closing quote are kept as they are
 * (`"ab"c` reads as `abc`). A record ends at LF, CRLF or a lone CR outside
 * quotes; a missing final line break is fine.
 */
function tokenise(input: string, delimiter: CsvDelimiter, maxRows: number): Tokens {
  const rows: string[][] = [];
  const rowNumbers: number[] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;
  let atFieldStart = true;
  let endedRecords = 0;

  const endField = (): void => {
    record.push(unguardFormula(field));
    field = '';
    atFieldStart = true;
  };
  const endRecord = (): void => {
    endField();
    endedRecords += 1;
    // A record of nothing but empty cells is a blank line, not data. It still
    // counts as a record: Excel numbers its rows from the top of the file.
    if (record.some((cell) => cell.trim() !== '')) {
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
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i += 1;
      endRecord();
      full = rows.length >= maxRows;
    } else {
      field += char;
      atFieldStart = false;
    }
  }
  const unterminated = inQuotes;
  // The last record, when the file does not end in a line break.
  if (!full && (field !== '' || record.length > 0 || inQuotes)) endRecord();
  return { rows, rowNumbers, unterminated };
}

/** The delimiter whose count, over the first records, is highest; ties go ';' then ',' then tab. */
function detectDelimiter(input: string): CsvDelimiter {
  let best: CsvDelimiter = ';';
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

/**
 * Parses CSV text. Never throws: whatever the text, a result comes back, and a
 * quote that never closes is reported in `unterminated`.
 *
 * A leading BOM is removed. Cells are returned as written (not trimmed), with
 * the formula guard taken off; what a cell MEANS is the caller's business.
 */
export function parseCsv(text: string): ParsedCsv {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const delimiter = detectDelimiter(input);
  const { rows, rowNumbers, unterminated } = tokenise(input, delimiter, Infinity);
  return { rows, delimiter, unterminated, rowNumbers };
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/**
 * A field is quoted when it holds a quote, a line break or ANY of the three
 * delimiters the reader can detect - not only the one in use. Quoting only the
 * delimiter in use is what the web does and is enough for a reader told which
 * delimiter it is; ours guesses, by counting delimiters outside quotes, and an
 * unquoted comma in a ';' file (or a ';' or a tab in a ',' file) would add to
 * the count of another candidate. In a two-column file with one name like
 * "Berg, Anna" that could tip the guess and split the name. Quoting every cell
 * that contains a candidate keeps the unquoted counts exactly the structural
 * ones, so what writeCsv writes parseCsv always reads back as written.
 */
function quoteField(value: string): string {
  if (!/[";,\t\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

export interface WriteCsvOptions {
  /** ';' (the default: what Swedish Excel opens correctly) or ','. */
  delimiter?: ';' | ',';
}

/**
 * Serialises rows as CSV: UTF-8 BOM, CRLF after every line (the last too, as
 * the web does), the delimiter ';' unless told otherwise, quoting only where
 * needed, and the formula guard on every cell. Rows are written as given; a
 * short row is not padded.
 */
export function writeCsv(rows: string[][], options: WriteCsvOptions = {}): string {
  const delimiter = options.delimiter ?? ';';
  const lines = rows.map((row) => row.map((cell) => quoteField(guardFormula(cell))).join(delimiter));
  return CSV_BOM + lines.map((line) => `${line}\r\n`).join('');
}
