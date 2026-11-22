/**
 * Builds .xlsx bytes for the tests of the pseudonymiser's reader: a real zip (deflate through CompressionStream, CRC-32 and a
 * central directory) holding the parts a spreadsheet program writes. Not a product module: nothing outside the tests imports it.
 * The workbooks hold INVENTED people only; the document properties name an invented author so the tests can prove that
 * nothing in them reaches the reader's output.
 */

export type Cell = string | number | null | { serial: number };

export interface BuiltSheet {
  name: string;
  hidden?: boolean;
  /** Row n of the array is row n of the sheet; a `null` row is an empty row. Cells may be `null` for a gap. */
  rows: (Cell[] | null)[];
}

export interface WorkbookOptions {
  sheets: BuiltSheet[];
  /** Strings as shared strings (what Excel writes) or as inline strings. Default shared. */
  inlineStrings?: boolean;
  date1904?: boolean;
  /** Written into docProps/core.xml and app.xml and a comments part: what must never come out. */
  author?: string;
  /** Store instead of deflate. */
  stored?: boolean;
  /** Extra raw parts. */
  extra?: Record<string, string>;
}

const encoder = new TextEncoder();

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  void writer.write(data as unknown as BufferSource);
  void writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

export interface ZipPart {
  name: string;
  data: Uint8Array;
  /** Declare these sizes instead of the real ones (to build a zip that lies). */
  declaredSize?: number;
  method?: 0 | 8;
  /** The bytes as they stand in the zip (a corrupt deflate stream, say), instead of `data` packed by `method`. */
  rawBody?: Uint8Array;
}

/** A zip of the parts, in order. */
export async function zip(parts: ZipPart[], options: { stored?: boolean } = {}): Promise<Uint8Array> {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const part of parts) {
    const name = encoder.encode(part.name);
    const method = part.method ?? (options.stored ? 0 : 8);
    const body = part.rawBody ?? (method === 8 ? await deflateRaw(part.data) : part.data);
    const crc = crc32(part.data);
    const size = part.declaredSize ?? part.data.length;

    const local = new Uint8Array(30 + name.length + body.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(body, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);
    offset += local.length;
  }
  const directorySize = centrals.reduce((sum, c) => sum + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, parts.length, true);
  ev.setUint16(10, parts.length, true);
  ev.setUint32(12, directorySize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + directorySize + 22);
  let at = 0;
  for (const chunk of [...locals, ...centrals, end]) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

const escapeXml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const columnName = (column: number): string => {
  let name = "";
  for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
};

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** The parts of a workbook, as text, by path. */
export function workbookParts(options: WorkbookOptions): Record<string, string> {
  const shared: string[] = [];
  const sharedIndex = new Map<string, number>();
  const sheetXml = options.sheets.map((sheet) => {
    const rows = sheet.rows
      .map((cells, r) => {
        if (cells === null) return "";
        const rowNumber = r + 1;
        const body = cells
          .map((cell, c) => {
            if (cell === null) return "";
            const ref = `${columnName(c + 1)}${rowNumber}`;
            if (typeof cell === "number") return `<c r="${ref}"><v>${cell}</v></c>`;
            if (typeof cell === "object") return `<c r="${ref}" s="1"><v>${cell.serial}</v></c>`;
            if (options.inlineStrings) return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(cell)}</t></is></c>`;
            let index = sharedIndex.get(cell);
            if (index === undefined) {
              index = shared.length;
              shared.push(cell);
              sharedIndex.set(cell, index);
            }
            return `<c r="${ref}" t="s"><v>${index}</v></c>`;
          })
          .join("");
        return `<row r="${rowNumber}">${body}</row>`;
      })
      .join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS}"><sheetData>${rows}</sheetData></worksheet>`;
  });

  const parts: Record<string, string> = {
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns="${NS}" xmlns:r="${REL}"><workbookPr${options.date1904 ? ' date1904="1"' : ""}/><sheets>${options.sheets
      .map((sheet, i) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${i + 1}"${sheet.hidden ? ' state="hidden"' : ""} r:id="rId${i + 1}"/>`)
      .join("")}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${options.sheets
      .map((_s, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
      .join("")}<Relationship Id="rIdS" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rIdT" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
    "xl/styles.xml": `<?xml version="1.0"?><styleSheet xmlns="${NS}"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>`,
    "xl/sharedStrings.xml": `<?xml version="1.0"?><sst xmlns="${NS}" count="${shared.length}" uniqueCount="${shared.length}">${shared.map((s) => `<si><t>${escapeXml(s)}</t></si>`).join("")}</sst>`,
  };
  options.sheets.forEach((_sheet, i) => {
    parts[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml[i]!;
  });
  if (options.author !== undefined) {
    const author = escapeXml(options.author);
    parts["docProps/core.xml"] = `<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>${author}</dc:creator><cp:lastModifiedBy>${author}</cp:lastModifiedBy></cp:coreProperties>`;
    parts["docProps/app.xml"] = `<?xml version="1.0"?><Properties><Company>${author} AB</Company></Properties>`;
    parts["xl/comments1.xml"] = `<?xml version="1.0"?><comments xmlns="${NS}"><authors><author>${author}</author></authors><commentList><comment ref="A1" authorId="0"><text><t>Ring ${author}</t></text></comment></commentList></comments>`;
  }
  Object.assign(parts, options.extra ?? {});
  return parts;
}

/** The bytes of a workbook. */
export async function makeXlsx(options: WorkbookOptions): Promise<Uint8Array> {
  const parts = workbookParts(options);
  return zip(
    Object.entries(parts).map(([name, text]) => ({ name, data: encoder.encode(text) })),
    { stored: options.stored },
  );
}
