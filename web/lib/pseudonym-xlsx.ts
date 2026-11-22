/**
 * An Excel workbook (.xlsx) as the VALUES of its visible sheets, read in the browser with no spreadsheet library
 * (Pseudonymiseraren, X1). A trimmed port of the gateway's reader (src/schedule-exchange/xlsx.ts, which stays the one that
 * reads files for the importer), on what the browser has: `DecompressionStream('deflate-raw')` for the zip and `DOMParser` for
 * the XML. A file is read here and written nowhere: nothing in this module touches the network.
 *
 * WHAT IS READ, AND WHAT NEVER IS. Only the parts a table's values come from are unpacked: the workbook, its relationships, the
 * shared strings, the styles (to tell a date from a number) and the visible sheets. The document properties (author, company,
 * last saved by), comments and their authors, drawings, hidden sheets, defined names, external links and every formula are never
 * opened, so none of it can reach a file made from this one. That is the reason the pseudonymiser writes CSV from a workbook
 * instead of a new workbook.
 *
 * READ AS THE GATEWAY'S READER READS: shared strings (rich-text runs joined, phonetic runs left out), inline strings, formula
 * results as cached, booleans as TRUE/FALSE, `_x000D_` escapes decoded; cell references place every cell, so a row with gaps
 * lines up and row n is row n as Excel numbers it. A number is returned as stored, except a number with a date or time format,
 * which is returned as `HH:MM`, `YYYY-MM-DD` or both, by its value (the 1900 system and its invented 29 February 1900, and the 1904
 * system, as the gateway's reader does).
 *
 * LIMITS, checked against the zip's own directory BEFORE anything is unpacked, and again while it is (a directory may lie): at
 * most 512 entries, no zip64, no encryption, a part of at most 16 MB and all parts at most 32 MB, a compression ratio of at most 200:1 on
 * any part over 1 MB, a DOCTYPE or entity refused in every XML part, 200 000 rows, 256 columns and 32 767 characters in a cell. A
 * refusal is a CODE (`XlsxProblem`) and never a message, so that no text of the file reaches one.
 */

export type XlsxProblem =
  /** The old binary format (.xls) or an Access database: an OLE2 file. */
  | "legacy"
  /** Password-protected: an OLE2 file that holds an encrypted package. */
  | "encrypted"
  /** This browser has no DecompressionStream. */
  | "unavailable"
  /** A zip, but not a workbook, or a workbook with no sheet to read. */
  | "notWorkbook"
  /** Over a limit above. */
  | "tooBig"
  /** A zip or XML that cannot be read. */
  | "damaged";

export class XlsxRefusal extends Error {
  constructor(readonly problem: XlsxProblem) {
    super(problem);
    this.name = "XlsxRefusal";
  }
}

export interface Sheet {
  name: string;
  /** Rows that hold something, each as wide as the widest, cells as text. */
  rows: string[][];
  /** The number of each row as Excel shows it. */
  rowNumbers: number[];
}

export interface Workbook {
  /** The visible worksheets in workbook order. */
  sheets: Sheet[];
  /** How many sheets were left unread because they are hidden. */
  hidden: number;
}

export const XLSX_LIMITS = {
  entries: 512,
  part: 16 * 1024 * 1024,
  total: 32 * 1024 * 1024,
  ratio: 200,
  rows: 200_000,
  columns: 256,
  cellChars: 32_767,
} as const;

// ---------------------------------------------------------------------------
// The zip
// ---------------------------------------------------------------------------

interface ZipEntry {
  name: string;
  method: number;
  compressed: number;
  size: number;
  offset: number;
}

const OLE2 = [0xd0, 0xcf, 0x11, 0xe0] as const;
const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_END = 0x06054b50;

const startsWith = (bytes: Uint8Array, magic: readonly number[]): boolean => magic.every((byte, i) => bytes[i] === byte);

/** The name of an "EncryptedPackage" stream in UTF-16: what tells a password-protected workbook from a legacy .xls. */
function holdsEncryptedPackage(bytes: Uint8Array): boolean {
  const needle = Array.from("EncryptedPackage", (char) => char.charCodeAt(0));
  const last = Math.min(bytes.length, 8 * 1024 * 1024) - needle.length * 2;
  for (let i = 0; i <= last; i += 1) {
    if (bytes[i] !== needle[0]) continue;
    if (needle.every((code, k) => bytes[i + k * 2] === code && bytes[i + k * 2 + 1] === 0)) return true;
  }
  return false;
}

/** The entries of the zip's central directory, checked before any is read. */
function listEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i -= 1) {
    if (view.getUint32(i, true) === ZIP_END) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new XlsxRefusal("notWorkbook");
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryAt = view.getUint32(end + 16, true);
  if (count === 0xffff || directoryAt === 0xffffffff || directorySize === 0xffffffff) throw new XlsxRefusal("tooBig");
  if (count > XLSX_LIMITS.entries) throw new XlsxRefusal("tooBig");
  if (directoryAt + directorySize > bytes.length) throw new XlsxRefusal("damaged");

  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let at = directoryAt;
  let total = 0;
  for (let n = 0; n < count; n += 1) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== ZIP_CENTRAL) throw new XlsxRefusal("damaged");
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    if (at + 46 + nameLength > bytes.length) throw new XlsxRefusal("damaged");
    if ((flags & 1) !== 0) throw new XlsxRefusal("encrypted");
    const name = new TextDecoder("utf-8").decode(bytes.subarray(at + 46, at + 46 + nameLength));
    if (names.has(name)) throw new XlsxRefusal("damaged");
    names.add(name);
    if (!name.endsWith("/")) {
      if (method !== 0 && method !== 8) throw new XlsxRefusal("notWorkbook");
      if (size > XLSX_LIMITS.part) throw new XlsxRefusal("tooBig");
      if (size > 1024 * 1024 && size > compressed * XLSX_LIMITS.ratio) throw new XlsxRefusal("tooBig");
      total += size;
      if (total > XLSX_LIMITS.total) throw new XlsxRefusal("tooBig");
      entries.push({ name, method, compressed, size, offset });
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Unpacks one entry, stopping at the entry's own declared size: a directory that says 100 bytes for a part that unpacks to a gigabyte is refused, not followed. */
async function unpack(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (entry.offset + 30 > bytes.length || view.getUint32(entry.offset, true) !== ZIP_LOCAL) throw new XlsxRefusal("damaged");
  const dataAt = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true);
  if (dataAt + entry.compressed > bytes.length) throw new XlsxRefusal("damaged");
  const data = bytes.subarray(dataAt, dataAt + entry.compressed);
  if (entry.method === 0) return data;
  if (typeof DecompressionStream === "undefined") throw new XlsxRefusal("unavailable");

  const stream = new DecompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  // The write and the close are not awaited: the stream's buffer holds a chunk, and the reader below is what lets it move. A corrupt part
  // fails on the reading side, which is where it is caught.
  writer.write(data as unknown as BufferSource).catch(() => undefined);
  writer.close().catch(() => undefined);
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > entry.size || total > XLSX_LIMITS.part) {
        await reader.cancel().catch(() => undefined);
        throw new XlsxRefusal("tooBig");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof XlsxRefusal) throw error;
    throw new XlsxRefusal("damaged");
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The XML
// ---------------------------------------------------------------------------

function parseXml(bytes: Uint8Array): Element {
  const text = new TextDecoder("utf-8").decode(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new XlsxRefusal("damaged");
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const root = doc.documentElement;
  if (root === null || root.localName === "parsererror" || doc.getElementsByTagName("parsererror").length > 0) throw new XlsxRefusal("damaged");
  return root;
}

const childrenOf = (element: Element, name: string): Element[] => Array.from(element.children).filter((child) => child.localName === name);
const childOf = (element: Element, name: string): Element | null => childrenOf(element, name)[0] ?? null;
const attr = (element: Element, name: string): string => element.getAttribute(name) ?? "";

/** Excel writes control characters in strings as _xHHHH_ (and a literal "_x" as _x005F_x). */
const decodeEscapes = (text: string): string =>
  text.includes("_x") ? text.replace(/_x([0-9A-Fa-f]{4})_/g, (_whole, hex: string) => String.fromCharCode(parseInt(hex, 16))) : text;

/** The text of a string item (<si> or <is>): its own <t> and the <t> of its runs; phonetic runs are not text. */
function itemText(item: Element): string {
  let text = "";
  for (const child of Array.from(item.children)) {
    if (child.localName === "t") text += child.textContent ?? "";
    else if (child.localName === "r") for (const run of childrenOf(child, "t")) text += run.textContent ?? "";
  }
  return decodeEscapes(text);
}

/** Built-in number formats that are dates or times (ECMA-376 18.8.30). */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** Whether a custom number format shows a date or a time: a d, m, y, h or s that is not literal ("…", after \ _ or *, or in […] but for [h] [m] [s]). */
export function isDateFormatCode(code: string): boolean {
  for (let i = 0; i < code.length; i += 1) {
    const char = code[i]!;
    if (char === '"') {
      const close = code.indexOf('"', i + 1);
      if (close < 0) return false;
      i = close;
    } else if (char === "\\" || char === "_" || char === "*") {
      i += 1;
    } else if (char === "[") {
      const close = code.indexOf("]", i + 1);
      if (close < 0) return false;
      if (/^(?:h+|m+|s+)$/i.test(code.slice(i + 1, close))) return true;
      i = close;
    } else if (/[dmyhs]/i.test(char)) {
      return true;
    }
  }
  return false;
}

const DAY_MS = 86_400_000;
const SERIAL_LIMIT = 2_958_466;
const pad2 = (n: number): string => String(n).padStart(2, "0");

/** An Excel serial number as text, by value: a time of day below 1, a date when whole, both otherwise; null when it is no serial. */
export function excelSerialToText(raw: string, date1904: boolean): string | null {
  const serial = Number(raw);
  if (raw === "" || !Number.isFinite(serial) || serial < 0 || serial >= SERIAL_LIMIT) return null;
  const seconds = Math.round(serial * 86_400);
  if (serial < 1) {
    const clock = Math.min(seconds, 86_399);
    return `${pad2(Math.floor(clock / 3600))}:${pad2(Math.floor((clock % 3600) / 60))}`;
  }
  const days = Math.floor(seconds / 86_400);
  const ofDay = seconds % 86_400;
  let date: string;
  if (!date1904 && days === 60) {
    date = "1900-02-29";
  } else {
    const epoch = date1904 ? Date.UTC(1904, 0, 1) : days < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
    const day = new Date(epoch + days * DAY_MS);
    if (day.getUTCFullYear() > 9999) return null;
    date = `${String(day.getUTCFullYear()).padStart(4, "0")}-${pad2(day.getUTCMonth() + 1)}-${pad2(day.getUTCDate())}`;
  }
  return ofDay === 0 ? date : `${date} ${pad2(Math.floor(ofDay / 3600))}:${pad2(Math.floor((ofDay % 3600) / 60))}`;
}

/** Which cell formats (`s` of a cell, an index into cellXfs) hold dates or times. */
function dateStyles(styles: Element | null): boolean[] {
  if (styles === null) return [];
  const custom = new Map<number, string>();
  const formats = childOf(styles, "numFmts");
  for (const format of formats ? childrenOf(formats, "numFmt") : []) custom.set(Number(attr(format, "numFmtId")), attr(format, "formatCode"));
  const xfs = childOf(styles, "cellXfs");
  return (xfs ? childrenOf(xfs, "xf") : []).map((xf) => {
    const id = Number(attr(xf, "numFmtId") || "0");
    const code = custom.get(id);
    return code !== undefined ? isDateFormatCode(code) : BUILTIN_DATE_FORMATS.has(id);
  });
}

/** 'B' -> 2, 'AA' -> 27; null when the reference does not start with 1-3 letters. */
function columnOfReference(reference: string): number | null {
  const match = /^([A-Za-z]{1,3})\d*$/.exec(reference);
  if (match === null) return null;
  let column = 0;
  for (const letter of match[1]!.toUpperCase()) column = column * 26 + letter.charCodeAt(0) - 64;
  return column;
}

const positiveInteger = (text: string): number | null => {
  const n = Number(text);
  return text !== "" && Number.isInteger(n) && n >= 1 ? n : null;
};

/** A relationship target as a path in the package: absolute from the root, or relative to the part's folder. */
function resolvePart(folder: string, target: string): string {
  const out: string[] = [];
  for (const segment of (target.startsWith("/") ? target.slice(1) : folder + target).split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return out.join("/");
}

// ---------------------------------------------------------------------------
// The workbook
// ---------------------------------------------------------------------------

/** The values of the visible sheets of a workbook. Throws XlsxRefusal, and nothing else, for a file it cannot or will not read. */
export async function readWorkbook(bytes: Uint8Array): Promise<Workbook> {
  if (startsWith(bytes, OLE2)) throw new XlsxRefusal(holdsEncryptedPackage(bytes) ? "encrypted" : "legacy");
  const entries = listEntries(bytes);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const part = async (name: string): Promise<Element | null> => {
    const entry = byName.get(name);
    return entry === undefined ? null : parseXml(await unpack(bytes, entry));
  };

  const packageRels = await part("_rels/.rels");
  const officeDocument = packageRels && childrenOf(packageRels, "Relationship").find((rel) => attr(rel, "Type").endsWith("/officeDocument"));
  const workbookPath = officeDocument ? resolvePart("", attr(officeDocument, "Target")) : "xl/workbook.xml";
  const workbook = await part(workbookPath);
  if (workbook === null || workbook.localName !== "workbook") throw new XlsxRefusal("notWorkbook");

  const slash = workbookPath.lastIndexOf("/");
  const folder = workbookPath.slice(0, slash + 1);
  const relsRoot = await part(`${folder}_rels/${workbookPath.slice(slash + 1)}.rels`);
  const rels = relsRoot ? childrenOf(relsRoot, "Relationship").map((rel) => ({ id: attr(rel, "Id"), type: attr(rel, "Type"), target: attr(rel, "Target") })) : [];
  const targetOf = (rel: { target: string }): string => resolvePart(folder, rel.target);

  const date1904 = ["1", "true"].includes(attr(childOf(workbook, "workbookPr") ?? workbook, "date1904"));

  const sharedRel = rels.find((rel) => rel.type.endsWith("/sharedStrings"));
  const sharedRoot = sharedRel ? await part(targetOf(sharedRel)) : null;
  const shared = sharedRoot ? childrenOf(sharedRoot, "si").map(itemText) : [];
  const stylesRel = rels.find((rel) => rel.type.endsWith("/styles"));
  const dateStyle = dateStyles(stylesRel ? await part(targetOf(stylesRel)) : null);

  const sheetsRoot = childOf(workbook, "sheets");
  const sheets: Sheet[] = [];
  let hidden = 0;
  for (const sheet of sheetsRoot ? childrenOf(sheetsRoot, "sheet") : []) {
    const relationshipId = Array.from(sheet.attributes).find((a) => a.localName === "id")?.value;
    const rel = rels.find((candidate) => candidate.id === relationshipId);
    if (rel === undefined || !rel.type.endsWith("/worksheet")) continue;
    if (attr(sheet, "state") === "hidden" || attr(sheet, "state") === "veryHidden") {
      hidden += 1;
      continue;
    }
    const worksheet = await part(targetOf(rel));
    if (worksheet === null || worksheet.localName !== "worksheet") throw new XlsxRefusal("notWorkbook");
    sheets.push(readSheet(attr(sheet, "name"), worksheet, shared, dateStyle, date1904));
  }
  if (sheets.length === 0 && hidden === 0) throw new XlsxRefusal("notWorkbook");
  return { sheets, hidden };
}

function readSheet(name: string, worksheet: Element, shared: readonly string[], dateStyle: readonly boolean[], date1904: boolean): Sheet {
  const textOf = (cell: Element): string => {
    const type = attr(cell, "t") || "n";
    const stored = childOf(cell, "v")?.textContent ?? "";
    switch (type) {
      case "s": {
        if (stored.trim() === "") return "";
        const text = shared[Number(stored)];
        if (text === undefined) throw new XlsxRefusal("damaged");
        return text;
      }
      case "inlineStr": {
        const inline = childOf(cell, "is");
        return inline !== null ? itemText(inline) : "";
      }
      case "b": {
        const flag = stored.trim().toLowerCase();
        return flag === "" ? "" : flag === "1" || flag === "true" ? "TRUE" : "FALSE";
      }
      case "str":
      case "e":
      case "d":
        return decodeEscapes(stored);
      default: {
        const number = stored.trim();
        return dateStyle[Number(attr(cell, "s") || "0")] === true ? (excelSerialToText(number, date1904) ?? number) : number;
      }
    }
  };

  const data = childOf(worksheet, "sheetData");
  const grid = new Map<number, string[]>();
  let width = 0;
  let nextRow = 1;
  for (const row of data ? childrenOf(data, "row") : []) {
    const rowNumber = positiveInteger(attr(row, "r")) ?? nextRow;
    nextRow = rowNumber + 1;
    let nextColumn = 1;
    for (const cell of childrenOf(row, "c")) {
      const reference = attr(cell, "r");
      const column = (reference !== "" ? columnOfReference(reference) : null) ?? nextColumn;
      nextColumn = column + 1;
      const text = textOf(cell);
      if (text === "") continue;
      if (rowNumber > XLSX_LIMITS.rows || column > XLSX_LIMITS.columns || text.length > XLSX_LIMITS.cellChars) throw new XlsxRefusal("tooBig");
      let cells = grid.get(rowNumber);
      if (cells === undefined) {
        cells = [];
        grid.set(rowNumber, cells);
      }
      cells[column - 1] = text;
      if (column > width) width = column;
    }
  }
  const rowNumbers = [...grid.keys()].sort((a, b) => a - b);
  const rows = rowNumbers.map((number) => {
    const source = grid.get(number)!;
    const filled = new Array<string>(width).fill("");
    source.forEach((text, c) => {
      filled[c] = text;
    });
    return filled;
  });
  return { name, rows, rowNumbers };
}
