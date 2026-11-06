/**
 * A zip writer that never holds a file: each entry is deflated as it is
 * written and its bytes go to the sink at once, so the whole-school export of
 * a school with a year of attendance needs memory for one batch of rows and
 * one piece of the file, not for the file (src/schedule-exchange/zip.ts holds
 * a whole archive in memory, which is right for a timetable of kilobytes).
 *
 * The format is the plain zip every program reads:
 *
 *   - each entry has a local header with general-purpose flag bit 3 set (its
 *     CRC-32 and sizes are not known until the data has been written and
 *     follow the data in a data descriptor) and bit 11 (UTF-8 names);
 *   - method 8, deflate, one stream per entry;
 *   - a central directory and an end-of-central-directory record at the end.
 *
 * Limits, each a refusal with a name rather than a corrupt file: no zip64
 * (an entry, or the archive, past 4 GiB, or more than 65 535 entries, is
 * ZipTooLarge: the export splits its big files long before that, at a million
 * rows); names are checked as the reader of the school's own uploads checks
 * them (no `..`, no leading `/`, no backslash, no NUL, no duplicates).
 *
 * Deterministic: a fixed DOS timestamp (1980-01-01 00:00:00), no extra fields
 * and deflate at level 6, so the same rows are the same bytes and an export
 * can be compared with another.
 *
 * CRC-32 is zlib.crc32 (Node 22.2 and later; the engines field is >= 22.12).
 */

import { once } from 'node:events';
import { createDeflateRaw, crc32, type DeflateRaw } from 'node:zlib';

export class ZipTooLarge extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipTooLarge';
  }
}

export class ZipNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipNameError';
  }
}

/** Where the archive's bytes go, in order; resolves when the sink has taken them. */
export interface ByteSink {
  write(chunk: Buffer): Promise<void>;
}

const LOCAL_SIGNATURE = 0x04034b50;
const DESCRIPTOR_SIGNATURE = 0x08074b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const FLAGS = 0x0808;
const METHOD_DEFLATE = 8;
/** 1980-01-01 00:00:00 in DOS time and date. */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const MAX_32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;

export interface ZipEntryResult {
  name: string;
  /** Bytes before deflate. */
  size: number;
  compressedSize: number;
  crc32: number;
}

interface CentralRecord extends ZipEntryResult {
  offset: number;
}

/** What a producer writes an entry's content with. */
export interface EntryWriter {
  write(data: Buffer | string): Promise<void>;
}

export function checkEntryName(name: string): void {
  if (name === '' || name.length > 255) throw new ZipNameError('A zip entry name is 1 to 255 characters.');
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw new ZipNameError(`A zip entry name is not absolute: ${name}`);
  if (name.includes('\\') || name.includes('\0')) throw new ZipNameError(`A zip entry name has no backslash or NUL: ${name}`);
  if (name.split('/').some((part) => part === '..' || part === '')) throw new ZipNameError(`A zip entry name has no empty or .. part: ${name}`);
}

export class StreamingZip {
  private offset = 0;
  private readonly central: CentralRecord[] = [];
  private readonly names = new Set<string>();
  private finished = false;
  private open = false;

  constructor(private readonly sink: ByteSink) {}

  /** Bytes handed to the sink so far. */
  get bytes(): number {
    return this.offset;
  }

  private async emit(buffer: Buffer): Promise<void> {
    this.offset += buffer.length;
    if (this.offset > MAX_32) throw new ZipTooLarge('The archive is past 4 GiB, which a plain zip cannot hold.');
    await this.sink.write(buffer);
  }

  /**
   * One entry: `produce` writes its content through the writer it is given;
   * the entry is closed when `produce` returns. One entry at a time.
   */
  async addFile(name: string, produce: (writer: EntryWriter) => Promise<void>): Promise<ZipEntryResult> {
    if (this.finished) throw new Error('The archive is finished.');
    if (this.open) throw new Error('An entry is still being written.');
    checkEntryName(name);
    if (this.names.has(name)) throw new ZipNameError(`Two zip entries are named ${name}.`);
    if (this.central.length >= MAX_ENTRIES) throw new ZipTooLarge('A plain zip holds at most 65 535 entries.');
    this.names.add(name);
    this.open = true;
    const nameBytes = Buffer.from(name, 'utf8');
    const offset = this.offset;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL_SIGNATURE, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(FLAGS, 6);
    header.writeUInt16LE(METHOD_DEFLATE, 8);
    header.writeUInt16LE(DOS_TIME, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    // CRC-32 and both sizes follow the data (bit 3).
    header.writeUInt16LE(nameBytes.length, 26);
    await this.emit(Buffer.concat([header, nameBytes]));

    const entry = new DeflatedEntry((chunk) => this.emit(chunk));
    try {
      await produce(entry);
      await entry.end();
    } catch (error) {
      entry.abort();
      this.open = false;
      throw error;
    }
    const { size, compressedSize, crc } = entry.totals();
    if (size > MAX_32 || compressedSize > MAX_32) {
      this.open = false;
      throw new ZipTooLarge(`${name} is past 4 GiB, which a plain zip cannot hold.`);
    }
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(DESCRIPTOR_SIGNATURE, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(compressedSize, 8);
    descriptor.writeUInt32LE(size, 12);
    await this.emit(descriptor);
    this.central.push({ name, size, compressedSize, crc32: crc, offset });
    this.open = false;
    return { name, size, compressedSize, crc32: crc };
  }

  /** The central directory and the end record. After it nothing can be added. */
  async finish(): Promise<void> {
    if (this.finished) return;
    if (this.open) throw new Error('An entry is still being written.');
    const directoryStart = this.offset;
    for (const record of this.central) {
      const nameBytes = Buffer.from(record.name, 'utf8');
      const entry = Buffer.alloc(46);
      entry.writeUInt32LE(CENTRAL_SIGNATURE, 0);
      entry.writeUInt16LE(20, 4);
      entry.writeUInt16LE(20, 6);
      entry.writeUInt16LE(FLAGS, 8);
      entry.writeUInt16LE(METHOD_DEFLATE, 10);
      entry.writeUInt16LE(DOS_TIME, 12);
      entry.writeUInt16LE(DOS_DATE, 14);
      entry.writeUInt32LE(record.crc32, 16);
      entry.writeUInt32LE(record.compressedSize, 20);
      entry.writeUInt32LE(record.size, 24);
      entry.writeUInt16LE(nameBytes.length, 28);
      entry.writeUInt32LE(record.offset, 42);
      await this.emit(Buffer.concat([entry, nameBytes]));
    }
    const directorySize = this.offset - directoryStart;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(END_SIGNATURE, 0);
    end.writeUInt16LE(this.central.length, 8);
    end.writeUInt16LE(this.central.length, 10);
    end.writeUInt32LE(directorySize, 12);
    end.writeUInt32LE(directoryStart, 16);
    await this.emit(end);
    this.finished = true;
  }
}

/**
 * One deflate stream feeding the sink. `write` resolves when the compressed
 * bytes so far have been taken by the sink, so a slow sink slows the producer
 * and the stream's own buffer never grows past a few blocks.
 */
class DeflatedEntry implements EntryWriter {
  private readonly deflate: DeflateRaw = createDeflateRaw({ level: 6 });
  private pending: Promise<void> = Promise.resolve();
  private failure: unknown = null;
  private crc = 0;
  private size = 0;
  private compressed = 0;
  private aborted = false;
  private readonly ended: Promise<void>;

  constructor(private readonly emit: (chunk: Buffer) => Promise<void>) {
    this.deflate.on('data', (chunk: Buffer) => {
      this.compressed += chunk.length;
      this.pending = this.pending.then(() => (this.failure === null && !this.aborted ? this.emit(chunk) : undefined)).catch((error: unknown) => {
        this.failure ??= error;
      });
    });
    this.deflate.on('error', (error) => {
      this.failure ??= error;
    });
    this.ended = new Promise<void>((resolve) => {
      this.deflate.once('end', () => resolve());
      this.deflate.once('error', () => resolve());
    });
  }

  async write(data: Buffer | string): Promise<void> {
    const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    if (buffer.length === 0) return;
    this.crc = crc32(buffer, this.crc);
    this.size += buffer.length;
    if (!this.deflate.write(buffer)) {
      await Promise.race([once(this.deflate, 'drain'), this.ended]);
    }
    await this.pending;
    if (this.failure !== null) throw this.failure;
  }

  async end(): Promise<void> {
    this.deflate.end();
    await this.ended;
    await this.pending;
    if (this.failure !== null) throw this.failure;
  }

  abort(): void {
    this.aborted = true;
    this.deflate.destroy();
  }

  totals(): { size: number; compressedSize: number; crc: number } {
    return { size: this.size, compressedSize: this.compressed, crc: this.crc >>> 0 };
  }
}
