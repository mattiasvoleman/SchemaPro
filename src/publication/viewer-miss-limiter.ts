import { timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { PublicViewerConfig } from '../config/configuration';
import { WindowedThrottlerStorage } from '../common/windowed-throttler-storage';

/**
 * How many links or codes one address may try that turn out not to exist: a
 * family that mistypes a code a few times is far below it, and a program
 * trying codes one after another is stopped after thirty, for five minutes.
 * The code is 100 random bits, so this is not what keeps it secret; it keeps
 * a guesser from being answered at the speed of the database, and a token or
 * a code on a letter that was never issued from being tried for ever.
 */
export const MISSES = { limit: 30, ttl: 60_000, block: 300_000 };
/** Keys held before the first sweep of idle ones (WindowedThrottlerStorage). */
export const MISS_SWEEP_ABOVE = 10_000;
const NAME = 'viewer-miss';

/**
 * The viewer's second rate limit, charged after the fact: every request that
 * ends in the viewer's one 404 costs the asking address a miss, and an
 * address that has spent its misses is refused (429, before the database is
 * asked) until the block runs out. A hit costs nothing, so a school opening
 * one link from many addresses is never slowed by it.
 *
 * It also decides which address a request came from, for the viewer's other
 * limit too: the web server's word for it (X-Viewer-Client-Ip), but only
 * beside X-Viewer-Proxy-Key equal, in constant time, to
 * PUBLIC_VIEWER_PROXY_KEY; anybody else's header is ignored and the caller's
 * own address is used.
 */
@Injectable()
export class ViewerMissLimiter {
  private readonly misses = new WindowedThrottlerStorage(Date.now, { sweepAbove: MISS_SWEEP_ABOVE });
  private readonly proxyKey: Buffer | null;

  constructor(config: ConfigService) {
    const key = config.get<PublicViewerConfig>('publicViewer')?.proxyKey;
    this.proxyKey = key ? Buffer.from(key) : null;
  }

  /** The viewer's address: the web server's word for it, if the web server proves it is speaking. */
  clientOf(request: Request): string {
    const forwarded = request.headers['x-viewer-client-ip'];
    const key = request.headers['x-viewer-proxy-key'];
    if (this.proxyKey && typeof forwarded === 'string' && typeof key === 'string' && forwarded.length <= 64) {
      const given = Buffer.from(key);
      if (given.length === this.proxyKey.length && timingSafeEqual(given, this.proxyKey)) return `fwd:${forwarded.trim()}`;
    }
    return `ip:${request.ip ?? 'unknown'}`;
  }

  /** Whether the address has spent its misses. Counts nothing. */
  spent(client: string): boolean {
    return this.misses.isBlocked(client, NAME);
  }

  /** The address asked for something that is no link. */
  async miss(client: string): Promise<void> {
    await this.misses.increment(client, MISSES.ttl, MISSES.limit, MISSES.block, NAME);
  }

  /** Keys held, for the tests that bound them. */
  get keysHeld(): number {
    return this.misses.size;
  }
}
