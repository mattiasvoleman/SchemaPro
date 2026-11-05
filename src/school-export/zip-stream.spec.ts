import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readZip } from '../schedule-exchange/zip';
import { ChunkSink } from './chunk-sink';
import { StreamingZip, ZipNameError, ZipTooLarge, type ByteSink } from './zip-stream';

class MemorySink implements ByteSink {
  readonly parts: Buffer[] = [];
  async write(chunk: Buffer): Promise<void> {
    this.parts.push(chunk);
  }
  get all(): Buffer {
    return Buffer.concat(this.parts);
  }
}

describe('StreamingZip', () => {
  it('writes entries a plain zip reader reads back, byte for byte', async () => {
    const sink = new MemorySink();
    const zip = new StreamingZip(sink);
    const big = randomBytes(300_000).toString('base64'); // compressible, bigger than one deflate block
    await zip.addFile('README.txt', async (w) => w.write('Hej\r\n'));
    await zip.addFile('data/narvaro.csv', async (w) => {
      for (let i = 0; i < 40; i += 1) await w.write(big.slice(i * 1000, i * 1000 + 1000));
    });
    await zip.addFile('tom.csv', async () => undefined);
    await zip.addFile('åäö.csv', async (w) => w.write('å'));
    await zip.finish();

    const read = readZip(sink.all);
    expect([...read.keys()]).toEqual(['README.txt', 'data/narvaro.csv', 'tom.csv', 'åäö.csv']);
    expect(read.get('README.txt')!.toString()).toBe('Hej\r\n');
    expect(read.get('data/narvaro.csv')!.toString()).toBe(big.slice(0, 40_000));
    expect(read.get('tom.csv')!.length).toBe(0);
    expect(read.get('åäö.csv')!.toString()).toBe('å');
  });

  it('is deterministic: the same rows are the same bytes', async () => {
    const make = async () => {
      const sink = new MemorySink();
      const zip = new StreamingZip(sink);
      await zip.addFile('a.csv', async (w) => w.write('x;y\r\n1;2\r\n'));
      await zip.addFile('b.csv', async (w) => w.write('z'));
      await zip.finish();
      return createHash('sha256').update(sink.all).digest('hex');
    };
    expect(await make()).toBe(await make());
  });

  it("is read by the system's unzip, which checks every CRC", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'k5-zip-'));
    try {
      const sink = new MemorySink();
      const zip = new StreamingZip(sink);
      const text = 'rad;två\r\n'.repeat(50_000);
      await zip.addFile('csv/a.csv', async (w) => w.write(text));
      await zip.addFile('manifest.json', async (w) => w.write('{"a":1}'));
      await zip.finish();
      writeFileSync(join(dir, 'x.zip'), sink.all);
      const out = execFileSync('unzip', ['-t', join(dir, 'x.zip')], { encoding: 'utf8' });
      expect(out).toMatch(/No errors detected/);
      execFileSync('unzip', ['-o', '-q', join(dir, 'x.zip'), '-d', join(dir, 'out')]);
      expect(readFileSync(join(dir, 'out', 'csv', 'a.csv'), 'utf8')).toBe(text);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('holds back the producer while the sink is slow, and fails the entry when the sink fails', async () => {
    let calls = 0;
    const failing: ByteSink = {
      async write() {
        calls += 1;
        if (calls > 3) throw new Error('database gone');
      },
    };
    const zip = new StreamingZip(failing);
    await expect(
      zip.addFile('a.csv', async (w) => {
        for (let i = 0; i < 200; i += 1) await w.write(randomBytes(40_000));
      }),
    ).rejects.toThrow('database gone');
  });

  it.each(['', '/abs.csv', '../x.csv', 'a/../b.csv', 'a\\b.csv', 'a//b.csv', 'C:x.csv', 'a\0b.csv'])('refuses the name %j', async (name) => {
    const zip = new StreamingZip(new MemorySink());
    await expect(zip.addFile(name, async () => undefined)).rejects.toBeInstanceOf(ZipNameError);
  });

  it('refuses two entries with one name, an entry opened inside an entry, and one after finish', async () => {
    const zip = new StreamingZip(new MemorySink());
    await zip.addFile('a.csv', async () => undefined);
    await expect(zip.addFile('a.csv', async () => undefined)).rejects.toBeInstanceOf(ZipNameError);
    await expect(zip.addFile('b.csv', async () => zip.addFile('c.csv', async () => undefined).then(() => undefined))).rejects.toThrow(/still being written/);
    await zip.finish();
    await expect(zip.addFile('d.csv', async () => undefined)).rejects.toThrow(/finished/);
  });

  it('says ZipTooLarge instead of writing a corrupt zip past 4 GiB', async () => {
    const zip = new StreamingZip({ write: async () => undefined });
    // Pretend the archive is nearly full: the next header pushes it over.
    (zip as unknown as { offset: number }).offset = 0xffffffff - 10;
    await expect(zip.addFile('a.csv', async () => undefined)).rejects.toBeInstanceOf(ZipTooLarge);
  });
});

describe('ChunkSink', () => {
  it('cuts the stream into pieces of the size asked, in order, with a short last one', async () => {
    const seen: Array<{ seq: number; bytes: Buffer }> = [];
    const sink = new ChunkSink(async (seq, bytes) => void seen.push({ seq, bytes: Buffer.from(bytes) }), 1000);
    const data = randomBytes(4321);
    for (let at = 0; at < data.length; ) {
      const n = 1 + ((at * 7) % 777);
      await sink.write(data.subarray(at, at + n));
      at += n;
    }
    const done = await sink.close();
    expect(seen.map((p) => p.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(seen.map((p) => p.bytes.length)).toEqual([1000, 1000, 1000, 1000, 321]);
    expect(Buffer.concat(seen.map((p) => p.bytes)).equals(data)).toBe(true);
    expect(done).toEqual({ bytes: 4321, chunks: 5, sha256: createHash('sha256').update(data).digest('hex') });
  });

  it('writes no piece for an empty file, and none extra for an exact multiple', async () => {
    const seen: number[] = [];
    const empty = new ChunkSink(async (seq) => void seen.push(seq), 10);
    expect(await empty.close()).toMatchObject({ bytes: 0, chunks: 0 });
    const exact = new ChunkSink(async (seq) => void seen.push(seq), 10);
    await exact.write(Buffer.alloc(20));
    expect(await exact.close()).toMatchObject({ bytes: 20, chunks: 2 });
    expect(seen).toEqual([0, 1]);
  });
});
