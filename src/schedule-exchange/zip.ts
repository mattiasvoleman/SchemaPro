/**
 * A minimal zip container reader and writer, on node:zlib alone (an Excel file
 * is a zip of XML parts; see xlsx.ts). No dependency: the readers an npm zip
 * library would bring are far larger than the thirty fields this needs, and
 * every one of them has had a zip-bomb or path-traversal advisory.
 *
 * THE READER IS HOSTILE-INPUT CODE. The file is an upload from a school's
 * browser and the first thing the server does with it is read it. Everything
 * that follows is therefore a refusal rule, each with a reason:
 *
 *   FORMATS REFUSED BY NAME: zip64 (a school's timetable is kilobytes; a zip
 *   that needs 64-bit sizes is not one), encryption (the data would be noise),
 *   a split archive (the other disks are not here), and any compression method
 *   but stored (0) and deflate (8).
 *
 *   LIMITS (ZipLimits, defaults below): at most 64 entries; each entry at most
 *   32 MB uncompressed; the whole archive at most 64 MB uncompressed; each
 *   entry at most 200 times its compressed size. The limits are checked on the
 *   DECLARED sizes in the central directory BEFORE anything is inflated, and
 *   then enforced on the real inflate: zlib is given `maxOutputLength` equal to
 *   the declared size, so an entry that claims 1 KB and holds 1 GB is stopped
 *   at 1 KB, and one whose real size differs from the declared one is refused.
 *   No count in the file is trusted before it is checked against the buffer.
 *
 *   NAMES: an entry named with a `..` segment, an absolute path (a leading `/`
 *   or a drive letter), a backslash or a NUL is refused outright, whatever the
 *   caller does with the names (nothing here touches the file system, but a
 *   reader that is ever pointed at one should not have to remember to check).
 *   Two entries with the same name are refused: which of them a program reads
 *   differs between programs, and that difference is what a crafted file uses.
 *
 *   STRUCTURE: the end-of-central-directory record is the one that sits exactly
 *   at the end of the file (its comment length reaches the last byte), the
 *   central directory lies before it, every local header and the data after it
 *   lie before the central directory, and no two entries' bytes overlap (the
 *   overlapping-entries bomb reuses one deflate stream for many entries).
 *   CRC-32 of the inflated data is verified against the directory.
 *
 * Directories (names ending in `/`) are validated and then left out of the
 * result: they carry no data.
 *
 * THE WRITER is deterministic: entries in the order given, deflate at a fixed
 * level, a fixed DOS timestamp (1980-01-01 00:00:00) and no extra fields, so
 * the same input is the same bytes, which makes a golden test of an export
 * possible and a diff of two exports meaningful.
 *
 * CRC-32 comes from zlib.crc32 (Node 22.2 and later; the repo's engines field
 * is >= 22.12), so no table lives here.
 */

import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

export interface ZipLimits {
  maxEntries: number;
  /** Uncompressed bytes of one entry. */
  maxEntryBytes: number;
  /** Uncompressed bytes of all entries together. */
  maxTotalBytes: number;
  /** Uncompressed size divided by compressed size, per entry. */
  maxRatio: number;
}

export const DEFAULT_ZIP_LIMITS: Readonly<ZipLimits> = {
  maxEntries: 64,
  maxEntryBytes: 32 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxRatio: 200,
};

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

const END_RECORD_BYTES = 22;
const CENTRAL_HEADER_BYTES = 46;
const LOCAL_HEADER_BYTES = 30;
/** The comment after the end record is at most 65535 bytes, so the record is within this of the end. */
const MAX_COMMENT_BYTES = 0xffff;

const FLAG_ENCRYPTED = 0x0001;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const FLAG_UTF8_NAME = 0x0800;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/** 1980-01-01 in DOS date format ((year - 1980) << 9 | month << 5 | day, here year 0) and midnight in DOS time. */
const DOS_DATE_1980 = (1 << 5) | 1;
const DOS_TIME_MIDNIGHT = 0;

const MB = 1024 * 1024;

/** Why a name is not acceptable, or null when it is. */
function nameProblem(name: string): string | null {
  if (name === '') return 'namnet är tomt';
  if (name.includes('\\')) return 'namnet innehåller ett omvänt snedstreck';
  if (name.includes('\0')) return 'namnet innehåller ett nolltecken';
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return 'namnet är en absolut sökväg';
  if (name.split('/').includes('..')) return 'namnet går uppåt i katalogträdet (..)';
  return null;
}

function findEndRecord(buf: Buffer): number {
  if (buf.length < END_RECORD_BYTES) throw new ZipError('Filen är för kort för att vara en zip-fil.');
  const lowest = Math.max(0, buf.length - END_RECORD_BYTES - MAX_COMMENT_BYTES);
  for (let at = buf.length - END_RECORD_BYTES; at >= lowest; at -= 1) {
    // Exactly at the end: the comment length must reach the last byte. A
    // signature inside a comment or inside compressed data is not an end record.
    if (buf.readUInt32LE(at) === SIG_END && at + END_RECORD_BYTES + buf.readUInt16LE(at + 20) === buf.length) return at;
  }
  throw new ZipError('Filen är ingen zip-fil: slutposten saknas eller är skadad.');
}

interface CentralEntry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

export function readZip(buf: Buffer, limits: Partial<ZipLimits> = {}): Map<string, Buffer> {
  const lim: ZipLimits = { ...DEFAULT_ZIP_LIMITS, ...limits };
  const end = findEndRecord(buf);

  const thisDisk = buf.readUInt16LE(end + 4);
  const directoryDisk = buf.readUInt16LE(end + 6);
  const entriesOnDisk = buf.readUInt16LE(end + 8);
  const entryCount = buf.readUInt16LE(end + 10);
  const directorySize = buf.readUInt32LE(end + 12);
  const directoryOffset = buf.readUInt32LE(end + 16);

  if (end >= 20 && buf.readUInt32LE(end - 20) === SIG_ZIP64_LOCATOR) {
    throw new ZipError('Zip64-filer tas inte emot.');
  }
  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new ZipError('Zip64-filer tas inte emot.');
  }
  if (thisDisk !== 0 || directoryDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new ZipError('Zip-filer som är delade över flera diskar tas inte emot.');
  }
  if (entryCount > lim.maxEntries) {
    throw new ZipError(`Zip-filen har ${entryCount} poster; högst ${lim.maxEntries} tas emot.`);
  }
  const directoryEnd = directoryOffset + directorySize;
  if (directoryEnd > end) throw new ZipError('Zip-filens innehållsförteckning ligger utanför filen.');

  // 1. The central directory: every entry's declared facts, checked before any data is touched.
  const entries: CentralEntry[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  let at = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (at + CENTRAL_HEADER_BYTES > directoryEnd || buf.readUInt32LE(at) !== SIG_CENTRAL) {
      throw new ZipError('Zip-filens innehållsförteckning är skadad.');
    }
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const compressedSize = buf.readUInt32LE(at + 20);
    const uncompressedSize = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const startDisk = buf.readUInt16LE(at + 34);
    const localOffset = buf.readUInt32LE(at + 42);
    const next = at + CENTRAL_HEADER_BYTES + nameLength + extraLength + commentLength;
    if (next > directoryEnd) throw new ZipError('Zip-filens innehållsförteckning är skadad.');
    const name = buf.toString(flags & FLAG_UTF8_NAME ? 'utf8' : 'latin1', at + CENTRAL_HEADER_BYTES, at + CENTRAL_HEADER_BYTES + nameLength);
    at = next;

    const problem = nameProblem(name);
    if (problem !== null) throw new ZipError(`Posten "${name}" tas inte emot: ${problem}.`);
    if (seen.has(name)) throw new ZipError(`Posten "${name}" finns två gånger i zip-filen.`);
    seen.add(name);
    if (flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) {
      throw new ZipError(`Posten "${name}" är krypterad (lösenordsskyddad) och kan inte läsas.`);
    }
    if (startDisk !== 0) throw new ZipError('Zip-filer som är delade över flera diskar tas inte emot.');
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) throw new ZipError('Zip64-filer tas inte emot.');
    if (name.endsWith('/')) continue; // a directory: nothing to read
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
      throw new ZipError(`Posten "${name}" är packad med en metod (${method}) som inte stöds; bara lagrad och deflate läses.`);
    }
    if (uncompressedSize > lim.maxEntryBytes) {
      throw new ZipError(`Posten "${name}" är större än ${Math.round(lim.maxEntryBytes / MB)} MB uppackad.`);
    }
    totalBytes += uncompressedSize;
    if (totalBytes > lim.maxTotalBytes) {
      throw new ZipError(`Zip-filen är större än ${Math.round(lim.maxTotalBytes / MB)} MB uppackad.`);
    }
    if (uncompressedSize > compressedSize * lim.maxRatio) {
      throw new ZipError(`Posten "${name}" är packad mer än ${lim.maxRatio} gånger (komprimeringsbomb?) och tas inte emot.`);
    }
    entries.push({ name, method, crc, compressedSize, uncompressedSize, localOffset });
  }

  // 2. Where each entry's bytes are, and that no two entries share any.
  const spans = entries.map((entry) => {
    const header = entry.localOffset;
    if (header + LOCAL_HEADER_BYTES > directoryOffset || buf.readUInt32LE(header) !== SIG_LOCAL) {
      throw new ZipError(`Posten "${entry.name}" har en skadad rubrik.`);
    }
    const dataStart = header + LOCAL_HEADER_BYTES + buf.readUInt16LE(header + 26) + buf.readUInt16LE(header + 28);
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > directoryOffset) throw new ZipError(`Posten "${entry.name}" ligger utanför filen.`);
    return { entry, header, dataStart, dataEnd };
  });
  const byOffset = [...spans].sort((a, b) => a.header - b.header);
  for (let i = 1; i < byOffset.length; i += 1) {
    if (byOffset[i]!.header < byOffset[i - 1]!.dataEnd) {
      throw new ZipError(`Posterna "${byOffset[i - 1]!.entry.name}" och "${byOffset[i]!.entry.name}" överlappar varandra.`);
    }
  }

  // 3. Inflate, in the order of the directory, each under its declared size.
  const result = new Map<string, Buffer>();
  for (const { entry, dataStart, dataEnd } of spans) {
    const packed = buf.subarray(dataStart, dataEnd);
    let data: Buffer;
    if (entry.method === METHOD_STORED) {
      if (entry.compressedSize !== entry.uncompressedSize) {
        throw new ZipError(`Posten "${entry.name}" har olika storlek lagrad och uppackad.`);
      }
      data = Buffer.from(packed);
    } else {
      try {
        // maxOutputLength must be at least 1; an empty entry is checked by length below.
        data = inflateRawSync(packed, { maxOutputLength: Math.max(1, entry.uncompressedSize) });
      } catch {
        throw new ZipError(`Posten "${entry.name}" kunde inte packas upp: den är skadad eller större än den uppger.`);
      }
    }
    if (data.length !== entry.uncompressedSize) {
      throw new ZipError(`Posten "${entry.name}" har en annan storlek än zip-filen uppger.`);
    }
    if (crc32(data) !== entry.crc) throw new ZipError(`Posten "${entry.name}" är skadad (kontrollsumman stämmer inte).`);
    result.set(entry.name, data);
  }
  return result;
}

export interface ZipEntryInput {
  name: string;
  data: Buffer;
}

/** The most entries a zip without zip64 can hold (0xFFFF is the zip64 marker). */
const WRITE_MAX_ENTRIES = 0xfffe;

/**
 * Writes entries in the order given, each deflated (level 9) with a fixed
 * timestamp. Throws ZipError for a name the reader would refuse, for a name
 * used twice and for more entries than a zip without zip64 can hold. Sizes
 * beyond 4 GB are not checked: nothing this feature writes is within a
 * thousandth of that (xlsx.ts caps a sheet at 20 000 rows).
 */
export function writeZip(entries: ZipEntryInput[]): Buffer {
  if (entries.length > WRITE_MAX_ENTRIES) throw new ZipError(`Högst ${WRITE_MAX_ENTRIES} poster ryms i en zip-fil.`);
  const seen = new Set<string>();
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const problem = nameProblem(name);
    if (problem !== null) throw new ZipError(`Posten "${name}" kan inte skrivas: ${problem}.`);
    if (seen.has(name)) throw new ZipError(`Posten "${name}" används två gånger.`);
    seen.add(name);

    const nameBytes = Buffer.from(name, 'utf8');
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const flags = nameBytes.length === name.length ? 0 : FLAG_UTF8_NAME;

    const local = Buffer.alloc(LOCAL_HEADER_BYTES);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0 (deflate)
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(METHOD_DEFLATE, 8);
    local.writeUInt16LE(DOS_TIME_MIDNIGHT, 10);
    local.writeUInt16LE(DOS_DATE_1980, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // no extra field

    const central = Buffer.alloc(CENTRAL_HEADER_BYTES);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4); // version made by: 2.0, MS-DOS attributes
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(METHOD_DEFLATE, 10);
    central.writeUInt16LE(DOS_TIME_MIDNIGHT, 12);
    central.writeUInt16LE(DOS_DATE_1980, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    // extra field, comment, disk number, internal and external attributes: zero.
    central.writeUInt32LE(offset, 42);

    parts.push(local, nameBytes, packed);
    directory.push(central, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }

  const directoryBytes = Buffer.concat(directory);
  const end = Buffer.alloc(END_RECORD_BYTES);
  end.writeUInt32LE(SIG_END, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directoryBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directoryBytes, end]);
}
