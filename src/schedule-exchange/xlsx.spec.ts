import { randomBytes } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { excelSerialToText, isDateFormatCode, readXlsx, writeXlsx, XlsxError, XLSX_MAX_CELL_CHARS } from './xlsx';
import { childNamed, childrenNamed, parseXml, type XmlNode } from './xml';
import { readZip, writeZip } from './zip';

// ---------------------------------------------------------------------------
// Helpers: packages built by hand, the way Excel writes them
// ---------------------------------------------------------------------------

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const rel = (id: string, type: string, target: string): string => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`;

const ROOT_RELS = `${DECL}<Relationships xmlns="${PKG_REL}">${rel('rId1', 'officeDocument', 'xl/workbook.xml')}</Relationships>`;

const WORKBOOK_RELS = (target = 'worksheets/sheet1.xml'): string =>
  `${DECL}<Relationships xmlns="${PKG_REL}">${rel('rId1', 'worksheet', target)}${rel('rId2', 'worksheet', 'worksheets/sheet2.xml')}${rel('rId3', 'theme', 'theme/theme1.xml')}${rel('rId4', 'styles', 'styles.xml')}${rel('rId5', 'sharedStrings', 'sharedStrings.xml')}</Relationships>`;

const workbook = (sheets: string, pr = '<workbookPr defaultThemeVersion="166925"/>'): string =>
  `${DECL}<workbook xmlns="${MAIN}" xmlns:r="${REL}">${pr}<sheets>${sheets}</sheets></workbook>`;

/**
 * What Excel writes for styles: custom date formats from 164, cellXfs by index.
 * 0 General, 1 built-in 14 (date), 2 custom yyyy-mm-dd, 3 built-in 20 (h:mm),
 * 4 custom hh:mm, 5 built-in 22 (date and time), 6 text (49), 7 custom money
 * with a quoted "d", 8 built-in 18 (h:mm AM/PM).
 */
const STYLES = `${DECL}<styleSheet xmlns="${MAIN}"><numFmts count="3"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/><numFmt numFmtId="165" formatCode="hh:mm"/><numFmt numFmtId="166" formatCode="0.00&quot; dyr&quot;"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="9"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="20" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="22" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="18" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

const sheetXml = (rows: string, extra = ''): string => `${DECL}<worksheet xmlns="${MAIN}" xmlns:r="${REL}">${extra}<sheetData>${rows}</sheetData></worksheet>`;

interface Package {
  sheet?: string;
  styles?: string | null;
  shared?: string | null;
  sheets?: string;
  workbookPr?: string;
  workbookRels?: string;
  rootRels?: string | null;
  workbookXml?: string;
  extra?: { name: string; data: Buffer }[];
}

function pkg(parts: Package = {}): Buffer {
  const text = (name: string, xml: string): { name: string; data: Buffer } => ({ name, data: Buffer.from(xml, 'utf8') });
  const entries = [text('[Content_Types].xml', `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`)];
  if (parts.rootRels !== null) entries.push(text('_rels/.rels', parts.rootRels ?? ROOT_RELS));
  entries.push(
    text(
      'xl/workbook.xml',
      parts.workbookXml ?? workbook(parts.sheets ?? `<sheet name="Schema" sheetId="1" r:id="rId1"/><sheet name="Blad2" sheetId="2" r:id="rId2"/>`, parts.workbookPr),
    ),
    text('xl/_rels/workbook.xml.rels', parts.workbookRels ?? WORKBOOK_RELS()),
    text('xl/worksheets/sheet1.xml', parts.sheet ?? sheetXml('')),
    text('xl/worksheets/sheet2.xml', sheetXml('<row r="1"><c r="A1" t="inlineStr"><is><t>other sheet</t></is></c></row>')),
  );
  if (parts.styles !== null) entries.push(text('xl/styles.xml', parts.styles ?? STYLES));
  if (parts.shared !== null && parts.shared !== undefined) entries.push(text('xl/sharedStrings.xml', parts.shared));
  entries.push(...(parts.extra ?? []));
  return writeZip(entries);
}

/** One numeric cell in a package with the styles above; returns what readXlsx makes of it. */
function readNumber(value: string, style: number, date1904 = false): string {
  const bytes = pkg({
    sheet: sheetXml(`<row r="1"><c r="A1" s="${style}"><v>${value}</v></c></row>`),
    workbookPr: date1904 ? '<workbookPr date1904="1"/>' : undefined,
  });
  return readXlsx(bytes).rows[0]?.[0] ?? '';
}

const inline = (reference: string, value: string): string => `<c r="${reference}" t="inlineStr"><is><t>${value}</t></is></c>`;

function expectRefusal(action: () => unknown, message: RegExp): void {
  expect(action).toThrow(XlsxError);
  expect(action).toThrow(message);
}

const partsOf = (bytes: Buffer): Map<string, XmlNode> =>
  new Map([...readZip(bytes)].map(([name, data]) => [name, parseXml(data.toString('utf8'))] as const));

// ---------------------------------------------------------------------------
// A file as Excel saves it
// ---------------------------------------------------------------------------

const EXCEL_SHARED = `${DECL}<sst xmlns="${MAIN}" count="14" uniqueCount="10">
<si><t>Schema för Lillskolan</t></si>
<si><t>Klass/grupp</t></si>
<si><t>Ämne</t></si>
<si><t>1A</t></si>
<si><t>Matematik</t></si>
<si><r><rPr><b/><sz val="11"/></rPr><t>Rik</t></r><r><rPr><sz val="11"/></rPr><t xml:space="preserve"> text</t></r></si>
<si><t>漢字</t><rPh sb="0" eb="2"><t>かんじ</t></rPh><phoneticPr fontId="1"/></si>
<si><t xml:space="preserve">rad_x000D_ett_x005F_x000D_</t></si>
<si><t xml:space="preserve">  mellanslag  </t></si>
<si><t></t></si>
</sst>`;

const EXCEL_SHEET = sheetXml(
  [
    // Row 1: a title above the table, as Excel users add one.
    '<row r="1" spans="1:6"><c r="A1" t="s"><v>0</v></c></row>',
    // Row 2 is missing altogether. Row 3: the header, with a skipped cell (E3).
    '<row r="3" spans="1:6"><c r="A3" t="s"><v>1</v></c><c r="B3" t="s"><v>2</v></c><c r="D3" t="inlineStr"><is><t>Start</t></is></c></row>',
    // Row 4: shared strings, a time (h:mm), a custom hh:mm, a date (14), a custom date.
    '<row r="4"><c r="A4" t="s"><v>3</v></c><c r="B4" t="s"><v>4</v></c><c r="C4" s="3"><v>0.34027777777777779</v></c><c r="D4" s="4"><v>0.375</v></c><c r="E4" s="1"><v>46251</v></c><c r="F4" s="2"><v>46387</v></c></row>',
    // Row 5: a numeric id, a formula with a cached string, a boolean, an error, a date-and-time, a number with a quoted "d" in its format.
    '<row r="5"><c r="A5"><v>7</v></c><c r="B5" t="str"><f>A4&amp;"x"</f><v>1Ax</v></c><c r="C5" t="b"><v>1</v></c><c r="D5" t="e"><v>#N/A</v></c><c r="E5" s="5"><v>46251.5</v></c><c r="F5" s="7"><v>12.5</v></c></row>',
    // Row 7 (row 6 missing): an inline string, a rich-text string, a phonetic string; A7 and B7 skipped.
    `<row r="7">${inline('C7', 'inline')}<c r="D7" t="s"><v>5</v></c><c r="E7" t="s"><v>6</v></c></row>`,
    // Row 8: no cell references at all; escaped control characters; a plain number stored as written; a formula without a cached value.
    '<row r="8"><c t="s"><v>7</v></c><c t="s"><v>8</v></c><c><v>1.5E-3</v></c><c t="s"><f>A1</f></c></row>',
    // Row 9: cells that are only formatted, far to the right and far below: not data, not counted.
    '<row r="9"><c r="BZ9" s="1"/><c r="CA9" t="s"><v>9</v></c></row>',
    '<row r="30000"><c r="A30000" s="6"/></row>',
  ].join(''),
  '<dimension ref="A1:CA30000"/><sheetViews><sheetView workbookViewId="0"/></sheetViews>',
);

const excelPackage = (): Buffer => pkg({ sheet: EXCEL_SHEET, shared: EXCEL_SHARED, rootRels: ROOT_RELS });

describe('readXlsx: a workbook as Excel saves it', () => {
  const result = readXlsx(excelPackage());

  it('returns the first worksheet in workbook order, by name', () => {
    expect(result.sheetName).toBe('Schema');
  });

  it('keeps every row where the user sees it: a title, a gap, then the table, in a rectangle', () => {
    expect(result.rows).toHaveLength(8); // trailing formatted rows are not part of it
    for (const row of result.rows) expect(row).toHaveLength(6);
    expect(result.rows[0]).toEqual(['Schema för Lillskolan', '', '', '', '', '']);
    expect(result.rows[1]).toEqual(['', '', '', '', '', '']);
    expect(result.rows[2]).toEqual(['Klass/grupp', 'Ämne', '', 'Start', '', '']);
  });

  it('reads shared strings, times, dates and a custom date format as text a person would write', () => {
    expect(result.rows[3]).toEqual(['1A', 'Matematik', '08:10', '09:00', '2026-08-17', '2026-12-31']);
  });

  it('reads a number as stored, a formula by its cached value, a boolean, an error, a date with a time', () => {
    expect(result.rows[4]).toEqual(['7', '1Ax', 'TRUE', '#N/A', '2026-08-17 12:00', '12.5']);
  });

  it('reads inline strings, rich-text runs and phonetic strings, skipping the cells nobody wrote', () => {
    expect(result.rows[5]).toEqual(['', '', '', '', '', '']);
    expect(result.rows[6]).toEqual(['', '', 'inline', 'Rik text', '漢字', '']);
  });

  it('places cells that have no reference one after the other, decodes Excel escapes and keeps numbers verbatim', () => {
    expect(result.rows[7]).toEqual(['rad\rett_x000D_', '  mellanslag  ', '1.5E-3', '', '', '']);
  });
});

describe('readXlsx: how a workbook is found', () => {
  const sheet = sheetXml(`<row r="1">${inline('A1', 'x')}</row>`);

  it('falls back to xl/workbook.xml when the package has no root relationships', () => {
    expect(readXlsx(pkg({ sheet, rootRels: null })).rows).toEqual([['x']]);
  });

  it('follows the package relationship to a workbook with another name', () => {
    const bytes = writeZip([
      { name: '_rels/.rels', data: Buffer.from(`${DECL}<Relationships xmlns="${PKG_REL}">${rel('rId1', 'officeDocument', '/book/main.xml')}</Relationships>`) },
      { name: 'book/main.xml', data: Buffer.from(workbook('<sheet name="Eget" sheetId="1" r:id="rId1"/>')) },
      { name: 'book/_rels/main.xml.rels', data: Buffer.from(`${DECL}<Relationships xmlns="${PKG_REL}">${rel('rId1', 'worksheet', '../data/s.xml')}</Relationships>`) },
      { name: 'data/s.xml', data: Buffer.from(sheet) },
    ]);
    expect(readXlsx(bytes)).toEqual({ rows: [['x']], sheetName: 'Eget' });
  });

  it.each(['/xl/worksheets/sheet1.xml', './worksheets/sheet1.xml', '../xl/worksheets/sheet1.xml', 'worksheets//sheet1.xml'])('resolves the target %s', (target) => {
    expect(readXlsx(pkg({ sheet, workbookRels: WORKBOOK_RELS(target) })).rows).toEqual([['x']]);
  });

  it('reads the first sheet in WORKBOOK order, not the one named sheet1.xml, and skips a chart sheet', () => {
    const rels = `${DECL}<Relationships xmlns="${PKG_REL}">${rel('rId1', 'worksheet', 'worksheets/sheet1.xml')}${rel('rId2', 'worksheet', 'worksheets/sheet2.xml')}${rel('rId9', 'chartsheet', 'chartsheets/sheet1.xml')}</Relationships>`;
    const second = readXlsx(pkg({ workbookRels: rels, sheets: '<sheet name="Diagram" sheetId="3" r:id="rId9"/><sheet name="Andra" sheetId="2" r:id="rId2"/><sheet name="Första" sheetId="1" r:id="rId1"/>' }));
    expect(second).toEqual({ rows: [['other sheet']], sheetName: 'Andra' });
  });

  it('reads a package written with a namespace prefix on every element', () => {
    const prefixed = `${DECL}<x:worksheet xmlns:x="${MAIN}"><x:sheetData><x:row r="2"><x:c r="B2" t="inlineStr"><x:is><x:t>p</x:t></x:is></x:c></x:row></x:sheetData></x:worksheet>`;
    expect(readXlsx(pkg({ sheet: prefixed })).rows).toEqual([
      ['', ''],
      ['', 'p'],
    ]);
  });

  it('reads a workbook with no styles and no shared strings part', () => {
    expect(readXlsx(pkg({ sheet, styles: null, shared: null })).rows).toEqual([['x']]);
    expect(readXlsx(pkg({ sheet: sheetXml('<row r="1"><c r="A1" s="1"><v>46251</v></c></row>'), styles: null })).rows).toEqual([['46251']]);
  });

  it('reads a styles part with no number formats and no cell formats', () => {
    const bare = `${DECL}<styleSheet xmlns="${MAIN}"/>`;
    expect(readNumber('46251', 1)).toBe('2026-08-17');
    expect(readXlsx(pkg({ sheet: sheetXml('<row r="1"><c r="A1" s="1"><v>46251</v></c></row>'), styles: bare })).rows).toEqual([['46251']]);
  });

  it('tolerates elements with attributes missing: a relationship with nothing, a format with no code, a cell format with no id, a sheet with no name', () => {
    const bare = `<Relationship/>`;
    const rootRels = `${DECL}<Relationships xmlns="${PKG_REL}">${bare}${rel('rId1', 'officeDocument', 'xl/workbook.xml')}</Relationships>`;
    const workbookRels = WORKBOOK_RELS().replace('</Relationships>', `${bare}</Relationships>`);
    const styles = `${DECL}<styleSheet xmlns="${MAIN}"><numFmts><numFmt numFmtId="170"/></numFmts><cellXfs><xf/><xf numFmtId="170"/></cellXfs></styleSheet>`;
    const rows = '<row r="1"><c r="A1" s="0"><v>46251</v></c><c r="B1" s="1"><v>46251</v></c></row>';
    const result = readXlsx(pkg({ rootRels, workbookRels, styles, sheet: sheetXml(rows), sheets: '<sheet sheetId="1" r:id="rId1"/>' }));
    expect(result).toEqual({ rows: [['46251', '46251']], sheetName: '' });
  });

  it('reads an empty sheet as no rows', () => {
    expect(readXlsx(pkg({ sheet: sheetXml('') })).rows).toEqual([]);
    expect(readXlsx(pkg({ sheet: `${DECL}<worksheet xmlns="${MAIN}"/>` })).rows).toEqual([]);
  });

  it('numbers a row without r after the one before, and ignores an unusable r', () => {
    const rows = `<row>${inline('A1', 'a')}</row><row r="0">${inline('A1', 'b')}</row><row r="x">${inline('A1', 'c')}</row>`;
    // r="0" and r="x" are not row numbers, so each row follows the one before: rows 2 and 3.
    expect(readXlsx(pkg({ sheet: sheetXml(rows) })).rows).toEqual([['a'], ['b'], ['c']]);
  });

  it('places a cell with a reference it cannot read after the cell before it', () => {
    const rows = `<row r="1">${inline('A1', 'a')}${inline('???', 'b')}${inline('ABCD1', 'c')}</row>`;
    expect(readXlsx(pkg({ sheet: sheetXml(rows) })).rows).toEqual([['a', 'b', 'c']]);
  });

  it('reads booleans in their spellings', () => {
    const cell = (value: string, n: number): string => `<c r="${'ABCD'[n]}1" t="b"><v>${value}</v></c>`;
    const rows = `<row r="1">${cell('1', 0)}${cell('true', 1)}${cell('0', 2)}${cell('', 3)}</row>`;
    expect(readXlsx(pkg({ sheet: sheetXml(rows) })).rows).toEqual([['TRUE', 'TRUE', 'FALSE']]);
  });

  it('reads an inline-string cell with no string, a shared-string cell with no index, and a cell of ISO text', () => {
    const rows = '<row r="1"><c r="A1" t="inlineStr"/><c r="B1" t="s"/><c r="C1" t="d"><v>2026-08-17T00:00:00</v></c></row>';
    expect(readXlsx(pkg({ sheet: sheetXml(rows), shared: EXCEL_SHARED })).rows).toEqual([['', '', '2026-08-17T00:00:00']]);
  });
});

// ---------------------------------------------------------------------------
// Dates and times
// ---------------------------------------------------------------------------

describe('readXlsx: numbers with a date or time format', () => {
  it.each([
    ['0.34027777777777779', 3, '08:10'], // h:mm, the value Excel stores for 08:10
    ['0.340277777777778', 4, '08:10'], // custom hh:mm, 15 digits as Excel writes them
    ['0.3402777777777777', 3, '08:10'], // a hair under: rounding to the second, not truncating the minute
    ['0.340625', 3, '08:10'], // 08:10:30, seconds dropped
    ['0.5', 8, '12:00'], // built-in 18
    ['0.99999999', 3, '23:59'], // not a midnight that rolls into day 1
    ['0', 3, '00:00'],
    ['46251', 1, '2026-08-17'],
    ['46251', 2, '2026-08-17'],
    ['46251', 3, '2026-08-17'], // a whole serial is a date whatever the format says
    ['46251.5', 5, '2026-08-17 12:00'],
    ['46251.340277777777', 5, '2026-08-17 08:10'],
    ['46251.99999999', 5, '2026-08-18'], // rounds up to the next midnight
    ['46251', 0, '46251'], // General: a number
    ['46251', 6, '46251'], // text format
    ['12.5', 7, '12.5'], // a custom format whose only d is quoted
    ['1000', 0, '1000'],
    ['1.0000000000000001E-3', 0, '1.0000000000000001E-3'], // as stored, no reformatting
    ['  42  ', 0, '42'],
    ['46251', 99, '46251'], // a style index past the list
  ])('reads %s with style %i as %s', (value, style, expected) => {
    expect(readNumber(value, style)).toBe(expected);
  });

  it('returns a date-styled value as stored when it is not a date this reader makes', () => {
    expect(readNumber('-5', 1)).toBe('-5');
    expect(readNumber('abc', 1)).toBe('abc');
    expect(readNumber('3000000', 1)).toBe('3000000');
    expect(readNumber('', 1)).toBe('');
  });

  it('handles Excel 1900 leap-year bug: serial 60 is the 29th of February that never was', () => {
    expect(readNumber('1', 1)).toBe('1900-01-01');
    expect(readNumber('59', 1)).toBe('1900-02-28');
    expect(readNumber('60', 1)).toBe('1900-02-29');
    expect(readNumber('61', 1)).toBe('1900-03-01');
    expect(readNumber('2958465', 1)).toBe('9999-12-31');
  });

  it('honours the 1904 date system', () => {
    expect(readNumber('0.5', 1, true)).toBe('12:00');
    expect(readNumber('1', 1, true)).toBe('1904-01-02');
    expect(readNumber('60', 1, true)).toBe('1904-03-01'); // there is no invented day in this system
    expect(readNumber('44789', 1, true)).toBe('2026-08-17'); // the 1900 serial 46251 minus 1462 days
    expect(readNumber('2958000', 1, true)).toBe('2958000'); // past year 9999
    expect(readXlsx(pkg({ sheet: sheetXml('<row r="1"><c r="A1" s="1"><v>44789</v></c></row>'), workbookPr: '<workbookPr date1904="true"/>' })).rows[0]![0]).toBe('2026-08-17');
  });

  it('turns serials into text by value, directly', () => {
    expect(excelSerialToText('46251', false)).toBe('2026-08-17');
    expect(excelSerialToText('', false)).toBeNull();
    expect(excelSerialToText('NaN', false)).toBeNull();
    expect(excelSerialToText('Infinity', false)).toBeNull();
    expect(excelSerialToText('2958466', false)).toBeNull();
  });
});

describe('isDateFormatCode', () => {
  it.each([
    'yyyy-mm-dd',
    'yyyy\\-mm\\-dd',
    'hh:mm',
    'h:mm AM/PM',
    'DD/MM/YYYY',
    '[$-409]d-mmm-yy;@',
    '[$-F800]dddd\\,\\ mmmm\\ dd\\,\\ yyyy',
    '[h]:mm:ss',
    '[mm]:ss',
    '[Red]dd.mm',
    'mm:ss.0',
    'dd "dagar"',
    '"kl" hh:mm',
    '_(h:mm_)',
  ])('%s is a date or time format', (code) => {
    expect(isDateFormatCode(code)).toBe(true);
  });

  it.each(['General', '0.00', '#,##0.00 "kr"', '0.00E+00', '@', '"yyyy"', '\\d\\m\\y', '0_m', '*d0', '[Red]0.00', '[$-409]0', '', '0 "unterminated', '[unterminated d', '0.0%'])(
    '%j is not',
    (code) => {
      expect(isDateFormatCode(code)).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// What it refuses
// ---------------------------------------------------------------------------

describe('readXlsx: what it refuses, in Swedish', () => {
  const OLE2 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

  it('refuses a password-protected workbook (an OLE2 file holding an EncryptedPackage stream)', () => {
    const encrypted = Buffer.concat([OLE2, Buffer.alloc(512), Buffer.from('EncryptedPackage', 'utf16le'), Buffer.alloc(512)]);
    expectRefusal(() => readXlsx(encrypted), /lösenordsskyddad/);
  });

  it('refuses a legacy .xls (an OLE2 file with a Workbook stream)', () => {
    const legacy = Buffer.concat([OLE2, Buffer.alloc(512), Buffer.from('Workbook', 'utf16le'), Buffer.alloc(512)]);
    expectRefusal(() => readXlsx(legacy), /gamla Excel-formatet \(\.xls\)/);
  });

  it('refuses what is not a zip at all, and an empty buffer', () => {
    expectRefusal(() => readXlsx(Buffer.from('Klass;Ämne;Dag\r\n1A;Matematik;Mån\r\n')), /Excel-arbetsbok \(\.xlsx\)/);
    expectRefusal(() => readXlsx(Buffer.alloc(0)), /för kort/);
  });

  it('passes the zip limits through as Excel refusals', () => {
    const many = writeZip(Array.from({ length: 65 }, (_v, i) => ({ name: `p${i}`, data: Buffer.from('x') })));
    expectRefusal(() => readXlsx(many), /högst 64/);
    const bomb = writeZip([{ name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(2 * 1024 * 1024) }]);
    expectRefusal(() => readXlsx(bomb), /komprimeringsbomb/);
  });

  describe('the size a package may unpack to (EXCHANGE_ZIP_LIMITS: 8 MB a part, 8 MB in all)', () => {
    const MB8 = 8 * 1024 * 1024;
    /** The bytes of the other parts of pkg(): the limit is on the sum, so a sheet of the size below makes the package that size. */
    const others = [...readZip(pkg({ sheet: sheetXml('') })).values()].reduce((sum, part) => sum + part.length, 0) - Buffer.byteLength(sheetXml(''));
    /** A valid sheet padded with an XML comment so that the package unpacks to `total` bytes: random hex, so that it is no bomb either. */
    function packageOfSize(total: number): Buffer {
      const empty = sheetXml('');
      const padding = total - others - Buffer.byteLength(empty) - '<!---->'.length;
      const comment = randomBytes(Math.ceil(padding / 2)).toString('hex').slice(0, padding);
      return pkg({ sheet: empty.replace('<sheetData>', `<!--${comment}--><sheetData>`) });
    }

    it('reads a package of exactly 8 MB unpacked and refuses one byte more, which the generic limits would have taken', () => {
      const exact = packageOfSize(MB8);
      expect([...readZip(exact).values()].reduce((sum, part) => sum + part.length, 0)).toBe(MB8);
      expect(readXlsx(exact).rows).toEqual([]);
      const over = packageOfSize(MB8 + 1);
      expectRefusal(() => readXlsx(over), /^Filen går inte att läsa som en Excel-arbetsbok \(\.xlsx\): Zip-filen är större än 8 MB uppackad\.$/);
      expect(readZip(over).size).toBeGreaterThan(0); // 64 MB in all: zip.ts alone would have unpacked it
    });

    it('refuses from the directory, before a byte is inflated: a part whose stream is spoilt is still "too large", not "damaged"', () => {
      const name = 'xl/worksheets/sheet1.xml';
      const spoilt = Buffer.from(writeZip([{ name, data: randomBytes(MB8 + 1024) }]));
      spoilt.fill(0xff, 30 + name.length, 30 + name.length + 64); // the first bytes of the deflate stream
      expectRefusal(() => readXlsx(spoilt), /större än 8 MB uppackad/);
      expect(() => readZip(spoilt)).toThrow(/skadad/); // the generic limits would have started to inflate it
    });

    it('refuses parts that are each small enough and together are not', () => {
      const bytes = writeZip(['a', 'b', 'c'].map((letter) => ({ name: `xl/${letter}.bin`, data: randomBytes(3 * 1024 * 1024) })));
      expectRefusal(() => readXlsx(bytes), /Zip-filen är större än 8 MB uppackad/);
    });
  });

  describe('what a refusal quotes of the file: a line, never the whole of it, never a personnummer', () => {
    const PNR = '19800101-1234';

    it('names a part or a target in at most 40 characters, redacted', () => {
      const long = readXlsx.bind(null, pkg({ workbookRels: WORKBOOK_RELS(`worksheets/${'n'.repeat(5000)}.xml`) }));
      expectRefusal(long, /^Excel-filen saknar kalkylbladet xl\/worksheets\/n{26}…\.$/);
      const numbered = readXlsx.bind(null, pkg({ workbookRels: WORKBOOK_RELS(`worksheets/${PNR}.xml`) }));
      expectRefusal(numbered, /^Excel-filen saknar kalkylbladet xl\/worksheets\/\[personnummer\]\.xml\.$/);
    });

    it('names a cell reference the same way', () => {
      const missing = (reference: string): Buffer => pkg({ sheet: sheetXml(`<row r="1"><c r="${reference}" t="s"><v>99</v></c></row>`), shared: EXCEL_SHARED });
      expectRefusal(() => readXlsx(missing(`X${'1'.repeat(5000)}`)), /^Cell X1{39}… pekar på en text som inte finns i filen\.$/);
      expectRefusal(() => readXlsx(missing(`X${PNR}`)), /^Cell X\[personnummer\] pekar/);
      const tooLong = sheetXml(`<row r="1"><c r="Y${PNR}" t="inlineStr"><is><t>${'x'.repeat(XLSX_MAX_CELL_CHARS + 1)}</t></is></c></row>`);
      expectRefusal(() => readXlsx(pkg({ sheet: tooLong })), /^Cell Y\[personnummer\] har 32768 tecken; högst 32767 läses\.$/);
    });

    it('cuts the words of zip.ts and xml.ts that name a part or an element of the file, at 200 characters', () => {
      const zipName = `xl/${PNR}-${'n'.repeat(300)}.xml`;
      const zipped = writeZip([{ name: zipName, data: randomBytes(8 * 1024 * 1024 + 1) }]);
      expect(() => readXlsx(zipped)).toThrow(XlsxError);
      const zipMessage = (() => { try { readXlsx(zipped); } catch (error) { return (error as Error).message; } return ''; })();
      expect(zipMessage).toMatch(/^Filen går inte att läsa som en Excel-arbetsbok \(\.xlsx\): Posten "xl\/\[personnummer\]-n+…$/);
      expect(zipMessage.length).toBeLessThan(280);

      const element = `a${PNR}${'z'.repeat(5000)}`;
      const xmlMessage = (() => { try { readXlsx(pkg({ sheet: `${DECL}<worksheet xmlns="${MAIN}"><sheetData></${element}></worksheet>` })); } catch (error) { return (error as Error).message; } return ''; })();
      expect(xmlMessage).toMatch(/^Delen xl\/worksheets\/sheet1\.xml i Excel-filen är inte giltig XML: Sluttaggen <\/a\[personnummer\]z+…$/);
      expect(xmlMessage.length).toBeLessThan(280);
    });
  });

  it('refuses a zip that is not a workbook', () => {
    expectRefusal(() => readXlsx(writeZip([{ name: 'notes.txt', data: Buffer.from('hej') }])), /arbetsboken \(xl\/workbook\.xml\) saknas/);
    expectRefusal(() => readXlsx(pkg({ workbookXml: `${DECL}<html/>` })), /arbetsboken har fel rotelement/);
    expectRefusal(() => readXlsx(pkg({ sheet: `${DECL}<html/>` })), /kalkylbladet har fel rotelement/);
  });

  it('refuses a workbook with no worksheet, or whose worksheet part is missing', () => {
    expectRefusal(() => readXlsx(pkg({ workbookXml: `${DECL}<workbook xmlns="${MAIN}"/>` })), /inget kalkylblad/);
    expectRefusal(() => readXlsx(pkg({ sheets: '<sheet name="Diagram" sheetId="3" r:id="rId9"/>' })), /inget kalkylblad/);
    expectRefusal(() => readXlsx(pkg({ workbookRels: WORKBOOK_RELS('worksheets/saknas.xml') })), /saknar kalkylbladet xl\/worksheets\/saknas\.xml/);
  });

  it('refuses XML that is not well formed, and a DOCTYPE', () => {
    expectRefusal(() => readXlsx(pkg({ sheet: `${DECL}<worksheet xmlns="${MAIN}"><sheetData><row></sheetData></worksheet>` })), /xl\/worksheets\/sheet1\.xml i Excel-filen är inte giltig XML/);
    expectRefusal(() => readXlsx(pkg({ sheet: `${DECL}<!DOCTYPE worksheet [<!ENTITY x "y">]><worksheet xmlns="${MAIN}"/>` })), /DOCTYPE/);
    expectRefusal(() => readXlsx(pkg({ styles: `${DECL}<styleSheet` })), /styles i Excel-filen är inte giltig XML/);
    expectRefusal(() => readXlsx(pkg({ shared: `${DECL}<sst>&bogus;</sst>` })), /sharedStrings/);
  });

  it('refuses a shared-string index that points nowhere', () => {
    const rows = '<row r="1"><c r="A1" t="s"><v>99</v></c></row>';
    expectRefusal(() => readXlsx(pkg({ sheet: sheetXml(rows), shared: EXCEL_SHARED })), /Cell A1 pekar på en text som inte finns/);
    expectRefusal(() => readXlsx(pkg({ sheet: sheetXml('<row r="1"><c r="A1" t="s"><v>abc</v></c></row>'), shared: null })), /pekar på en text/);
  });

  it('refuses data below row 20 000 but ignores formatting there', () => {
    const at20000 = sheetXml(`<row r="20000">${inline('A20000', 'sist')}</row>`);
    expect(readXlsx(pkg({ sheet: at20000 })).rows).toHaveLength(20000);
    expectRefusal(() => readXlsx(pkg({ sheet: sheetXml(`<row r="20001">${inline('A20001', 'x')}</row>`) })), /rad 20001; högst 20000/);
    expect(readXlsx(pkg({ sheet: sheetXml('<row r="20001"><c r="A20001" s="1"/></row>') })).rows).toEqual([]);
  });

  it('refuses data right of column 64 but ignores formatting there', () => {
    expect(readXlsx(pkg({ sheet: sheetXml(`<row r="1">${inline('BL1', 'x')}</row>`) })).rows[0]).toHaveLength(64);
    expectRefusal(() => readXlsx(pkg({ sheet: sheetXml(`<row r="1">${inline('BM1', 'x')}</row>`) })), /kolumn BM; högst 64/);
    expect(readXlsx(pkg({ sheet: sheetXml('<row r="1"><c r="XFD1" s="1"/></row>') })).rows).toEqual([]);
  });

  it('refuses a cell of more than 32 767 characters', () => {
    const cell = (length: number): string => sheetXml(`<row r="1">${inline('A1', 'x'.repeat(length))}</row>`);
    expect(readXlsx(pkg({ sheet: cell(XLSX_MAX_CELL_CHARS) })).rows[0]![0]).toHaveLength(XLSX_MAX_CELL_CHARS);
    expectRefusal(() => readXlsx(pkg({ sheet: cell(XLSX_MAX_CELL_CHARS + 1) })), /Cell A1 har 32768 tecken; högst 32767/);
  });
});

// ---------------------------------------------------------------------------
// The writer
// ---------------------------------------------------------------------------

describe('writeXlsx: the package', () => {
  const rows = [
    ['Klass/grupp', 'Ämne', 'Start'],
    ['1A', 'Matematik', '08:10'],
    ['1A', 'Svenska', '09:00'],
  ];
  const bytes = writeXlsx(rows, { sheetName: 'Schema' });
  const parts = partsOf(bytes);

  it('holds the parts Excel needs, in the conventional order, each well-formed XML', () => {
    expect([...readZip(bytes).keys()]).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/sharedStrings.xml',
      'xl/worksheets/sheet1.xml',
    ]);
    expect(parts.size).toBe(7);
  });

  it('declares every part in the content types and relates the workbook to its three parts', () => {
    const types = parts.get('[Content_Types].xml')!;
    const overrides = childrenNamed(types, 'Override').map((node) => node.attrs['PartName']);
    expect(overrides).toEqual(['/xl/workbook.xml', '/xl/worksheets/sheet1.xml', '/xl/styles.xml', '/xl/sharedStrings.xml']);
    const targets = childrenNamed(parts.get('xl/_rels/workbook.xml.rels')!, 'Relationship').map((node) => [node.attrs['Id'], node.attrs['Target']]);
    expect(targets).toEqual([
      ['rId1', 'worksheets/sheet1.xml'],
      ['rId2', 'styles.xml'],
      ['rId3', 'sharedStrings.xml'],
    ]);
    expect(childNamed(parts.get('_rels/.rels')!, 'Relationship')!.attrs['Target']).toBe('xl/workbook.xml');
  });

  it('names the sheet and defines the autofilter range, so Excel need not repair the filter', () => {
    const book = parts.get('xl/workbook.xml')!;
    expect(childNamed(childNamed(book, 'sheets')!, 'sheet')!.attrs['name']).toBe('Schema');
    const defined = childNamed(childNamed(book, 'definedNames')!, 'definedName')!;
    expect(defined.attrs).toMatchObject({ name: '_xlnm._FilterDatabase', localSheetId: '0', hidden: '1' });
    expect(defined.text).toBe("'Schema'!$A$1:$C$3");
  });

  it('writes a bold header on a grey fill, frozen, filtered, with text-formatted cells and columns', () => {
    const styles = parts.get('xl/styles.xml')!;
    const xfs = childrenNamed(childNamed(styles, 'cellXfs')!, 'xf');
    expect(xfs.map((xf) => xf.attrs['numFmtId'])).toEqual(['0', '49', '49']);
    expect(xfs[1]!.attrs['fontId']).toBe('1');
    expect(childNamed(childNamed(childNamed(styles, 'fonts')!, 'font')!, 'b')).toBeNull();
    expect(childNamed(childrenNamed(childNamed(styles, 'fonts')!, 'font')[1]!, 'b')).not.toBeNull();

    const sheet = parts.get('xl/worksheets/sheet1.xml')!;
    expect(childNamed(sheet, 'dimension')!.attrs['ref']).toBe('A1:C3');
    expect(childNamed(sheet, 'autoFilter')!.attrs['ref']).toBe('A1:C3');
    const pane = childNamed(childNamed(childNamed(sheet, 'sheetViews')!, 'sheetView')!, 'pane')!;
    expect(pane.attrs).toMatchObject({ ySplit: '1', topLeftCell: 'A2', state: 'frozen' });
    const cells = childrenNamed(childNamed(sheet, 'sheetData')!, 'row').flatMap((row) => childrenNamed(row, 'c'));
    expect(cells.map((c) => c.attrs['t'])).toEqual(new Array(9).fill('s'));
    expect(cells.slice(0, 3).map((c) => c.attrs['s'])).toEqual(['1', '1', '1']);
    expect(cells.slice(3).map((c) => c.attrs['s'])).toEqual(new Array(6).fill('2'));
    for (const col of childrenNamed(childNamed(sheet, 'cols')!, 'col')) expect(col.attrs['style']).toBe('2');
  });

  it('keeps strings once in the shared table, with the counts', () => {
    const table = parts.get('xl/sharedStrings.xml')!;
    expect(table.attrs).toMatchObject({ count: '9', uniqueCount: '8' }); // "1A" is written twice, stored once
    expect(childrenNamed(table, 'si').map((si) => childNamed(si, 't')!.text)).toEqual(['Klass/grupp', 'Ämne', 'Start', '1A', 'Matematik', '08:10', 'Svenska', '09:00']);
  });

  it('is deterministic: the same table is the same bytes', () => {
    expect(writeXlsx(rows, { sheetName: 'Schema' }).equals(bytes)).toBe(true);
  });

  it('leaves out the freeze when told to', () => {
    const sheet = partsOf(writeXlsx(rows, { sheetName: 'Schema', frozenHeader: false })).get('xl/worksheets/sheet1.xml')!;
    expect(childNamed(childNamed(childNamed(sheet, 'sheetViews')!, 'sheetView')!, 'pane')).toBeNull();
  });

  it('uses the widths it is given, and measures a column when the width is missing or unusable', () => {
    const wide = writeXlsx([['a', 'b', 'c', 'd', 'e', 'f'], ['x'.repeat(20), '', 'y'.repeat(100), 'z', 'w', 'v']], {
      sheetName: 'S',
      widths: [30, 12.345, Number.NaN, -3, 1000],
    });
    const cols = childrenNamed(childNamed(partsOf(wide).get('xl/worksheets/sheet1.xml')!, 'cols')!, 'col');
    // given 30; given 12.345 (kept to two decimals); NaN -> measured (100 characters, capped at 60); -3 -> measured 8; 1000 -> 255; no entry -> measured 8
    expect(cols.map((col) => col.attrs['width'])).toEqual(['30', '12.35', '60', '8', '255', '8']);
  });

  it('measures width from the longest line of a multi-line cell', () => {
    const cols = childrenNamed(childNamed(partsOf(writeXlsx([['abc\nabcdefghijklmnop']], { sheetName: 'S' })).get('xl/worksheets/sheet1.xml')!, 'cols')!, 'col');
    expect(cols[0]!.attrs['width']).toBe('18');
  });

  it('cleans a sheet name Excel would refuse', () => {
    const name = (raw: string): string => childNamed(childNamed(partsOf(writeXlsx([['a']], { sheetName: raw })).get('xl/workbook.xml')!, 'sheets')!, 'sheet')!.attrs['name']!;
    expect(name('Sch:ema/[x]?*\\y')).toBe('Sch ema  x    y');
    expect(name('x'.repeat(40))).toHaveLength(31);
    expect(name("'Schema'")).toBe('Schema');
    expect(name('')).toBe('Blad1');
    expect(name('   ')).toBe('Blad1');
    expect(name("A'B")).toBe("A'B");
    // The apostrophe in the defined name is doubled.
    const defined = childNamed(childNamed(partsOf(writeXlsx([['a']], { sheetName: "A'B" })).get('xl/workbook.xml')!, 'definedNames')!, 'definedName')!;
    expect(defined.text).toBe("'A''B'!$A$1:$A$1");
  });

  it('writes an empty table as a valid, empty sheet', () => {
    for (const empty of [[], [[]], [[], []]]) {
      const sheet = partsOf(writeXlsx(empty, { sheetName: 'Tom' }));
      expect(childNamed(sheet.get('xl/worksheets/sheet1.xml')!, 'autoFilter')).toBeNull();
      expect(childNamed(sheet.get('xl/worksheets/sheet1.xml')!, 'cols')).toBeNull();
      expect(childNamed(sheet.get('xl/workbook.xml')!, 'definedNames')).toBeNull();
      expect(readXlsx(writeXlsx(empty, { sheetName: 'Tom' })).rows).toEqual([]);
    }
  });
});

describe('writeXlsx and readXlsx: every cell is text and comes back as written', () => {
  const read = (rows: string[][]): string[][] => readXlsx(writeXlsx(rows, { sheetName: 'Schema' })).rows;

  it('keeps times, dates, ids and anything that looks like a number or a formula', () => {
    const rows = [
      ['Id', 'Start', 'Datum', 'Signatur', 'Namn'],
      ['007', '08:10', '2026-08-17', '1E3', '=HYPERLINK("http://evil.example/")'],
      ['0123456789', '8.10', '17/8/2026', '+1+1', '-5'],
      ['1.50', '00:00', '0810', "'=x", '@SUM(A1)'],
    ];
    expect(read(rows)).toEqual(rows);
  });

  it('keeps unicode, markup, quotes, line breaks, tabs, leading and trailing spaces', () => {
    const rows = [['Åsa Öberg 😀', '<a href="x">&amp;</a>', "it's \"quoted\"", 'rad ett\nrad två', 'tab\there', '  space  ', 'cr\rcr']];
    expect(read(rows)).toEqual(rows);
  });

  it('drops only what XML 1.0 cannot hold: control characters, U+FFFE, lone surrogates', () => {
    expect(read([['a\u0001b\u0008c￾d\ud800e\udc00f😀']])).toEqual([['abcdef😀']]);
  });

  it('keeps positions: empty cells, empty rows, and a short row padded to the table', () => {
    const rows = [['a', '', 'c'], [], ['', 'e'], ['f', 'g', 'h', 'i']];
    expect(read(rows)).toEqual([
      ['a', '', 'c', ''],
      ['', '', '', ''],
      ['', 'e', '', ''],
      ['f', 'g', 'h', 'i'],
    ]);
  });

  it('writes a header-only table, and a table of identical rows', () => {
    expect(read([['a', 'b']])).toEqual([['a', 'b']]);
    const same = new Array(300).fill(['x', 'y', 'z']);
    expect(read(same)).toEqual(same);
  });

  it('takes the most it promises: 20 000 rows, 64 columns, a 32 767-character cell', () => {
    const tall = Array.from({ length: 20000 }, (_v, i) => [`r${i}`]);
    expect(read(tall)).toEqual(tall);
    const wide = [Array.from({ length: 64 }, (_v, i) => `c${i}`)];
    expect(read(wide)).toEqual(wide);
    const long = [['x'.repeat(XLSX_MAX_CELL_CHARS)]];
    expect(read(long)).toEqual(long);
  });

  it('refuses a sheet with more cells than the XML reader will count, and takes the largest real table (5 000 lessons of 28 columns)', () => {
    const grid = (rows: number, columns: number): string[][] => Array.from({ length: rows }, (_v, r) => Array.from({ length: columns }, (_w, c) => `${r}-${c}`));
    expectRefusal(() => writeXlsx(grid(7000, 30), { sheetName: 'S' }), /210000 ifyllda celler; fler än ungefär 199968/);
    // 5 000 lessons of 28 columns whose text repeats the way a timetable's does (a group, a subject, a teacher
    // is on many rows): about 6 MB unpacked, inside the 8 MB the reader takes. (Every cell a text of its own
    // is 14 MB: see the size limits below.)
    const repeating = Array.from({ length: 5000 }, (_v, r) => Array.from({ length: 28 }, (_w, c) => `${c}-${r % 150}`));
    expect(read(repeating)).toEqual(repeating);
  });

  it('refuses to write what it could not read back', () => {
    expectRefusal(() => writeXlsx(new Array(20001).fill(['x']), { sheetName: 'S' }), /20001 rader/);
    expectRefusal(() => writeXlsx([new Array(65).fill('x')], { sheetName: 'S' }), /65 kolumner/);
    expectRefusal(() => writeXlsx([['a', 'x'.repeat(XLSX_MAX_CELL_CHARS + 1)]], { sheetName: 'S' }), /rad 1, kolumn 2 har 32768 tecken/);
  });

  it('refuses a table that would unpack to more than the reader takes, in plain words, and writes one just under it', () => {
    // 384 cells of 30 000 characters, each its own text (random, so that the zip is not refused as a bomb
    // on the way back): 11 MB of shared strings from a table of 384 cells.
    const heavy = Array.from({ length: 6 }, () => Array.from({ length: 64 }, () => randomBytes(15_000).toString('hex')));
    expectRefusal(() => writeXlsx(heavy, { sheetName: 'S' }), /^Tabellen blir \d+(\.\d)? MB uppackad i en Excel-fil; högst 8 MB ryms\. Dela upp den eller använd CSV\.$/);
    const light = heavy.slice(0, 2);
    expect(readXlsx(writeXlsx(light, { sheetName: 'S' })).rows).toEqual(light);
  });
});
