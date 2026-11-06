import { createHash } from 'node:crypto';
import type { ByteSink } from './zip-stream';

/**
 * The file's bytes cut into pieces of CHUNK_BYTES and handed to `put` one at a
 * time, in order, counting and hashing them as they pass. The file is never
 * whole in memory: at most one piece and the block that completes it. The
 * SHA-256 and the count are of the file as stored, which the download checks
 * on its way out.
 */
export class ChunkSink implements ByteSink {
  private parts: Buffer[] = [];
  private held = 0;
  private next = 0;
  private total = 0;
  private readonly hash = createHash('sha256');

  constructor(
    private readonly put: (seq: number, bytes: Buffer) => Promise<void>,
    private readonly chunkBytes: number,
  ) {
    if (!Number.isInteger(chunkBytes) || chunkBytes < 1) throw new RangeError('A piece holds at least one byte.');
  }

  async write(chunk: Buffer): Promise<void> {
    if (chunk.length === 0) return;
    this.hash.update(chunk);
    this.total += chunk.length;
    this.parts.push(chunk);
    this.held += chunk.length;
    if (this.held < this.chunkBytes) return;
    const all = this.parts.length === 1 ? this.parts[0]! : Buffer.concat(this.parts, this.held);
    let from = 0;
    while (all.length - from >= this.chunkBytes) {
      await this.put(this.next++, all.subarray(from, from + this.chunkBytes));
      from += this.chunkBytes;
    }
    this.parts = from < all.length ? [Buffer.from(all.subarray(from))] : [];
    this.held = all.length - from;
  }

  /** The last, short piece, and the file's totals. */
  async close(): Promise<{ bytes: number; chunks: number; sha256: string }> {
    if (this.held > 0) {
      await this.put(this.next++, Buffer.concat(this.parts, this.held));
      this.parts = [];
      this.held = 0;
    }
    return { bytes: this.total, chunks: this.next, sha256: this.hash.digest('hex') };
  }
}
