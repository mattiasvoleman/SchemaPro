import { readXlsx } from '../schedule-exchange/xlsx';
import {
  PAYROLL_CONTENT_TYPE,
  PAYROLL_HEADERS,
  payrollFileName,
  payrollTable,
  renderPayrollCsv,
  renderPayrollXlsx,
  type PayrollFileRow,
} from './payroll-files';

const row = (overrides: Partial<PayrollFileRow> = {}): PayrollFileRow => ({
  signature: 'ÅKE',
  lastName: 'Ångström',
  firstName: 'Östen',
  email: 'osten@example.invalid',
  kindLabel: 'Personal',
  employmentPercent: 87.5,
  partName: 'Högstadiet',
  account: '4030',
  teachingMinutes: 450,
  dutyMinutes: 60,
  substituteMinutes: 45,
  ...overrides,
});

const decode = (bytes: Buffer): string => new TextDecoder('windows-1252').decode(bytes);

describe('payrollTable', () => {
  it('has the header the file promises and a row per line, hours to two decimals and the period on every row', () => {
    const table = payrollTable([row(), row({ partName: 'Ej fördelat', account: '', employmentPercent: null, teachingMinutes: 0, dutyMinutes: 100, substituteMinutes: 0 })], '2026-11-02', '2026-11-27');
    expect(table[0]).toEqual([...PAYROLL_HEADERS]);
    expect(table[1]).toEqual(['ÅKE', '', 'Ångström', 'Östen', 'osten@example.invalid', 'Personal', '87.5', 'Högstadiet', '4030', '450', '60', '45', '9.25', '2026-11-02', '2026-11-27']);
    expect(table[2]).toEqual(['ÅKE', '', 'Ångström', 'Östen', 'osten@example.invalid', 'Personal', '', 'Ej fördelat', '', '0', '100', '0', '1.67', '2026-11-02', '2026-11-27']);
  });

  it('has a Löne-id column beside the signature, empty on every row: Rastra holds no payroll id', () => {
    expect(PAYROLL_HEADERS.slice(0, 5)).toEqual(['Signatur', 'Löne-id', 'Efternamn', 'Förnamn', 'E-post']);
    expect(payrollTable([row(), row({ signature: '' })], 'a', 'b').slice(1).map((cells) => cells[1])).toEqual(['', '']);
  });

  it('keeps up to three decimals of a tjänstgöringsgrad and no trailing zeros', () => {
    expect(payrollTable([row({ employmentPercent: 80 })], 'a', 'b')[1]![6]).toBe('80');
    expect(payrollTable([row({ employmentPercent: 33.333 })], 'a', 'b')[1]![6]).toBe('33.333');
  });
});

describe('renderPayrollCsv: Excel\'s Swedish CSV', () => {
  const table = payrollTable([row()], '2026-11-02', '2026-11-27');
  const { bytes, replaced } = renderPayrollCsv(table);
  const text = decode(bytes);

  it('is windows-1252 without a BOM, so å, ä and ö are the single bytes a Swedish Excel reads', () => {
    expect(bytes[0]).toBe('S'.charCodeAt(0));
    expect(bytes.includes(0xc5)).toBe(true);
    expect(bytes.includes(0xef)).toBe(false);
    expect(text).toContain('Ångström');
    expect(text).toContain('Tjänstgöringsgrad (%)');
    expect(replaced).toBe(0);
  });

  it('separates with semicolons, ends every line with CRLF and writes a decimal comma in the number columns only', () => {
    const lines = text.split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('');
    expect(lines[0]!.split(';')).toEqual([...PAYROLL_HEADERS]);
    expect(lines[1]).toBe('ÅKE;;Ångström;Östen;osten@example.invalid;Personal;87,5;Högstadiet;4030;450;60;45;9,25;2026-11-02;2026-11-27');
  });

  it('quotes a field that holds a semicolon, a quote or a line break, and guards a formula', () => {
    const csv = decode(
      renderPayrollCsv(payrollTable([row({ lastName: 'Ek; Ström', firstName: '=HYPERLINK("x")', partName: 'Del "A"' })], 'a', 'b')).bytes,
    );
    expect(csv).toContain('"Ek; Ström"');
    expect(csv).toContain('"\'=HYPERLINK(""x"")"');
    expect(csv).toContain('"Del ""A"""');
  });

  it('counts the characters windows-1252 could not hold', () => {
    const odd = renderPayrollCsv(payrollTable([row({ lastName: 'Łukasz', firstName: '中' })], 'a', 'b'));
    expect(odd.replaced).toBe(2);
    expect(decode(odd.bytes)).toContain('Lukasz;?;');
  });
});

describe('a person with a protected identity: the signature and nothing else of who they are', () => {
  // What the service hands the writer for a marked person: the names and the e-mail are never read.
  const marked = row({ signature: 'XY', lastName: '', firstName: '', email: '' });
  const table = payrollTable([row(), marked], '2026-11-02', '2026-11-27');

  it('writes the CSV row with the signature, empty name and e-mail columns, and every figure', () => {
    const lines = decode(renderPayrollCsv(table).bytes).split('\r\n');
    expect(lines[2]).toBe('XY;;;;;Personal;87,5;Högstadiet;4030;450;60;45;9,25;2026-11-02;2026-11-27');
  });

  it('writes the same row in the workbook', () => {
    const read = readXlsx(renderPayrollXlsx(table));
    expect(read.rows[2]).toEqual(['XY', '', '', '', '', 'Personal', '87.5', 'Högstadiet', '4030', '450', '60', '45', '9.25', '2026-11-02', '2026-11-27']);
  });
});

describe('renderPayrollXlsx', () => {
  const table = payrollTable([row(), row({ signature: 'BO', lastName: 'Bo', employmentPercent: null })], '2026-11-02', '2026-11-27');
  const read = readXlsx(renderPayrollXlsx(table));

  it('is a workbook named Löneunderlag that reads back with every cell as written, a point for the decimals', () => {
    expect(read.sheetName).toBe('Löneunderlag');
    expect(read.rows).toEqual(table);
  });
});

describe('payrollFileName and the content types', () => {
  it('names the file by its period and its format', () => {
    expect(payrollFileName('CSV', '2026-11-01', '2026-11-30')).toBe('loneunderlag-2026-11-01-2026-11-30.csv');
    expect(payrollFileName('XLSX', '2026-11-01', '2026-11-30')).toBe('loneunderlag-2026-11-01-2026-11-30.xlsx');
  });

  it('says windows-1252 for the CSV', () => {
    expect(PAYROLL_CONTENT_TYPE.CSV).toBe('text/csv; charset=windows-1252');
    expect(PAYROLL_CONTENT_TYPE.XLSX).toContain('spreadsheetml.sheet');
  });
});
