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
 * WHO A ROW IS. A person is named by signature, name and e-mail; a person with
 * a protected identity by signature alone, with the name and the e-mail
 * columns empty (the caller never reads them: analysis.service.ts). The file
 * travels (e-mail, a shared folder), and which signature is whom stays in
 * Rastra. Löne-id is the payroll system's own id of the anställning, which
 * Rastra does not hold (BESLUT, K1): the column is there, empty on every row,
 * so that the file's columns do not move the day it is filled in.
 *
 * PURE.
 */

export const PAYROLL_HEADERS = [
  'Signatur',
  'Löne-id',
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
] as const;

/** Columns (0-based) holding numbers, and how they are formatted in the workbook. */
export const PAYROLL_NUMBER_COLUMNS: Readonly<Record<number, 'integer' | 'decimal'>> = {
  6: 'decimal',
  9: 'integer',
  10: 'integer',
  11: 'integer',
  12: 'decimal',
};

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
}

/** The table, header first. Hours are minutes over 60 to two decimals; a percentage keeps up to three. */
export function payrollTable(rows: readonly PayrollFileRow[], from: string, to: string): string[][] {
  return [
    [...PAYROLL_HEADERS],
    ...rows.map((row) => [
      row.signature,
      // Löne-id: Rastra holds no payroll id (see WHO A ROW IS).
      '',
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
  const guarded = guardFormula(cell);
  return /[";\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
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
    { sheetName: 'Löneunderlag', numberColumns: PAYROLL_NUMBER_COLUMNS, widths: [10, 12, 18, 16, 28, 12, 12, 18, 10, 12, 12, 12, 11, 12, 12] },
  );
}

export function payrollFileName(format: PayrollFormat, from: string, to: string): string {
  return `loneunderlag-${from}-${to}.${format === 'CSV' ? 'csv' : 'xlsx'}`;
}

export const PAYROLL_CONTENT_TYPE: Record<PayrollFormat, string> = {
  CSV: 'text/csv; charset=windows-1252',
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
