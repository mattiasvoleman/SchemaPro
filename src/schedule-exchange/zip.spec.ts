import { crc32, deflateRawSync } from 'node:zlib';
import { DEFAULT_ZIP_LIMITS, readZip, writeZip, ZipError } from './zip';

/**
 * A zip put together by hand, field by field, so that every refusal in the
 * reader has a file that provokes it. writeZip is the honest writer; this is
 * the dishonest one.
 */
interface RawEntry {
  name: string;
  /** The real bytes of the entry. */
  data: Buffer;
  method?: number;
  flags?: number;
  /** What the central directory claims, when it should lie. */
  crc?: number;
  compressedSize?: number;
  uncompressedSize?: number;
  startDisk?: number;
  /** The bytes stored after the local header, when they should not be the honest ones. */
  packed?: Buffer;
  /** Where the central directory says the local header is. */
  localOffset?: number;
  /** Extra bytes in the local header's extra field (to move the data). */
  localExtra?: Buffer;
  /** The name as bytes, when it should not be UTF-8. */
  nameBytes?: Buffer;
}

interface RawOptions {
  comment?: Buffer;
  thisDisk?: number;
  directoryDisk?: number;
  entriesOnDisk?: number;
  entryCount?: number;
  directoryOffset?: number;
  directorySize?: number;
  zip64Locator?: boolean;
}

function rawZip(entries: RawEntry[], options: RawOptions = {}): Buffer {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = entry.nameBytes ?? Buffer.from(entry.name, 'utf8');
    const method = entry.method ?? 8;
    const packed = entry.packed ?? (method === 8 ? deflateRawSync(entry.data) : entry.data);
    const extra = entry.localExtra ?? Buffer.alloc(0);
    const crc = entry.crc ?? crc32(entry.data);
    const compressedSize = entry.compressedSize ?? packed.length;
    const uncompressedSize = entry.uncompressedSize ?? entry.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.flags ?? 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(entry.startDisk ?? 0, 34);
    central.writeUInt32LE(entry.localOffset ?? offset, 42);
    parts.push(local, name, extra, packed);
    directory.push(central, name);
    offset += local.length + name.length + extra.length + packed.length;
  }
  const directoryBytes = Buffer.concat(directory);
  const comment = options.comment ?? Buffer.alloc(0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(options.thisDisk ?? 0, 4);
  end.writeUInt16LE(options.directoryDisk ?? 0, 6);
  end.writeUInt16LE(options.entriesOnDisk ?? entries.length, 8);
  end.writeUInt16LE(options.entryCount ?? entries.length, 10);
  end.writeUInt32LE(options.directorySize ?? directoryBytes.length, 12);
  end.writeUInt32LE(options.directoryOffset ?? offset, 16);
  end.writeUInt16LE(comment.length, 20);
  const locator = options.zip64Locator ? Buffer.concat([Buffer.from([0x50, 0x4b, 0x06, 0x07]), Buffer.alloc(16)]) : Buffer.alloc(0);
  return Buffer.concat([...parts, directoryBytes, locator, end, comment]);
}

const text = (value: string): Buffer => Buffer.from(value, 'utf8');
const entry = (name: string, content = `content of ${name}`, more: Partial<RawEntry> = {}): RawEntry => ({ name, data: text(content), ...more });

describe('writeZip and readZip', () => {
  it('round-trips entries, in order, with non-ASCII names and empty entries', () => {
    const entries = [
      { name: '[Content_Types].xml', data: text('<Types/>') },
      { name: 'xl/värden.xml', data: text('åäö '.repeat(500)) },
      { name: 'empty.txt', data: Buffer.alloc(0) },
      { name: 'binary.bin', data: Buffer.from([0, 255, 1, 254, 2, 253]) },
    ];
    const read = readZip(writeZip(entries));
    expect([...read.keys()]).toEqual(entries.map((e) => e.name));
    for (const e of entries) expect(read.get(e.name)).toEqual(e.data);
  });

  it('is deterministic: the same entries are the same bytes, with the 1980 DOS timestamp', () => {
    const entries = [{ name: 'a.txt', data: text('hello hello hello hello') }];
    const first = writeZip(entries);
    expect(writeZip(entries).equals(first)).toBe(true);
    // Local header: time at 10, date at 12 (1980-01-01 = 0x0021).
    expect(first.readUInt16LE(10)).toBe(0);
    expect(first.readUInt16LE(12)).toBe(0x21);
  });

  it('marks a non-ASCII name as UTF-8 and leaves an ASCII one unmarked', () => {
    const ascii = writeZip([{ name: 'a.txt', data: text('x') }]);
    const nordic = writeZip([{ name: 'å.txt', data: text('x') }]);
    expect(ascii.readUInt16LE(6) & 0x0800).toBe(0);
    expect(nordic.readUInt16LE(6) & 0x0800).toBe(0x0800);
  });

  it('writes an empty archive that reads as no entries', () => {
    expect(readZip(writeZip([])).size).toBe(0);
  });

  it('refuses to write a name the reader would refuse, a duplicate, or too many entries', () => {
    expect(() => writeZip([{ name: '../x', data: text('x') }])).toThrow(ZipError);
    expect(() => writeZip([{ name: 'a', data: text('x') }, { name: 'a', data: text('y') }])).toThrow(/används två gånger/);
    expect(() => writeZip(new Array(0xffff).fill({ name: 'a', data: Buffer.alloc(0) }))).toThrow(/Högst 65534/);
  });

  it('writes a file that unzip-compatible readers see: the central directory and end record agree', () => {
    const zip = writeZip([
      { name: 'one', data: text('1') },
      { name: 'two', data: text('22') },
    ]);
    const end = zip.length - 22;
    expect(zip.readUInt32LE(end)).toBe(0x06054b50);
    expect(zip.readUInt16LE(end + 10)).toBe(2);
    expect(zip.readUInt32LE(zip.readUInt32LE(end + 16))).toBe(0x02014b50);
  });
});

describe('readZip: what it reads', () => {
  it('reads stored entries and directory entries (left out of the result)', () => {
    const zip = rawZip([entry('dir/', '', { method: 0 }), entry('dir/a.txt', 'stored text', { method: 0 }), entry('dir/b.txt', 'deflated text')]);
    const read = readZip(zip);
    expect([...read.keys()]).toEqual(['dir/a.txt', 'dir/b.txt']);
    expect(read.get('dir/a.txt')!.toString()).toBe('stored text');
    expect(read.get('dir/b.txt')!.toString()).toBe('deflated text');
  });

  it('finds the data past a local extra field and a zip comment', () => {
    const zip = rawZip([entry('a.txt', 'abc', { localExtra: Buffer.from('EXTRA') })], { comment: text('a zip comment') });
    expect(readZip(zip).get('a.txt')!.toString()).toBe('abc');
  });

  it('is not fooled by an end-record signature inside the comment', () => {
    // A signature whose comment length does not reach the end of the file is not the end record.
    const fake = Buffer.alloc(22);
    fake.writeUInt32LE(0x06054b50, 0);
    const zip = rawZip([entry('a.txt', 'abc')], { comment: Buffer.concat([text('x'), fake, text('tail')]) });
    expect(readZip(zip).get('a.txt')!.toString()).toBe('abc');
  });

  it('reads a name as UTF-8 only when the zip says so, and as Latin-1 otherwise', () => {
    const bytes = Buffer.from('é.txt', 'utf8');
    expect([...readZip(rawZip([{ name: 'x', nameBytes: bytes, data: text('x'), flags: 0x0800 }])).keys()]).toEqual(['é.txt']);
    expect([...readZip(rawZip([{ name: 'x', nameBytes: bytes, data: text('x'), flags: 0 }])).keys()]).toEqual(['Ã©.txt']);
  });

  it('applies limits given by the caller over the defaults', () => {
    const zip = writeZip([
      { name: 'a', data: text('x') },
      { name: 'b', data: text('y') },
    ]);
    expect(() => readZip(zip, { maxEntries: 1 })).toThrow(/högst 1 tas emot/);
  });
});

describe('readZip: the structure it refuses', () => {
  it.each([
    ['a buffer shorter than an end record', Buffer.alloc(10), /för kort/],
    ['a buffer with no end record', Buffer.alloc(100), /slutposten saknas/],
    ['an end record whose comment does not reach the end of the file', Buffer.concat([rawZip([entry('a')]), Buffer.from('junk')]), /slutposten saknas/],
  ])('refuses %s', (_name, zip, message) => {
    expect(() => readZip(zip)).toThrow(ZipError);
    expect(() => readZip(zip)).toThrow(message);
  });

  it('refuses zip64 by name: the locator, and the all-ones markers', () => {
    expect(() => readZip(rawZip([entry('a')], { zip64Locator: true }))).toThrow(/Zip64/);
    expect(() => readZip(rawZip([entry('a')], { entryCount: 0xffff, entriesOnDisk: 0xffff }))).toThrow(/Zip64/);
    expect(() => readZip(rawZip([entry('a')], { directoryOffset: 0xffffffff }))).toThrow(/Zip64/);
    expect(() => readZip(rawZip([entry('a')], { directorySize: 0xffffffff }))).toThrow(/Zip64/);
    expect(() => readZip(rawZip([entry('a', 'x', { compressedSize: 0xffffffff })]))).toThrow(/Zip64/);
    expect(() => readZip(rawZip([entry('a', 'x', { uncompressedSize: 0xffffffff })]))).toThrow(/Zip64/);
  });

  it('refuses a split archive by name', () => {
    expect(() => readZip(rawZip([entry('a')], { thisDisk: 1 }))).toThrow(/flera diskar/);
    expect(() => readZip(rawZip([entry('a')], { directoryDisk: 1 }))).toThrow(/flera diskar/);
    expect(() => readZip(rawZip([entry('a')], { entriesOnDisk: 0 }))).toThrow(/flera diskar/);
    expect(() => readZip(rawZip([entry('a', 'x', { startDisk: 1 })]))).toThrow(/flera diskar/);
  });

  it('refuses a central directory outside the file or cut short', () => {
    expect(() => readZip(rawZip([entry('a')], { directoryOffset: 5000 }))).toThrow(/utanför filen/);
    // The directory claims 3 entries but holds 1.
    expect(() => readZip(rawZip([entry('a')], { entryCount: 3, entriesOnDisk: 3 }))).toThrow(/innehållsförteckning är skadad/);
    // The directory size cuts an entry's name in half.
    expect(() => readZip(rawZip([entry('abcdef')], { directorySize: 50 }))).toThrow(/innehållsförteckning är skadad/);
    // The directory starts in the middle of nothing.
    expect(() => readZip(rawZip([entry('a')], { directoryOffset: 3, directorySize: 80 }))).toThrow(/innehållsförteckning är skadad/);
  });

  it('refuses a local header that is missing, outside the file, or whose data runs past the directory', () => {
    expect(() => readZip(rawZip([entry('a', 'x', { localOffset: 3 })]))).toThrow(/skadad rubrik/);
    expect(() => readZip(rawZip([entry('a', 'x', { localOffset: 90000 })]))).toThrow(/skadad rubrik/);
    expect(() => readZip(rawZip([entry('a', 'x', { compressedSize: 9000 })]))).toThrow(/ligger utanför filen/);
  });

  it('refuses entries whose bytes overlap', () => {
    const honest = rawZip([entry('a', 'first'), entry('b', 'second')]);
    expect(() => readZip(honest)).not.toThrow();
    // Both entries point at the first local header: one deflate stream, two names.
    expect(() => readZip(rawZip([entry('a', 'first'), entry('b', 'first', { localOffset: 0 })]))).toThrow(/överlappar/);
  });
});

describe('readZip: the entries it refuses', () => {
  it('refuses encryption by name', () => {
    expect(() => readZip(rawZip([entry('a', 'x', { flags: 0x0001 })]))).toThrow(/krypterad/);
    expect(() => readZip(rawZip([entry('a', 'x', { flags: 0x0040 })]))).toThrow(/krypterad/);
  });

  it('refuses a compression method other than stored and deflate', () => {
    expect(() => readZip(rawZip([entry('a', 'x', { method: 12, packed: text('x') })]))).toThrow(/metod \(12\)/);
  });

  it.each([
    ['a parent directory', '../evil.xml'],
    ['a parent directory in the middle', 'xl/../../evil.xml'],
    ['an absolute path', '/etc/passwd'],
    ['a drive letter', 'C:evil.xml'],
    ['a backslash', 'xl\\sheet.xml'],
    ['a NUL', 'a\0b'],
    ['an empty name', ''],
  ])('refuses %s as a name', (_what, name) => {
    expect(() => readZip(rawZip([entry(name)]))).toThrow(ZipError);
    expect(() => readZip(rawZip([entry(name)]))).toThrow(/tas inte emot/);
  });

  it('accepts a name that merely contains dots', () => {
    expect([...readZip(rawZip([entry('a..b.xml'), entry('./c.xml'), entry('..d/e.xml')])).keys()]).toEqual(['a..b.xml', './c.xml', '..d/e.xml']);
  });

  it('refuses two entries with the same name', () => {
    expect(() => readZip(rawZip([entry('a', 'one'), entry('a', 'two')]))).toThrow(/finns två gånger/);
  });

  it('refuses a stored entry whose two sizes differ', () => {
    expect(() => readZip(rawZip([entry('a', 'hello', { method: 0, uncompressedSize: 4 })]))).toThrow(/olika storlek/);
  });

  it('refuses a wrong checksum and a wrong declared size', () => {
    expect(() => readZip(rawZip([entry('a', 'hello world', { crc: 12345 })]))).toThrow(/kontrollsumman/);
    // Claims 5 bytes, holds 11: zlib stops at the declared size and the entry is refused.
    expect(() => readZip(rawZip([entry('a', 'hello world', { uncompressedSize: 5 })]))).toThrow(/packas upp/);
    // Claims 20 bytes, holds 11.
    expect(() => readZip(rawZip([entry('a', 'hello world', { uncompressedSize: 20 })]))).toThrow(/annan storlek/);
    // Claims empty, holds 11.
    expect(() => readZip(rawZip([entry('a', 'hello world', { uncompressedSize: 0 })]))).toThrow(/packas upp/);
  });

  it('refuses a deflate stream that is not one', () => {
    expect(() => readZip(rawZip([entry('a', 'hello', { packed: text('this is not deflate at all') })]))).toThrow(/packas upp/);
  });
});

describe('readZip: zip bombs', () => {
  it('refuses more than 64 entries by default', () => {
    const many = (n: number): Buffer => writeZip(Array.from({ length: n }, (_v, i) => ({ name: `f${i}`, data: text(`x${i}`) })));
    expect(readZip(many(64)).size).toBe(64);
    expect(() => readZip(many(65))).toThrow(/65 poster; högst 64/);
  });

  it('refuses an entry over 32 MB uncompressed, on the declared size, before inflating', () => {
    const big = Buffer.alloc(33 * 1024 * 1024);
    expect(() => readZip(rawZip([{ name: 'bomb.xml', data: big }]))).toThrow(/större än 32 MB/);
  });

  it('refuses an entry that claims to be small but inflates large, without inflating it', () => {
    // 1 MB of zeros declared as 100 bytes: the ratio is fine on paper, the stream is not.
    const honest = deflateRawSync(Buffer.alloc(1024 * 1024));
    const liar = rawZip([{ name: 'a', data: Buffer.alloc(100), packed: honest, crc: crc32(Buffer.alloc(100)) }], {});
    expect(() => readZip(liar, { maxRatio: 100000 })).toThrow(/packas upp/);
  });

  it('refuses a compression ratio over 200:1', () => {
    const zeros = Buffer.alloc(1024 * 1024);
    expect(() => readZip(writeZip([{ name: 'a', data: zeros }]))).toThrow(/mer än 200 gånger/);
    // ... and takes it when the caller allows it.
    expect(readZip(writeZip([{ name: 'a', data: zeros }]), { maxRatio: 100000 }).get('a')!.equals(zeros)).toBe(true);
  });

  it('refuses a total over the limit, counted on the declared sizes', () => {
    const zip = writeZip([
      { name: 'a', data: text('x'.repeat(60)) },
      { name: 'b', data: text('y'.repeat(60)) },
    ]);
    expect(() => readZip(zip, { maxTotalBytes: 100 })).toThrow(/Zip-filen är större än/);
    expect(readZip(zip, { maxTotalBytes: 120 }).size).toBe(2);
  });

  it('refuses an entry over a per-entry limit given by the caller', () => {
    expect(() => readZip(writeZip([{ name: 'a', data: text('x'.repeat(60)) }]), { maxEntryBytes: 50 })).toThrow(/uppackad/);
  });

  it('has the limits the brief names', () => {
    expect(DEFAULT_ZIP_LIMITS).toEqual({ maxEntries: 64, maxEntryBytes: 32 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024, maxRatio: 200 });
  });
});
