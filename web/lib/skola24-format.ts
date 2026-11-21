/**
 * The tolerant reader of a described Skola24 file (Formatbeskrivare, X3): pure functions, no React, no network, no clock.
 *
 * WHAT IT DOES. Given a table (lib/column-table.ts readTable) and a description (lib/skola24-formats.ts), it says, for EVERY
 * column of the file, one of four things, and never nothing:
 *
 *   placed          the description knows the column and Rastra has a field for it: the field's id.
 *   unread          the description knows the column and Rastra reads nothing from it, and says WHY (a reason, worded by the page).
 *   personalNumber  a personnummer column: the description says so, or the column looks like one (lib/column-mapping.ts, X2's own
 *                   test). Dropped in the browser, never shown.
 *   unknown         the description does not know the column. It is named, and nobody guesses what it is.
 *
 * and, of the description's side, which documented columns the file does not have (`missing`).
 *
 * WHAT IT LEAVES TO X2. The reading ends in an `Assignment` (lib/column-mapping.ts): a field id for a placed column, null for a
 * column to read nothing from, undefined for an unknown one. X2's panel shows the columns, its `applyMapping` writes the table
 * the importers read, and the rules of Rastra (lengths, e-mail form, who may be a teacher) stay those importers'. Nothing here
 * checks a value, except the one row rule the description carries (a confidential mark).
 *
 * NOTHING IS GUESSED.
 *   - A column is placed on its HEADER, by the spellings the description lists. On POSITION only when the page states one fixed
 *     order (`order`) AND the file has no header row, which the caller says (`header: "absent"`), or which is decided from the first
 *     row when the page does not say (`"auto"`: the first row is data when a personnummer column holds a personnummer).
 *   - A description with no `order` (Elever: its page gives the order twice, differently) is never read on position.
 *   - `detectFormats` only OFFERS: what it finds is what the user may be asked, never applied by itself.
 *
 * NO PERSONNUMMER LEAVES THE BROWSER. A label that has the shape of a number is not shown (labelOf), a personnummer column is
 * never sampled, and nothing the reading SAYS holds a cell of one: `heldRows` are row NUMBERS. (`block` is X2's own table of cells and
 * keeps them in memory as X2's does; the personnummer columns in it are dropped before anything is shown or sent, by X2's applyMapping.)
 */

import { FIELDS, type TemplateKind } from "@/lib/column-fields";
import { aliasAssignment, chooseHeaderRow, labelOf, personalNumberColumns, type Assignment, type Block } from "@/lib/column-mapping";
import type { RawTable } from "@/lib/column-table";
import { hasPersonalNumber } from "@/lib/personal-number";
import { SKOLA24_FORMATS } from "@/lib/skola24-formats";
import type { FormatColumn, FormatDescriptor, UnreadReason } from "@/lib/skola24-format-types";

// ---------------------------------------------------------------------------
// What the reading says
// ---------------------------------------------------------------------------

export type Verdict =
  | { status: "placed"; column: string; field: string }
  | { status: "unread"; column: string; reason: UnreadReason }
  | { status: "personalNumber"; column: string | null }
  | { status: "unknown" };

export interface ReadColumn {
  index: number;
  /** The header as written, redacted; null for a header that has the shape of a number (lib/column-mapping.ts labelOf). */
  label: string | null;
  verdict: Verdict;
}

export interface FormatReading {
  /** The description's id. */
  format: string;
  /** What each column was placed by: its header, or its position in a file with no header row. */
  by: "header" | "position";
  block: Block;
  /** Every column of the file, in order. */
  columns: ReadColumn[];
  /** The documented columns the file has no column for. */
  missing: FormatColumn[];
  /** For X2: a field id for a placed column, null for a column to read nothing from, undefined for one nobody has placed. */
  assignment: Assignment;
  /** The file's row numbers whose confidential mark is 1: held back, never read. */
  heldRows: number[];
  /** Read on headers, every documented column found under the page's own label, and no column the description does not know. */
  exact: boolean;
}

export interface ReadOptions {
  /** "present": the first row (or `headerRow`) holds the headers. "absent": there is none. "auto" (the default for a page that does not say): decided from the first row. */
  header?: "present" | "absent" | "auto";
  /** The file row the headers stand on, when the user said so (a title above them). Only with a header row. */
  headerRow?: number;
}

// ---------------------------------------------------------------------------
// Identity numbers: personnummer, and Skola24's TF numbers
// ---------------------------------------------------------------------------

/**
 * A TF number as Skola24's own files hold one in the columns where a personnummer goes: eight digits, TF, two digits (ÅÅÅÅMMDDTFnn),
 * seen in all seven of the course files Skola24 publishes and named on the Extens page ("även elever med så kallade TF-nummer"). It does
 * NOT have the shape of a personnummer (web/lib/personal-number.ts), so a file whose ID columns hold only these is not recognised as
 * a file whose first row is data, and its first row becomes the header: one person lost, and the numbers named as columns.
 */
const TF_NUMBER = /(?<!\d)\d{8}TF\d{2}(?!\d)/i;

/**
 * Whether a cell is the kind of number Skola24 puts in an ID column: a personnummer or a TF number. Used to tell a data row from a header
 * and to recognise a file; never to place or to keep a value (a column the description marks as an ID column is dropped, whatever its cells).
 */
export function isIdentityNumber(cell: string | null | undefined): boolean {
  if (!cell) return false;
  return hasPersonalNumber(cell) || TF_NUMBER.test(cell.replace(/\s/g, ""));
}

// ---------------------------------------------------------------------------
// A file with no header row
// ---------------------------------------------------------------------------

/**
 * The block of a file whose first row is DATA: the headers are the description's own labels, every row of the file stays a row,
 * and the row numbers are the file's. A column the file has beyond the labels gets an empty header (named by position, as X2 names a
 * column with no header). `headerRowNumber` is 0: the header is on no row of the file (writeMappedTable says what that means).
 */
export function blockWithoutHeader(table: RawTable, labels: readonly string[]): Block | null {
  if (table.rows.length === 0) return null;
  // As wide as the FILE, not the description: a column no row has a cell for is no column of the file, and the reading names it as missing.
  let width = 0;
  for (const row of table.rows) if (row.length > width) width = row.length;
  const headers = Array.from({ length: width }, (_, at) => labels[at] ?? "");
  return chooseHeaderRow({ ...table, rows: [headers, ...table.rows], rowNumbers: [0, ...table.rowNumbers] }, 0);
}

/** Whether a file's first row is data, for a description that has a fixed order: one of its personnummer columns holds an identity number. */
function firstRowIsData(table: RawTable, columns: readonly FormatColumn[]): boolean {
  const first = table.rows[0];
  if (first === undefined) return false;
  return columns.some((column, at) => column.personalNumber === true && isIdentityNumber(first[at]));
}

// ---------------------------------------------------------------------------
// Placing columns
// ---------------------------------------------------------------------------

/** A header key without its `#n` (lib/column-mapping.ts keysOf writes `#2` for a header that stands twice). */
const baseOf = (key: string): string => key.replace(/#\d+$/, "");

/** The description's column for each column of the block, by the header's key. */
function byHeader(block: Block, columns: readonly FormatColumn[]): (FormatColumn | null)[] {
  return block.keys.map((key) => {
    const base = baseOf(key);
    return columns.find((column) => column.synonyms.includes(base)) ?? null;
  });
}

/** The description's column for each column of the block, by position: the n-th column is the n-th the page lists. */
function byPosition(block: Block, columns: readonly FormatColumn[]): (FormatColumn | null)[] {
  return block.keys.map((_, at) => columns[at] ?? null);
}

/** The columns a row rule holds a row for: a confidential mark. */
function heldRowsOf(block: Block, placed: readonly (FormatColumn | null)[]): number[] {
  const marks = placed.flatMap((column, at) => (column?.confidentialMark === true ? [at] : []));
  if (marks.length === 0) return [];
  const rows: number[] = [];
  block.body.forEach((cells, at) => {
    // The page says "the number 1": a cell that is exactly that, and nothing else is guessed to mean it.
    if (marks.some((index) => cells[index] === "1")) rows.push(block.rowNumbers[at]!);
  });
  return rows;
}

function headerModeOf(table: RawTable, descriptor: FormatDescriptor, asked: ReadOptions["header"]): "present" | "absent" {
  const columns = descriptor.columns!;
  // Only what a page SAYS decides: a header row that is our reading (TOLKAT) is a guess a school's own file may contradict (it adds a header
  // to a file whose page shows none), and a file is then read by what its first row is.
  const stated = descriptor.headerRow?.source.status === "DOKUMENTERAT" ? descriptor.headerRow.value : null;
  const wanted = asked ?? (stated === "yes" ? "present" : stated === "no" ? "absent" : "auto");
  if (wanted !== "auto") return wanted;
  return descriptor.order !== null && firstRowIsData(table, columns) ? "absent" : "present";
}

/**
 * The file as the description reads it, or null: the description has no columns (awaiting an example file), the table is empty, or
 * the file has no header row and the description states no order, so there is nothing to place a column on.
 */
export function readFormat(table: RawTable, descriptor: FormatDescriptor, options: ReadOptions = {}): FormatReading | null {
  const columns = descriptor.columns;
  if (columns === null || table.rows.length === 0) return null;
  const mode = headerModeOf(table, descriptor, options.header);
  if (mode === "absent" && descriptor.order === null) return null;
  const block = mode === "present" ? chooseHeaderRow(table, options.headerRow ?? null) : blockWithoutHeader(table, columns.map((column) => column.label.value));
  if (block === null) return null;

  const placed = mode === "present" ? byHeader(block, columns) : byPosition(block, columns);
  // The description knows which column is a telephone number, which its header may not say; X2's test for personnummer columns must be told
  // BEFORE it runs (it keeps its answer per block): a column of bare ten-digit numbers is otherwise dropped as personnummer.
  const telephone = placed.flatMap((column, at) => (column?.field === "phone" ? [at] : []));
  if (telephone.length > 0) block.telephone = telephone;
  const numbered = personalNumberColumns(block);
  const assignment: Assignment = [];
  const result: ReadColumn[] = block.keys.map((_, index): ReadColumn => {
    const column = placed[index] ?? null;
    const label = labelOf(block.headers[index]!);
    // A column that is a personnummer column to the description or to X2's own test is one: dropped, and the description's id kept when it has one.
    if (column?.personalNumber === true || numbered.has(index)) {
      assignment[index] = null;
      return { index, label, verdict: { status: "personalNumber", column: column?.id ?? null } };
    }
    if (column === null) {
      assignment[index] = undefined;
      return { index, label, verdict: { status: "unknown" } };
    }
    if (descriptor.kind !== null && column.field !== undefined) {
      assignment[index] = column.field;
      return { index, label, verdict: { status: "placed", column: column.id, field: column.field } };
    }
    assignment[index] = null;
    return { index, label, verdict: { status: "unread", column: column.id, reason: column.unread ?? "noImport" } };
  });

  const found = new Set(placed.filter((column): column is FormatColumn => column !== null).map((column) => column.id));
  const missing = columns.filter((column) => !found.has(column.id));
  // Exact: on headers, each documented column found under the page's own label (the first synonym), and nothing else in the file.
  const exact =
    mode === "present" &&
    missing.length === 0 &&
    block.keys.length === columns.length &&
    block.keys.every((key, index) => placed[index]?.synonyms[0] === baseOf(key));

  return { format: descriptor.id, by: mode === "present" ? "header" : "position", block, columns: result, missing, assignment, heldRows: heldRowsOf(block, placed), exact };
}

/** The descriptions that read into a kind of Rastra's imports: the ones with columns, and a kind of their own. Empty for most kinds. */
export function formatsOfKind(kind: TemplateKind): FormatDescriptor[] {
  return SKOLA24_FORMATS.filter((format) => format.kind === kind && format.columns !== null);
}

/**
 * The reading's assignment, with X2's own placement under it: a column the description does not know, whose header the importer
 * already reads (lib/csv-aliases.ts), is placed as it would be without a description. A column the description DOES know is as the
 * description says, whatever the importer would have made of its header.
 */
export function formatAssignment(reading: FormatReading, kind: TemplateKind): Assignment {
  const alias = aliasAssignment(reading.block, kind);
  return reading.assignment.map((entry, at) => (entry === undefined ? alias[at] : entry));
}

/**
 * The Rastra fields a kind cannot be imported without, that the description has no column for: what the format can NEVER give. For
 * Skola24's files this is the finding that matters most (a pupils' file has no e-mail, and Rastra's importer wants one), and it
 * is the description's, not the file's: no file of the format is any different.
 */
export function unfillableFields(descriptor: FormatDescriptor): string[] {
  if (descriptor.kind === null || descriptor.columns === null) return [];
  const given = new Set(descriptor.columns.flatMap((column) => (column.field === undefined ? [] : [column.field])));
  return FIELDS[descriptor.kind].filter((field) => field.required && field.requiredUnless === undefined && !given.has(field.id)).map((field) => field.id);
}

// ---------------------------------------------------------------------------
// Recognising a file
// ---------------------------------------------------------------------------

export interface FormatFit {
  format: string;
  /** "header": the file's headers are the description's. "position": a file with no header row whose columns have the shape the description's fixed order says. */
  by: "header" | "position";
  /** How many of the description's columns the file has, over how many it lists. */
  matched: number;
  of: number;
  /** On headers, every column found under the page's own label and nothing else: the only fit that is ever applied without asking. */
  exact: boolean;
}

/** How many rows of a file with no header row are looked at for a position fit. */
const SAMPLE_ROWS = 25;

/** The fewest cells a row of the description has: through its last column that Skola24 requires (or all of them). */
function requiredWidth(columns: readonly FormatColumn[]): number {
  let width = 0;
  columns.forEach((column, at) => {
    if (column.required?.value === true) width = at + 1;
  });
  return width === 0 ? columns.length : width;
}

/**
 * Which descriptions a table may be a file of: OFFERED, never applied. A header fit is a file whose headers are at least 60 % (and at
 * least three) of a description's; a position fit is a file with no header row whose rows are no wider than the description and at
 * least as wide as its required columns, and whose personnummer columns hold a personnummer or a TF number in most of the first rows. Two
 * descriptions that fit equally (a six-column staff file and a six-column children's file) are both returned: the user chooses.
 */
export function detectFormats(table: RawTable, descriptors: readonly FormatDescriptor[] = SKOLA24_FORMATS): FormatFit[] {
  if (table.rows.length === 0) return [];
  const header = chooseHeaderRow(table, null);
  const sample = table.rows.slice(0, SAMPLE_ROWS);
  const fits: FormatFit[] = [];
  for (const descriptor of descriptors) {
    const columns = descriptor.columns;
    if (columns === null) continue;
    const of = columns.length;

    if (header !== null) {
      const placed = byHeader(header, columns);
      const matched = new Set(placed.filter((column): column is FormatColumn => column !== null).map((column) => column.id)).size;
      if (matched >= 3 && matched * 5 >= of * 3) {
        const exact = matched === of && header.keys.length === of && header.keys.every((key, index) => placed[index]?.synonyms[0] === baseOf(key));
        fits.push({ format: descriptor.id, by: "header", matched, of, exact });
        continue;
      }
    }

    if (descriptor.order !== null && firstRowIsData(table, columns)) {
      const numbers = columns.flatMap((column, at) => (column.personalNumber === true ? [at] : []));
      const wide = requiredWidth(columns);
      const dataRows = sample.filter((row) => row.length <= of && row.length >= wide && numbers.every((at) => isIdentityNumber(row[at])));
      if (dataRows.length * 5 >= sample.length * 4) fits.push({ format: descriptor.id, by: "position", matched: numbers.length, of, exact: false });
    }
  }
  return fits.sort((a, b) => Number(b.exact) - Number(a.exact) || b.matched / b.of - a.matched / a.of);
}
