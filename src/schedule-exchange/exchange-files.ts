import { BadRequestException } from '@nestjs/common';
import { writeCsv, parseCsv } from './csv';
import { readXlsx, writeXlsx, XlsxError } from './xlsx';
import { lessonsToTable, tableToLessons } from './lesson-table';
import { listSafeChanges, readUntisGpu, writeUntisGpu, type UntisPeriod } from './untis-gpu';
import { readAscXml, writeAscXml } from './asc-xml';
import { readZip, writeZip } from './zip';
import { EXCHANGE_ZIP_LIMITS, MAX_EXCHANGE_BYTES, minutesOfClock, type ExchangeDocument, type ParsedExchange } from './exchange-model';
import { redactPersonalNumbers } from './file-safety';

/**
 * The four formats, and the bytes in and out (Schemat som tabell och i öppna
 * format). The service knows what a lesson is; this file knows what a file is.
 * Nothing here reads the database.
 */

export const EXCHANGE_FORMATS = ['TABLE_CSV', 'TABLE_XLSX', 'UNTIS_GPU', 'ASC_XML'] as const;
export type ExchangeFormat = (typeof EXCHANGE_FORMATS)[number];

export interface UploadedFile {
  name: string;
  bytes: Buffer;
}

export interface RenderedFile {
  filename: string;
  contentType: string;
  body: Buffer;
  /** What the writer changed on the way out and the school should know (a signature with a comma, in an Untis file). */
  notes: string[];
}

/** "2026/2027" to "2026-2027": a year name is free text and a file name is not. */
export function fileStem(yearName: string): string {
  const safe = yearName.normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
  return `rastra-schema-${safe || 'lasar'}`;
}

/** The document as one downloadable file. Untis is three files, so it is a zip of them. */
export function renderExport(format: ExchangeFormat, doc: ExchangeDocument): RenderedFile {
  const stem = fileStem(doc.year.name);
  switch (format) {
    case 'TABLE_CSV':
      return {
        filename: `${stem}.csv`,
        contentType: 'text/csv; charset=utf-8',
        body: Buffer.from(writeCsv(lessonsToTable(doc)), 'utf8'),
        notes: [],
      };
    case 'TABLE_XLSX':
      try {
        return {
          filename: `${stem}.xlsx`,
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          body: writeXlsx(lessonsToTable(doc), { sheetName: 'Schema', frozenHeader: true }),
          notes: [],
        };
      } catch (error) {
        // A table that would unpack past what the reader takes back is refused with its reason, not a 500.
        if (error instanceof XlsxError) throw new BadRequestException({ message: error.message, code: 'EXPORT_XLSX_TOO_LARGE' });
        throw error;
      }
    case 'UNTIS_GPU': {
      const files = writeUntisGpu(doc);
      return {
        filename: `${stem}-untis.zip`,
        contentType: 'application/zip',
        body: writeZip([
          { name: 'GPU001.TXT', data: Buffer.from(files.gpu001, 'utf8') },
          { name: 'GPU002.TXT', data: Buffer.from(files.gpu002, 'utf8') },
        ]),
        // ',' and '~' separate the values of an Untis list field, so a name with one is written with a blank.
        notes: listSafeChanges(doc),
      };
    }
    case 'ASC_XML':
      return {
        filename: `${stem}-asc.xml`,
        contentType: 'application/xml; charset=utf-8',
        body: Buffer.from(writeAscXml(doc), 'utf8'),
        notes: [],
      };
  }
}

/** Which encoding a file was read as; `legacy` is anything but UTF-8. */
export type TextEncodingName = 'utf-8' | 'windows-1252' | 'macintosh';

/**
 * The Swedish letters (and é, ü, which Swedish names carry) as single bytes in
 * each legacy encoding. The guess between the two reads ONLY these: every other
 * high byte is punctuation or a symbol that differs between the two and that a
 * file uses for its own reasons (a typographic dash, quotation marks, a
 * euro sign), and counting them decided wrongly in the review of PR #260.
 *
 *   windows-1252  å E5  ä E4  ö F6  Å C5  Ä C4  Ö D6  é E9  ü FC
 *   Mac Roman     å 8C  ä 8A  ö 9A  Å 81  Ä 80  Ö 85  é 8E  ü 9F
 *
 * Sources: the WHATWG Encoding Standard's index for windows-1252 and
 * macintosh (encoding.spec.whatwg.org).
 */
const SWEDISH_1252 = new Set([0xe5, 0xe4, 0xf6, 0xc5, 0xc4, 0xd6, 0xe9, 0xfc]);
const SWEDISH_MAC = new Set([0x8c, 0x8a, 0x9a, 0x81, 0x80, 0x85, 0x8e, 0x9f]);

/** The legacy encoding a non-UTF-8 file is most likely in: windows-1252 unless Mac Roman has more of the Swedish letters. */
function guessLegacyEncoding(bytes: Buffer): 'windows-1252' | 'macintosh' {
  let windows = 0;
  let mac = 0;
  for (const byte of bytes) {
    if (byte < 0x80) continue;
    if (SWEDISH_1252.has(byte)) windows += 1;
    if (SWEDISH_MAC.has(byte)) mac += 1;
  }
  // A tie, and a file with none of the letters, is what Excel on Windows writes.
  return mac > windows ? 'macintosh' : 'windows-1252';
}

/**
 * Bytes to text: UTF-8, with or without a byte order mark; a file that is not
 * valid UTF-8 is read as windows-1252 (what Excel on Windows writes a Swedish
 * "CSV (semikolonavgränsad)" in) or as Mac Roman (Excel for Mac's "CSV"), by
 * which of the two has more of the Swedish letters among the file's high
 * bytes. Which one was read is returned, for the preview's notes.
 */
export function decodeText(bytes: Buffer): { text: string; legacyEncoding: boolean; encoding: TextEncodingName } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), legacyEncoding: false, encoding: 'utf-8' };
  } catch {
    const encoding = guessLegacyEncoding(bytes);
    return { text: new TextDecoder(encoding).decode(bytes), legacyEncoding: true, encoding };
  }
}

/** The preview's note about a file that was not UTF-8, naming the encoding it was read as. */
function encodingNote(encoding: TextEncodingName, files: string): string {
  const name = encoding === 'macintosh' ? 'Mac Roman' : 'windows-1252';
  const writer = encoding === 'macintosh' ? 'Excel för Mac' : 'Excel för Windows';
  return `${files} inte UTF-8; den lästes som ${name}, som ${writer} skriver svensk CSV. Är å, ä och ö fel i förhandsvisningen, spara filen som UTF-8 och läs in den igen.`;
}

function oneFile(files: readonly UploadedFile[], what: string): UploadedFile {
  if (files.length !== 1) {
    throw new BadRequestException({ message: `Ladda upp exakt en ${what}-fil.`, code: 'IMPORT_FILE_COUNT' });
  }
  return files[0]!;
}

/**
 * The school's period times, typed as a list: "1 08:10-09:10", one period a
 * line, the number first. A period-numbered GPU001 (a normal Untis export) has
 * only the number, and Untis writes no file with the grid (GPU011 is the
 * Stundentafel), so the school says it. Every line that is not a period is a
 * 400 naming it: a grid is never guessed.
 */
export function parsePeriods(text: string | undefined): UntisPeriod[] {
  const periods: UntisPeriod[] = [];
  // "12 08:10 - 09:10" is sixteen characters; a school that spaces its columns wide
  // still fits in sixty. A longer line is not a period, and is refused before any
  // pattern is tried on it: the pattern's runs of blanks backtrack on a long line
  // of them (the review of PR #256: a 2 000-character line held the process for 3.3 s).
  const MAX_LINE = 60;
  const line = /^\s*(\d{1,2})\s*[:;,\s]\s*(\d{1,2}[:.]\d{2})\s*(?:[-–—;]|\s)\s*(\d{1,2}[:.]\d{2})\s*$/;
  for (const [i, raw] of (text ?? '').split(/\r?\n/).entries()) {
    if (raw.trim() === '') continue;
    const m = raw.length <= MAX_LINE ? line.exec(raw) : null;
    const clock = (t: string) => {
      const [h, min] = t.replace('.', ':').split(':');
      return `${String(Number(h)).padStart(2, '0')}:${min}`;
    };
    const start = m ? minutesOfClock(clock(m[2]!)) : null;
    const end = m ? minutesOfClock(clock(m[3]!)) : null;
    if (!m || start === null || end === null || end <= start || periods.some((p) => p.number === Number(m[1]))) {
      throw new BadRequestException({ message: `Tidsrastret går inte att läsa på rad ${i + 1}: ${redactPersonalNumbers(raw.trim().slice(0, 40))}`, code: 'IMPORT_PERIODS_UNREADABLE' });
    }
    periods.push({ number: Number(m[1]), start: clock(m[2]!), end: clock(m[3]!) });
  }
  return periods;
}

/** The Untis files out of what was uploaded: loose files, or one zip holding them. */
function untisFilesOf(files: readonly UploadedFile[]): { gpu001?: string; gpu002?: string; gpu011?: string; legacy: TextEncodingName | null } {
  const parts: UploadedFile[] = [];
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) {
      for (const [name, data] of readZip(f.bytes, EXCHANGE_ZIP_LIMITS)) parts.push({ name, bytes: data });
    } else {
      parts.push(f);
    }
  }
  let legacy: TextEncodingName | null = null;
  const pick = (re: RegExp): string | undefined => {
    const hits = parts.filter((p) => re.test(p.name.split('/').pop() ?? p.name));
    if (hits.length > 1) {
      throw new BadRequestException({ message: `Mer än en fil ser ut som ${re.source}.`, code: 'IMPORT_FILE_COUNT' });
    }
    if (hits.length === 0) return undefined;
    const decoded = decodeText(hits[0]!.bytes);
    if (decoded.legacyEncoding) legacy = legacy === null || legacy === decoded.encoding ? decoded.encoding : 'windows-1252';
    return decoded.text;
  };
  return { gpu001: pick(/gpu0*1(\D|$)/i), gpu002: pick(/gpu0*2(\D|$)/i), gpu011: pick(/gpu0*11(\D|$)/i), legacy };
}

/**
 * The uploaded files as lessons. Never throws on what is IN a file (a reader
 * turns that into problems); throws a 400 on a file that is not one of the
 * format at all, or too large.
 */
export function readUpload(format: ExchangeFormat, files: readonly UploadedFile[], options: { periods?: string } = {}): ParsedExchange {
  for (const f of files) {
    if (f.bytes.length > MAX_EXCHANGE_BYTES) {
      throw new BadRequestException({ message: `Filen ${f.name} är för stor.`, code: 'IMPORT_FILE_TOO_LARGE' });
    }
  }
  switch (format) {
    case 'TABLE_CSV': {
      const { text, encoding } = decodeText(oneFile(files, 'CSV').bytes);
      const { rows, rowNumbers, unterminated } = parseCsv(text);
      // The row numbers are the file's own, so a blank line does not move "rad 12" up a line.
      const parsed = tableToLessons(rows, rowNumbers);
      if (encoding !== 'utf-8') parsed.notes.push(encodingNote(encoding, 'Filen är'));
      if (unterminated) parsed.notes.push('Ett citattecken i filen stängdes aldrig; resten av raden lästes som text.');
      return parsed;
    }
    case 'TABLE_XLSX': {
      try {
        return tableToLessons(readXlsx(oneFile(files, 'Excel').bytes).rows);
      } catch (error) {
        if (error instanceof XlsxError) {
          throw new BadRequestException({ message: error.message, code: 'IMPORT_XLSX_UNREADABLE' });
        }
        throw error;
      }
    }
    case 'UNTIS_GPU': {
      const picked = untisFilesOf(files);
      if (picked.gpu001 === undefined) {
        throw new BadRequestException({ message: 'GPU001.TXT saknas bland de uppladdade filerna.', code: 'IMPORT_UNTIS_NO_GPU001' });
      }
      const parsed = readUntisGpu(picked, { periods: parsePeriods(options.periods) });
      if (picked.legacy !== null) parsed.notes.push(encodingNote(picked.legacy, 'Minst en fil är'));
      return parsed;
    }
    case 'ASC_XML':
      return readAscXml(decodeText(oneFile(files, 'aSc XML').bytes).text);
  }
}
