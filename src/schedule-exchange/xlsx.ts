/**
 * A minimal Excel (.xlsx) writer and reader for the flat timetable, on zip.ts
 * and xml.ts. An .xlsx is a zip of XML parts; the table needs one sheet of
 * text, so this is a few hundred lines instead of a dependency whose parser
 * brings entity expansion, formula engines and a history of advisories.
 *
 * WRITER. `writeXlsx` produces the smallest package Excel, LibreOffice and
 * Numbers open without a repair prompt:
 *
 *   [Content_Types].xml, _rels/.rels, xl/workbook.xml,
 *   xl/_rels/workbook.xml.rels, xl/styles.xml, xl/sharedStrings.xml,
 *   xl/worksheets/sheet1.xml
 *
 *   SHARED STRINGS, not inline strings. Inline strings (`t="inlineStr"`) are
 *   legal and simpler, but shared strings are the form every spreadsheet
 *   program writes and the one every reader (Numbers among them) is tested
 *   against; they also shrink a timetable, where a class name or "Ja" repeats
 *   in thousands of rows, to a fraction. The reader below takes both.
 *
 *   EVERY CELL IS TEXT. A cell is written as a shared string (`t="s"`) with a
 *   cell format whose number format is Text (numFmtId 49, "@"), and the same
 *   format is the default of the whole column (`<col style>`), so that a school
 *   user who types into an empty cell of the table gets text too. A time
 *   "08:10" stays "08:10" and is not turned into 0.340277…; a date
 *   "2026-08-17" stays a string; an id "007" or a signature "1E3" keeps its
 *   zeros and does not become 1000. A formula-looking cell ("=1+1") is a string
 *   and is never evaluated, which is why xlsx needs no formula guard (csv.ts
 *   does).
 *
 *   The header row is bold on a light fill, frozen (unless `frozenHeader` is
 *   false) and carries an autofilter; the autofilter's hidden defined name
 *   (_xlnm._FilterDatabase) is written too, because Excel itself writes it and
 *   a filter without it is repaired by some versions. Column widths come from
 *   `widths` or, when not given, from the longest line in the column.
 *
 *   The writer refuses what the reader would refuse (more than 20 000 rows, 64
 *   columns, a cell of more than 32 767 characters, a sheet with more cells than
 *   xml.ts will parse: see the end of this comment, a package that unpacks to
 *   more than the reader's size limits: see REFUSALS), so that no file leaves
 *   Rastra that cannot come back.
 *
 * READER. `readXlsx` returns the FIRST WORKSHEET in workbook order as a
 * rectangular grid of strings, plus its name. It reads what Excel, LibreOffice
 * and Numbers write, not only what the writer above does:
 *
 *   - shared strings (including rich-text runs, and with the phonetic runs
 *     left out), inline strings, `t="str"` formula results, booleans (as TRUE
 *     or FALSE, what Excel shows), error values (as written, "#N/A") and
 *     numbers; the `_x000D_`-style escapes Excel uses for control characters
 *     are decoded;
 *   - formulas: the cached `<v>` is returned and nothing is evaluated;
 *   - cell references (A1 style) place every cell, so skipped cells and rows
 *     with gaps still line up; a cell without a reference follows the one
 *     before it. Row n of the result is row n of the sheet, as the user sees
 *     it in Excel, so the table reader's "rad N" is the Excel row. Columns are
 *     likewise absolute (a table starting in column B has an empty column 0).
 *     Trailing empty rows are not part of the result and every row is padded
 *     to the width of the widest one; empty rows in between are rows of empty
 *     strings;
 *   - numbers are returned as STORED (the text of `<v>`): no "1E+3", no float
 *     noise from reformatting. The exception is a number with a DATE or TIME
 *     cell format, which Excel saved as a serial number and which would
 *     otherwise reach the table reader as 46251 and 0.3402777…: see below.
 *
 *   DATES AND TIMES. A numeric cell is date-like when its style (xl/styles.xml
 *   cellXfs, by `s`) has a built-in date/time number format (ids 14-22 and
 *   45-47) or a custom format code that contains d, m, y, h or s outside
 *   quotes, backslash escapes, `_x`/`*x` padding and the non-elapsed
 *   `[...]` sections (colour, locale, condition); `[h]`, `[m]` and `[s]`
 *   count. What is returned depends on the VALUE, not on the format's name,
 *   because that is how a user thinks of it:
 *     - a serial below 1 is a time of day: 'HH:MM' (seconds dropped; the
 *       fraction is rounded to the nearest SECOND first, because 08:10 is
 *       490.0000000000001 or 489.99999999999994 minutes depending on how it
 *       was typed);
 *     - a whole serial is a date: 'YYYY-MM-DD';
 *     - a serial with both is 'YYYY-MM-DD HH:MM'.
 *   The 1900 system has Excel's bug of a 29 February 1900 that never was:
 *   serial 60 is returned as '1900-02-29' (what Excel shows) and every serial
 *   after it counts from 1899-12-30, so serial 61 is 1900-03-01 and 46251 is
 *   2026-08-17. `<workbookPr date1904="1">` switches to the 1904 system
 *   (serial 0 is 1904-01-01). A date-styled cell whose value is negative, not
 *   a number or beyond year 9999 is returned as stored. A duration format
 *   ([h]:mm) holding more than 24 hours is read as a date, not as hours: no
 *   timetable has one.
 *
 *   MERGED CELLS are not expanded (the value is in the top-left cell, as
 *   stored); hidden rows and columns are read like any other.
 *
 * REFUSALS, all XlsxError with a Swedish message the caller can show: a
 * password-protected workbook and a legacy .xls (both are OLE2 compound files,
 * D0 CF 11 E0; an encrypted OOXML workbook is wrapped in one, and its
 * "EncryptedPackage" stream tells the two apart), anything that is not a zip
 * (zip.ts's refusals pass through: more than 64 entries, 200:1 compression, …;
 * and the size: EXCHANGE_ZIP_LIMITS, 8 MB a part and 8 MB in all, checked from
 * the zip's own directory BEFORE anything is unpacked, so that a zip of a few
 * hundred kilobytes that unpacks to tens of megabytes costs nothing), a
 * package with no workbook or no worksheet, XML that is not well formed or has
 * a DOCTYPE (xml.ts), more than 20 000 rows, more than 64 columns or a cell of
 * more than 32 767 characters (Excel's own cell limit). Rows and columns are
 * limited by what is in them: styled but empty cells beyond the limits (a
 * whole formatted column) do not count.
 *
 * WHAT A REFUSAL MAY QUOTE. The package is a stranger's, and so is every name in
 * it: an entry, a relationship target, a cell reference, an element in the XML
 * that xml.ts complains about. A refusal names them through `shown`: redacted
 * for personnummer (a part may be called 19800101-1234.xml), on one line, and
 * cut, so that one message is never longer than a line (a part name may be
 * 65 535 characters, a relationship target as long as the part). The numbers
 * in a refusal are counts, never text from the file.
 *
 * ONE LIMIT IS xml.ts's, NOT OURS: its parser accepts at most MAX_NODES
 * (400 000) elements per part. A cell is two elements (`<c><v>`) and a row one,
 * so a sheet of about 195 000 filled cells is the most that can be read. The
 * table is at most 5 000 lessons of 28 columns (140 000 cells), well inside it;
 * a sheet over it is refused by the reader with xml.ts's "För många element"
 * and by the writer, before writing, in plain words. (The shared-strings part
 * has two elements per DISTINCT string, never more than the cells, so the same
 * bound covers it.)
 */

import { EXCHANGE_ZIP_LIMITS } from './exchange-model';
import { MAX_QUOTE, redactPersonalNumbers } from './file-safety';
import { childNamed, childrenNamed, element, escapeXml, MAX_NODES, parseXml, type XmlNode } from './xml';
import { readZip, writeZip } from './zip';

export class XlsxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XlsxError';
  }
}

/** The longest a message quotes a name from the file, and the longest it quotes a message of zip.ts or xml.ts. */
const MAX_INNER_MESSAGE = 200;

/**
 * Text of the file as a refusal shows it: personnummer redacted FIRST (so that
 * a number is not cut in two and shown in half), on one line, cut to `most`
 * characters. No quotation marks: it is a name, a path or a sentence, not a
 * value (a value is quoted with excerpt() in the table reader).
 */
function shown(text: string, most = MAX_QUOTE): string {
  const flat = redactPersonalNumbers(text).replace(/\s+/g, ' ').trim();
  return flat.length > most ? `${flat.slice(0, most)}…` : flat;
}

export const XLSX_MAX_ROWS = 20_000;
export const XLSX_MAX_COLUMNS = 64;
/** Excel's own limit on the text of one cell. */
export const XLSX_MAX_CELL_CHARS = 32_767;

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PACKAGE_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const NS_CONTENT_TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types';
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** cellXfs indexes in the styles part written below. */
const STYLE_HEADER = 1;
const STYLE_TEXT = 2;
/** Only in a package that has number columns (WriteXlsxOptions.numberColumns): a whole number, and two decimals. */
const STYLE_INTEGER = 3;
const STYLE_DECIMAL = 4;

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

export interface WriteXlsxOptions {
  /** Worksheet name; characters Excel forbids are replaced and it is cut to 31 characters. */
  sheetName: string;
  /** Column widths in characters; a missing or invalid entry is measured from the column's content. */
  widths?: number[];
  /** Freeze the first row (default true). */
  frozenHeader?: boolean;
  /**
   * Columns (0-based) whose cells below the header are numbers, not text: a cell that is a plain number
   * ("12", "-3", "12.5", a point for the decimals whatever the reader's language) is written as a number
   * with the column's format, so that a payroll file sums. A cell of such a column that is not a plain
   * number stays text, and the header row is always text. Without this option every cell is text, as
   * the module comment says, and the package is the one it has always been.
   */
  numberColumns?: Readonly<Record<number, 'integer' | 'decimal'>>;
}

/** A number as Excel stores it: optional minus, digits, an optional point and digits. */
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

/** 1 -> A, 26 -> Z, 27 -> AA. */
function columnName(column: number): string {
  let name = '';
  for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/**
 * Text for an XML text node. escapeXml drops the control characters XML 1.0
 * cannot hold; on top of that: U+FFFE/U+FFFF and lone surrogates are not XML
 * characters either (Excel would "repair" the file), and a CR must be a
 * character reference or a parser folds it into a LF.
 */
function xmlText(value: string): string {
  return escapeXml(value)
    .replace(/[￾￿]/g, '')
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '')
    .replace(/\r/g, '&#13;');
}

/** Excel's rules for a sheet name: 1-31 characters, none of \ / ? * [ ] :, no apostrophe at either end. */
function sheetNameOf(raw: string): string {
  const name = raw
    .replace(/[\\/?*[\]:]/g, ' ')
    .trim()
    .slice(0, 31)
    .replace(/^'+|'+$/g, '')
    .trim();
  return name === '' ? 'Blad1' : name;
}

function stylesXml(withNumbers: boolean): string {
  const font = (bold: boolean): string => `<font>${bold ? '<b/>' : ''}<sz val="11"/><name val="Calibri"/><family val="2"/></font>`;
  const xf = (fontId: number, fillId: number): string =>
    `<xf numFmtId="49" fontId="${fontId}" fillId="${fillId}" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>`;
  return (
    XML_DECLARATION +
    `<styleSheet xmlns="${NS_MAIN}">` +
    `<fonts count="2">${font(false)}${font(true)}</fonts>` +
    '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFE7EAF0"/><bgColor indexed="64"/></patternFill></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    // 0 = Excel's default; 1 = header (bold, grey, text); 2 = a data cell (text).
    (withNumbers
      ? // 3 = a whole number ("0"), 4 = two decimals ("0.00"): the number columns of a table.
        `<cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>${xf(1, 2)}${xf(0, 0)}` +
        '<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
        '<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>'
      : `<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>${xf(1, 2)}${xf(0, 0)}</cellXfs>`) +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>'
  );
}

/** The widest line of the column's cells, in characters plus a little air, within what is readable. */
function measuredWidth(rows: string[][], column: number): number {
  let longest = 0;
  for (const row of rows) {
    const cell = row[column];
    if (cell === undefined) continue;
    for (const line of cell.split('\n')) longest = Math.max(longest, line.length);
  }
  return Math.min(60, Math.max(8, longest + 2));
}

export function writeXlsx(rows: string[][], options: WriteXlsxOptions): Buffer {
  if (rows.length > XLSX_MAX_ROWS) {
    throw new XlsxError(`Tabellen har ${rows.length} rader; högst ${XLSX_MAX_ROWS} ryms i en Excel-fil från Rastra.`);
  }
  const columnCount = rows.reduce((widest, row) => Math.max(widest, row.length), 0);
  if (columnCount > XLSX_MAX_COLUMNS) {
    throw new XlsxError(`Tabellen har ${columnCount} kolumner; högst ${XLSX_MAX_COLUMNS} ryms i en Excel-fil från Rastra.`);
  }
  const strings = new Map<string, number>();
  let stringCells = 0;
  let numberCells = 0;
  const numberColumns = options.numberColumns ?? {};
  const sheetRows: string[] = [];
  rows.forEach((row, rowIndex) => {
    const cells: string[] = [];
    row.forEach((text, columnIndex) => {
      if (text === '') return; // an absent cell is an empty cell, and the column's own format applies
      if (text.length > XLSX_MAX_CELL_CHARS) {
        throw new XlsxError(`Cellen på rad ${rowIndex + 1}, kolumn ${columnIndex + 1} har ${text.length} tecken; högst ${XLSX_MAX_CELL_CHARS} ryms i en Excel-cell.`);
      }
      const numberKind = rowIndex > 0 ? numberColumns[columnIndex] : undefined;
      if (numberKind !== undefined && PLAIN_NUMBER.test(text)) {
        numberCells += 1;
        cells.push(
          `<c r="${columnName(columnIndex + 1)}${rowIndex + 1}" s="${numberKind === 'integer' ? STYLE_INTEGER : STYLE_DECIMAL}"><v>${text}</v></c>`,
        );
        return;
      }
      let index = strings.get(text);
      if (index === undefined) {
        index = strings.size;
        strings.set(text, index);
      }
      stringCells += 1;
      const style = rowIndex === 0 ? STYLE_HEADER : STYLE_TEXT;
      cells.push(`<c r="${columnName(columnIndex + 1)}${rowIndex + 1}" s="${style}" t="s"><v>${index}</v></c>`);
    });
    if (cells.length > 0) sheetRows.push(`<row r="${rowIndex + 1}">${cells.join('')}</row>`);
  });

  // What xml.ts will count when this sheet is read back: two elements per cell, one per row, the column
  // definitions and a few dozen fixed ones. Refused here, in plain words, rather than written and then
  // rejected by our own reader as "För många element".
  const elements = 2 * (stringCells + numberCells) + sheetRows.length + columnCount + 64;
  if (elements > MAX_NODES) {
    throw new XlsxError(`Tabellen har ${stringCells + numberCells} ifyllda celler; fler än ungefär ${Math.floor((MAX_NODES - 64) / 2)} ryms inte i en Excel-fil från Rastra. Dela upp den eller använd CSV.`);
  }

  const name = sheetNameOf(options.sheetName);
  const lastCell = columnCount > 0 && rows.length > 0 ? `${columnName(columnCount)}${rows.length}` : 'A1';
  const range = columnCount > 0 && rows.length > 0 ? `A1:${lastCell}` : 'A1';
  const frozen = options.frozenHeader ?? true;

  const columns: string[] = [];
  for (let column = 0; column < columnCount; column += 1) {
    const given = options.widths?.[column];
    const width = given !== undefined && Number.isFinite(given) && given > 0 ? Math.min(255, given) : measuredWidth(rows, column);
    const kind = numberColumns[column];
    const style = kind === undefined ? STYLE_TEXT : kind === 'integer' ? STYLE_INTEGER : STYLE_DECIMAL;
    columns.push(`<col min="${column + 1}" max="${column + 1}" width="${Number(width.toFixed(2))}" style="${style}" customWidth="1"/>`);
  }

  const view = frozen
    ? '<sheetView tabSelected="1" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
      '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView>'
    : '<sheetView tabSelected="1" workbookViewId="0"><selection activeCell="A1" sqref="A1"/></sheetView>';

  const sheet =
    XML_DECLARATION +
    `<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
    `<dimension ref="${range}"/>` +
    `<sheetViews>${view}</sheetViews>` +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    (columns.length > 0 ? `<cols>${columns.join('')}</cols>` : '') +
    `<sheetData>${sheetRows.join('')}</sheetData>` +
    (columnCount > 0 && rows.length > 0 ? `<autoFilter ref="${range}"/>` : '') +
    '</worksheet>';

  const sharedStrings =
    XML_DECLARATION +
    `<sst xmlns="${NS_MAIN}" count="${stringCells}" uniqueCount="${strings.size}">` +
    [...strings.keys()].map((text) => `<si><t xml:space="preserve">${xmlText(text)}</t></si>`).join('') +
    '</sst>';

  const filterName =
    columnCount > 0 && rows.length > 0
      ? element('definedNames', {}, [
          `<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${xmlText(name.replace(/'/g, "''"))}'!$A$1:$${columnName(columnCount)}$${rows.length}</definedName>`,
        ])
      : '';
  const workbook =
    XML_DECLARATION +
    `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
    '<workbookPr/>' +
    '<bookViews><workbookView/></bookViews>' +
    `<sheets><sheet name="${xmlText(name)}" sheetId="1" r:id="rId1"/></sheets>` +
    filterName +
    '</workbook>';

  const relationship = (id: string, type: string, target: string): string =>
    element('Relationship', { Id: id, Type: `${NS_REL}/${type}`, Target: target });
  const workbookRels =
    XML_DECLARATION +
    element('Relationships', { xmlns: NS_PACKAGE_REL }, [
      relationship('rId1', 'worksheet', 'worksheets/sheet1.xml'),
      relationship('rId2', 'styles', 'styles.xml'),
      relationship('rId3', 'sharedStrings', 'sharedStrings.xml'),
    ]);
  const rootRels =
    XML_DECLARATION + element('Relationships', { xmlns: NS_PACKAGE_REL }, [relationship('rId1', 'officeDocument', 'xl/workbook.xml')]);

  const sheetType = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
  const contentTypes =
    XML_DECLARATION +
    element('Types', { xmlns: NS_CONTENT_TYPES }, [
      element('Default', { Extension: 'rels', ContentType: 'application/vnd.openxmlformats-package.relationships+xml' }),
      element('Default', { Extension: 'xml', ContentType: 'application/xml' }),
      element('Override', { PartName: '/xl/workbook.xml', ContentType: `${sheetType}.sheet.main+xml` }),
      element('Override', { PartName: '/xl/worksheets/sheet1.xml', ContentType: `${sheetType}.worksheet+xml` }),
      element('Override', { PartName: '/xl/styles.xml', ContentType: `${sheetType}.styles+xml` }),
      element('Override', { PartName: '/xl/sharedStrings.xml', ContentType: `${sheetType}.sharedStrings+xml` }),
    ]);

  const part = (partName: string, xml: string): { name: string; data: Buffer } => ({ name: partName, data: Buffer.from(xml, 'utf8') });
  const parts = [
    part('[Content_Types].xml', contentTypes),
    part('_rels/.rels', rootRels),
    part('xl/workbook.xml', workbook),
    part('xl/_rels/workbook.xml.rels', workbookRels),
    part('xl/styles.xml', stylesXml(Object.keys(numberColumns).length > 0)),
    part('xl/sharedStrings.xml', sharedStrings),
    part('xl/worksheets/sheet1.xml', sheet),
  ];
  // What readXlsx will unpack: the same limits, so that no file leaves Rastra that the reader would refuse for
  // its size. (A table of 5 000 lessons whose text repeats, as a timetable's does, is about 6 MB; one in which
  // nearly every cell is a text of its own, 14 MB.)
  const unpacked = parts.reduce((sum, { data }) => sum + data.length, 0);
  if (unpacked > EXCHANGE_ZIP_LIMITS.maxTotalBytes || parts.some(({ data }) => data.length > EXCHANGE_ZIP_LIMITS.maxEntryBytes)) {
    const mb = (bytes: number): number => Math.round((bytes / (1024 * 1024)) * 10) / 10;
    throw new XlsxError(
      `Tabellen blir ${mb(unpacked)} MB uppackad i en Excel-fil; högst ${mb(Math.min(EXCHANGE_ZIP_LIMITS.maxEntryBytes, EXCHANGE_ZIP_LIMITS.maxTotalBytes))} MB ryms. Dela upp den eller använd CSV.`,
    );
  }
  return writeZip(parts);
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

export interface ReadXlsxResult {
  rows: string[][];
  sheetName: string;
}

/** The magic of an OLE2 compound file: a legacy .xls, or an OOXML workbook wrapped for its password. */
const OLE2_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]);
const ENCRYPTED_PACKAGE = Buffer.from('EncryptedPackage', 'utf16le');

/** Built-in number formats that are dates or times (ECMA-376 18.8.30). */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/**
 * Whether a custom number format code shows a date or a time: it contains
 * d, m, y, h or s that is not literal. Literal text is what is in double
 * quotes, after a backslash, after `_` (padding) or `*` (fill), or in square
 * brackets - except the elapsed-time sections [h] [m] [s], which are time.
 * A quote or a bracket that never closes makes the code not a date: a format
 * that cannot be read is not guessed at.
 */
export function isDateFormatCode(code: string): boolean {
  for (let i = 0; i < code.length; i += 1) {
    const char = code[i]!;
    if (char === '"') {
      const close = code.indexOf('"', i + 1);
      if (close < 0) return false;
      i = close;
    } else if (char === '\\' || char === '_' || char === '*') {
      i += 1;
    } else if (char === '[') {
      const close = code.indexOf(']', i + 1);
      if (close < 0) return false;
      if (/^(?:h+|m+|s+)$/i.test(code.slice(i + 1, close))) return true;
      i = close;
    } else if (/[dmyhs]/i.test(char)) {
      return true;
    }
  }
  return false;
}

/** Excel writes control characters in strings as _xHHHH_ (and a literal "_x" as _x005F_x). */
function decodeEscapes(text: string): string {
  if (!text.includes('_x')) return text;
  return text.replace(/_x([0-9A-Fa-f]{4})_/g, (_whole, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** The text of a string item (<si> or <is>): its own <t>, and the <t> of its runs; phonetic runs are not text. */
function itemText(item: XmlNode): string {
  let text = '';
  for (const child of item.children) {
    if (child.name === 't') text += child.text;
    else if (child.name === 'r') for (const run of childrenNamed(child, 't')) text += run.text;
  }
  return decodeEscapes(text);
}

function parsePart(bytes: Buffer, part: string): XmlNode {
  try {
    return parseXml(bytes.toString('utf8'));
  } catch (error) {
    throw new XlsxError(`Delen ${shown(part)} i Excel-filen är inte giltig XML: ${shown((error as Error).message, MAX_INNER_MESSAGE)}`);
  }
}

interface Relationship {
  id: string;
  type: string;
  target: string;
}

function relationshipsOf(entries: Map<string, Buffer>, path: string): Relationship[] {
  const bytes = entries.get(path);
  if (bytes === undefined) return [];
  return childrenNamed(parsePart(bytes, path), 'Relationship').map((node) => ({
    id: node.attrs['Id'] ?? '',
    type: node.attrs['Type'] ?? '',
    target: node.attrs['Target'] ?? '',
  }));
}

/** A relationship target as a path in the package: absolute from the root, or relative to the part's folder. */
function resolvePart(folder: string, target: string): string {
  const out: string[] = [];
  for (const segment of (target.startsWith('/') ? target.slice(1) : folder + target).split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return out.join('/');
}

function dateStyles(styles: XmlNode | null): boolean[] {
  if (styles === null) return [];
  const custom = new Map<number, string>();
  const formats = childNamed(styles, 'numFmts');
  for (const format of formats ? childrenNamed(formats, 'numFmt') : []) {
    custom.set(Number(format.attrs['numFmtId']), format.attrs['formatCode'] ?? '');
  }
  const xfs = childNamed(styles, 'cellXfs');
  return (xfs ? childrenNamed(xfs, 'xf') : []).map((xf) => {
    const id = Number(xf.attrs['numFmtId'] ?? '0');
    const code = custom.get(id);
    return code !== undefined ? isDateFormatCode(code) : BUILTIN_DATE_FORMATS.has(id);
  });
}

const DAY_MS = 86_400_000;
/** 9999-12-31 in the 1900 system; anything at or after the next day is not a date this reader makes. */
const SERIAL_LIMIT = 2_958_466;

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * An Excel serial number as ISO text, by value: a time of day below 1, a date
 * when whole, both otherwise. Null when it is not a serial this reader turns
 * into text (the caller then returns the stored string).
 */
export function excelSerialToText(raw: string, date1904: boolean): string | null {
  const serial = Number(raw);
  if (raw === '' || !Number.isFinite(serial) || serial < 0 || serial >= SERIAL_LIMIT) return null;
  // Round to the second before splitting: 08:10 is not exactly 490 minutes in floating point.
  const seconds = Math.round(serial * 86_400);
  if (serial < 1) {
    const clock = Math.min(seconds, 86_399); // 0.99999999 is 23:59, not a midnight that rolls into day 1
    return `${pad2(Math.floor(clock / 3600))}:${pad2(Math.floor((clock % 3600) / 60))}`;
  }
  const days = Math.floor(seconds / 86_400);
  const ofDay = seconds % 86_400;
  let date: string;
  if (!date1904 && days === 60) {
    date = '1900-02-29'; // the day Excel's 1900 system invented
  } else {
    // 1900 system: serials 1-59 count from 1899-12-31, 61 onwards from 1899-12-30 (serial 60 being the invented day).
    const epoch = date1904 ? Date.UTC(1904, 0, 1) : days < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
    const day = new Date(epoch + days * DAY_MS);
    if (day.getUTCFullYear() > 9999) return null;
    date = `${String(day.getUTCFullYear()).padStart(4, '0')}-${pad2(day.getUTCMonth() + 1)}-${pad2(day.getUTCDate())}`;
  }
  if (ofDay === 0) return date;
  return `${date} ${pad2(Math.floor(ofDay / 3600))}:${pad2(Math.floor((ofDay % 3600) / 60))}`;
}

/** 'B' -> 2, 'AA' -> 27; null when the reference does not start with 1-3 letters. */
function columnOfReference(reference: string): number | null {
  const match = /^([A-Za-z]{1,3})\d*$/.exec(reference);
  if (match === null) return null;
  let column = 0;
  for (const letter of match[1]!.toUpperCase()) column = column * 26 + letter.charCodeAt(0) - 64;
  return column;
}

/** A row number from `<row r>`; Number(undefined) is NaN, so a missing attribute is null too. */
function positiveInteger(text: string | undefined): number | null {
  const n = Number(text);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

const LEGACY_XLS_MESSAGE =
  'Filen är i det gamla Excel-formatet (.xls), som Rastra inte läser. Öppna den i Excel och välj Spara som > Excel-arbetsbok (.xlsx), eller spara tabellen som CSV.';
const ENCRYPTED_MESSAGE =
  'Excel-filen är lösenordsskyddad och kan inte läsas. Ta bort lösenordet i Excel (Arkiv > Info > Skydda arbetsbok > Kryptera med lösenord) och spara filen igen, eller spara tabellen som CSV.';

export function readXlsx(buf: Buffer): ReadXlsxResult {
  if (buf.length >= OLE2_MAGIC.length && buf.subarray(0, OLE2_MAGIC.length).equals(OLE2_MAGIC)) {
    throw new XlsxError(buf.includes(ENCRYPTED_PACKAGE) ? ENCRYPTED_MESSAGE : LEGACY_XLS_MESSAGE);
  }
  let entries: Map<string, Buffer>;
  try {
    // The exchange limits, not the generic ones: a file here is refused for its unpacked size from the
    // zip's directory, before a byte is inflated (the review of PR #256: a zip under 1 MB that unpacks to
    // tens of MB cost CPU and hundreds of MB of memory before any other check could say no).
    entries = readZip(buf, EXCHANGE_ZIP_LIMITS);
  } catch (error) {
    // readZip only throws ZipError (every count in the file is checked before it is used), and its
    // messages name the entry, which is the file's text.
    throw new XlsxError(`Filen går inte att läsa som en Excel-arbetsbok (.xlsx): ${shown((error as Error).message, MAX_INNER_MESSAGE)}`);
  }

  // The workbook part: found through the package relationships, with the conventional name as the fallback.
  const officeDocument = relationshipsOf(entries, '_rels/.rels').find((rel) => rel.type.endsWith('/officeDocument'));
  const workbookPath = officeDocument !== undefined ? resolvePart('', officeDocument.target) : 'xl/workbook.xml';
  const workbookBytes = entries.get(workbookPath);
  if (workbookBytes === undefined) throw new XlsxError('Filen är ingen Excel-arbetsbok: arbetsboken (xl/workbook.xml) saknas.');
  const workbook = parsePart(workbookBytes, workbookPath);
  if (workbook.name !== 'workbook') throw new XlsxError('Filen är ingen Excel-arbetsbok: arbetsboken har fel rotelement.');

  const slash = workbookPath.lastIndexOf('/');
  const folder = workbookPath.slice(0, slash + 1);
  const rels = relationshipsOf(entries, `${folder}_rels/${workbookPath.slice(slash + 1)}.rels`);
  const targetOf = (rel: Relationship): string => resolvePart(folder, rel.target);

  // The first sheet, in workbook order, that is a worksheet (not a chart sheet).
  const sheets = childNamed(workbook, 'sheets');
  let sheetName = '';
  let sheetPath = '';
  for (const sheet of sheets ? childrenNamed(sheets, 'sheet') : []) {
    const rel = rels.find((candidate) => candidate.id === sheet.attrs['id']);
    if (rel !== undefined && rel.type.endsWith('/worksheet')) {
      sheetName = sheet.attrs['name'] ?? '';
      sheetPath = targetOf(rel);
      break;
    }
  }
  if (sheetPath === '') throw new XlsxError('Excel-filen innehåller inget kalkylblad.');
  const sheetBytes = entries.get(sheetPath);
  if (sheetBytes === undefined) throw new XlsxError(`Excel-filen saknar kalkylbladet ${shown(sheetPath)}.`);

  const date1904 = ['1', 'true'].includes(childNamed(workbook, 'workbookPr')?.attrs['date1904'] ?? '');

  const sharedPath = rels.find((rel) => rel.type.endsWith('/sharedStrings'));
  const sharedBytes = sharedPath !== undefined ? entries.get(targetOf(sharedPath)) : undefined;
  const shared = sharedBytes !== undefined ? childrenNamed(parsePart(sharedBytes, 'sharedStrings'), 'si').map(itemText) : [];

  const stylesRel = rels.find((rel) => rel.type.endsWith('/styles'));
  const stylesBytes = stylesRel !== undefined ? entries.get(targetOf(stylesRel)) : undefined;
  const dateStyle = dateStyles(stylesBytes !== undefined ? parsePart(stylesBytes, 'styles') : null);

  const worksheet = parsePart(sheetBytes, sheetPath);
  if (worksheet.name !== 'worksheet') throw new XlsxError('Filen är ingen Excel-arbetsbok: kalkylbladet har fel rotelement.');

  /** What the user sees in the cell, as text. */
  const textOf = (cell: XmlNode, where: string): string => {
    const type = cell.attrs['t'] ?? 'n';
    const stored = childNamed(cell, 'v')?.text ?? '';
    switch (type) {
      case 's': {
        if (stored.trim() === '') return '';
        const text = shared[Number(stored)];
        if (text === undefined) throw new XlsxError(`Cell ${shown(where)} pekar på en text som inte finns i filen.`);
        return text;
      }
      case 'inlineStr': {
        const inline = childNamed(cell, 'is');
        return inline !== null ? itemText(inline) : '';
      }
      case 'b': {
        const flag = stored.trim().toLowerCase();
        if (flag === '') return '';
        return flag === '1' || flag === 'true' ? 'TRUE' : 'FALSE';
      }
      case 'str':
      case 'e':
      case 'd':
        return decodeEscapes(stored);
      default: {
        const number = stored.trim();
        if (dateStyle[Number(cell.attrs['s'] ?? '0')] === true) return excelSerialToText(number, date1904) ?? number;
        return number;
      }
    }
  };

  const data = childNamed(worksheet, 'sheetData');
  const grid: string[][] = [];
  let width = 0;
  let nextRow = 1;
  for (const row of data ? childrenNamed(data, 'row') : []) {
    const rowNumber = positiveInteger(row.attrs['r']) ?? nextRow;
    nextRow = rowNumber + 1;
    let nextColumn = 1;
    for (const cell of childrenNamed(row, 'c')) {
      const reference = cell.attrs['r'];
      const column = (reference !== undefined ? columnOfReference(reference) : null) ?? nextColumn;
      nextColumn = column + 1;
      const where = reference ?? `${columnName(column)}${rowNumber}`;
      const text = textOf(cell, where);
      if (text === '') continue; // a styled but empty cell does not count towards the limits
      if (rowNumber > XLSX_MAX_ROWS) throw new XlsxError(`Kalkylbladet har data på rad ${rowNumber}; högst ${XLSX_MAX_ROWS} rader läses.`);
      if (column > XLSX_MAX_COLUMNS) throw new XlsxError(`Kalkylbladet har data i kolumn ${columnName(column)}; högst ${XLSX_MAX_COLUMNS} kolumner läses.`);
      if (text.length > XLSX_MAX_CELL_CHARS) throw new XlsxError(`Cell ${shown(where)} har ${text.length} tecken; högst ${XLSX_MAX_CELL_CHARS} läses.`);
      (grid[rowNumber - 1] ??= [])[column - 1] = text;
      width = Math.max(width, column);
    }
  }

  // Rectangular: holes in the sparse grid (empty rows, skipped cells) become empty strings.
  const rows: string[][] = [];
  for (let r = 0; r < grid.length; r += 1) {
    const source = grid[r];
    const filled = new Array<string>(width).fill('');
    if (source !== undefined) source.forEach((text, c) => (filled[c] = text));
    rows.push(filled);
  }
  return { rows, sheetName };
}
