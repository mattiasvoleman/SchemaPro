/**
 * The CSV dialect every file of the school's exports speaks, written the way
 * web/lib/csv-export.ts writes it: `;`-separated, CRLF line ends, a UTF-8 BOM,
 * a field quoted only when it holds `"`, `;` or a line break, and a cell that
 * would be a formula in a spreadsheet (a leading `=`, `+`, `-` or `@`) given a
 * leading apostrophe, which the importers take off again.
 *
 * It is a copy of the web's `escapeField` / `neutralizeFormula` /
 * `serializeCsv` (the gateway cannot import web/lib: the API's image builds
 * from src/ alone), and the two are held byte for byte by one list of cases:
 * __fixtures__/csv-writer-cases.json, generated from the web's writer by
 * web/lib/csv-writer-cases.test.ts and replayed on both sides. A file the
 * whole-school export writes is therefore a file the school's own page would
 * have written, and reads back in through the same importer.
 *
 * Unlike src/schedule-exchange/csv.ts (the timetable table, with its own
 * guard that doubles a leading apostrophe), this is the dialect of the
 * importable lists, whose reader is web/lib/csv.ts.
 */

export const CSV_BOM = '﻿';

/**
 * A leading =, +, - or @ (or tab, CR) makes a spreadsheet read the cell as a
 * formula, quoted or not; an apostrophe makes it text. Plain numbers and
 * Swedish decimals ("-12,5") are left alone, as the web leaves them.
 */
export function neutralizeFormula(value: string): string {
  const shape = /^('*)[\s\t]*[=+\-@\t\r]/.exec(value);
  if (shape === null) return value;
  if (shape[1] === '' && value.trim() !== '' && Number.isFinite(Number(value.trim()))) return value;
  if (/^-?\d+(,\d+)?$/.test(value)) return value;
  return `'${value}`;
}

/** One cell as the file writes it. */
export function csvField(value: string): string {
  const guarded = neutralizeFormula(value);
  if (!/[";\r\n]/.test(guarded)) return guarded;
  return `"${guarded.replace(/"/g, '""')}"`;
}

/** One line, with its CRLF. */
export function csvLine(cells: readonly string[]): string {
  return cells.map(csvField).join(';') + '\r\n';
}

/** A whole file: BOM, header and rows, exactly the web's `serializeCsv`. */
export function serializeCsv(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  return CSV_BOM + csvLine(headers) + rows.map(csvLine).join('');
}

/** Text of a nullable cell. */
export const cell = (value: string | number | bigint | boolean | null | undefined): string =>
  value === null || value === undefined ? '' : String(value);

/** yyyy-mm-dd of a date column as Postgres answers it (a Date at UTC midnight). */
export const dayOf = (value: Date | null | undefined): string => (value ? value.toISOString().slice(0, 10) : '');

/** An instant in UTC, to the second, as ISO 8601 ("2026-11-05T09:30:00Z"). */
export const instantOf = (value: Date | null | undefined): string =>
  value ? value.toISOString().replace(/\.\d{3}Z$/, 'Z') : '';

/** HH:MM:SS of a time column (Postgres `time`, which Prisma answers as a Date on 1970-01-01). */
export const clockOf = (value: Date | null | undefined): string => (value ? value.toISOString().slice(11, 19) : '');
