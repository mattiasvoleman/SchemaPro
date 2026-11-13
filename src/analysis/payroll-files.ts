import { guardFormula } from '../schedule-exchange/csv';
import { writeXlsx } from '../schedule-exchange/xlsx';
import type { PayrollFormat } from './analysis.types';
import { encodeWindows1252 } from './windows-1252';

/*
 * Löneunderlaget as a file: Excel's Swedish CSV and an Excel workbook.
 *
 * CSV: ';' between the fields, a decimal comma, CRLF, Windows-1252 and no BOM
 * (a BOM is how UTF-8 announces itself; a 1252 file has none). The formula
 * guard is the schedule exchange's (schedule-exchange/csv.ts), so a name that
 * starts with = or @ is text in this file as it is in every other; quoting is
 * this file's own, see field().
 *
 * XLSX: the schedule exchange's writer, with the minute and hour columns as
 * NUMBERS so that a payroll office can sum them; everything else is text.
 *
 * One table, two renderings: the cells are strings with a decimal POINT in the
 * table (what the workbook stores), and the CSV turns the points in the number
 * columns into commas. The header and the order of the columns are the file's
 * contract with whoever imports it.
 *
 * WHO A ROW IS. A person is named by signature, name, e-mail and Löne-id (the
 * payroll system's own number for the anställning, written on the post,
 * 20270206090000; empty where the school has written none). A person with a
 * protected identity is named by signature and Löne-id alone, with the name
 * and the e-mail columns empty (the caller never reads them:
 * analysis.service.ts), and where they have no Löne-id by their code there
 * instead, SKYDDAD-<number> (PayrollPseudonyms, 20270206091000), the same in
 * every file. The file travels (e-mail, a shared folder), and which code is
 * whom stays in Rastra.
 *
 * Löne-id is the LAST column: the file of the first release (#280) had none,
 * and an import set up on it finds every column where it was.
 *
 * PURE.
 */

export const PAYROLL_HEADERS = [
  'Signatur',
  'Efternamn',
  'Förnamn',
  'E-post',
  'Typ',
  'Tjänstgöringsgrad (%)',
  'Skoldel',
  'Konto',
  'Undervisning (min)',
  'Uppdrag (min)',
  'Vikariepass (min)',
  'Totalt (tim)',
  'Från',
  'Till',
  'Löne-id',
] as const;

/** Columns (0-based) holding numbers, and how they are formatted in the workbook. */
export const PAYROLL_NUMBER_COLUMNS: Readonly<Record<number, 'integer' | 'decimal'>> = {
  5: 'decimal',
  8: 'integer',
  9: 'integer',
  10: 'integer',
  11: 'decimal',
};

/** A marked person's code in the Löne-id column, from their PayrollPseudonyms number. */
export function payrollPseudonym(number: number): string {
  return `SKYDDAD-${number}`;
}

export interface PayrollFileRow {
  signature: string;
  /** Empty for a person with a protected identity, as are firstName and email. */
  lastName: string;
  firstName: string;
  email: string;
  kindLabel: string;
  /** Tjänstgöringsgrad, %, or null. */
  employmentPercent: number | null;
  partName: string;
  account: string;
  teachingMinutes: number;
  dutyMinutes: number;
  substituteMinutes: number;
  /** Löne-id: the post's number, a marked person's code where they have none, or ''. */
  payrollId: string;
}

/** The table, header first. Hours are minutes over 60 to two decimals; a percentage keeps up to three. */
export function payrollTable(rows: readonly PayrollFileRow[], from: string, to: string): string[][] {
  return [
    [...PAYROLL_HEADERS],
    ...rows.map((row) => [
      row.signature,
      row.lastName,
      row.firstName,
      row.email,
      row.kindLabel,
      row.employmentPercent === null ? '' : String(Number(row.employmentPercent.toFixed(3))),
      row.partName,
      row.account,
      String(row.teachingMinutes),
      String(row.dutyMinutes),
      String(row.substituteMinutes),
      ((row.teachingMinutes + row.dutyMinutes + row.substituteMinutes) / 60).toFixed(2),
      from,
      to,
      row.payrollId,
    ]),
  ];
}

/**
 * A field of this file: quoted only where the file's own separators are in it (a semicolon, a quote, a line break).
 * The comma is not one: it is the decimal sign here, and `"87,5"` is a number Excel reads but a payroll import
 * may not, which the schedule exchange's writer (it quotes any of its three delimiters, because its reader
 * guesses the delimiter) would have written.
 */
function field(cell: string): string {
  const guarded = guarded1252(cell);
  return /[";\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/**
 * The control characters the encoder writes as a space (everything below U+0020 but tab, line feed and carriage return;
 * src/common/windows-1252.ts). `\s` in the formula guard's shape does not cover NUL, BEL or ESC, and a space before
 * `=` is exactly what that shape calls dangerous, so a cell `<BEL>=HYPERLINK(..)` slipped past a guard that read it
 * before the encoder had made it ` =HYPERLINK(..)` (the review of #308, LÅG-2).
 */
const WRITTEN_AS_SPACE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

/**
 * The formula guard asked about the cell as the file will read, and applied to the cell as it is: the encoder still
 * sees the control character, which it counts, and the apostrophe goes in front of the whole cell.
 */
function guarded1252(cell: string): string {
  const seen = cell.replace(WRITTEN_AS_SPACE, ' ');
  return guardFormula(seen) === seen ? cell : `'${cell}`;
}

/** The CSV: Swedish Excel's, in windows-1252. `replaced` counts the characters 1252 could not hold. */
export function renderPayrollCsv(table: readonly string[][]): { bytes: Buffer; replaced: number } {
  const lines = table.map((row, rowIndex) =>
    row
      .map((cell, column) => field(rowIndex > 0 && PAYROLL_NUMBER_COLUMNS[column] !== undefined ? cell.replace('.', ',') : cell))
      .join(';'),
  );
  return encodeWindows1252(lines.map((line) => `${line}\r\n`).join(''));
}

export function renderPayrollXlsx(table: readonly string[][]): Buffer {
  return writeXlsx(
    table.map((row) => [...row]),
    { sheetName: 'Löneunderlag', numberColumns: PAYROLL_NUMBER_COLUMNS, widths: [10, 18, 16, 28, 12, 12, 18, 10, 12, 12, 12, 11, 12, 12, 14] },
  );
}

export function payrollFileName(format: PayrollFormat, from: string, to: string): string {
  return `loneunderlag-${from}-${to}.${format === 'CSV' ? 'csv' : 'xlsx'}`;
}

export const PAYROLL_CONTENT_TYPE: Record<PayrollFormat, string> = {
  CSV: 'text/csv; charset=windows-1252',
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
