import { isIPv4, isIPv6 } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { PublicViewerConfig } from '../config/configuration';
import { WindowedThrottlerStorage } from '../common/windowed-throttler-storage';

/**
 * How many links or codes one address may try that turn out not to exist: a
 * family that mistypes a code a few times is far below it, and a program
 * trying codes one after another is stopped after sixty, for two minutes.
 * The code is 100 random bits, so this is not what keeps it secret; it keeps
 * a guesser from being answered at the speed of the database, and a token or
 * a code on a letter that was never issued from being tried for ever.
 *
 * The block is short because an address can be shared (a school's network, a
 * mobile operator's): a refusal that lasted minutes would shut every family
 * behind it for the sake of one.
 */
export const MISSES = { limit: 60, ttl: 60_000, block: 120_000 };
/** What one signed-in person, and one link, may read through the staff route in a minute. */
export const PER_PERSON = { limit: 120, ttl: 60_000 };
export const PER_STAFF_LINK = { limit: 600, ttl: 60_000 };
/** Keys held before the first sweep of idle ones (WindowedThrottlerStorage). */
export const MISS_SWEEP_ABOVE = 10_000;
const MISS = 'viewer-miss';
const HIT = 'viewer-staff-hit';

/**
 * An address as one client: an IPv4 address as it is, an IPv6 address as its
 * /64 (what one subscriber is given, so a program that rolls through its own
 * /64 is one client and not four quintillion), an IPv4-mapped IPv6 address
 * as the IPv4 it carries. Anything else as it stands.
 */
export function clientOfAddress(address: string): string {
  const trimmed = address.trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);
  if (mapped) return mapped[1]!;
  if (isIPv4(trimmed) || !isIPv6(trimmed)) return trimmed;
  // Expand "::" to the groups it stands for, then keep the first four.
  const [head = '', tail = ''] = trimmed.split('::');
  const first = head === '' ? [] : head.split(':');
  const last = tail === '' || !trimmed.includes('::') ? [] : tail.split(':');
  const groups = trimmed.includes('::') ? [...first, ...Array<string>(Math.max(0, 8 - first.length - last.length)).fill('0'), ...last] : first;
  return `${groups
    .slice(0, 4)
    .map((group) => group.toLowerCase().replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

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
 *
 * WITHOUT THE KEY it keeps no count of misses by address: every visitor then
 * reaches the gateway from the web server's address, and one program asking
 * for a few dozen codes that do not exist would shut the viewer for every
 * family. The code's size is what keeps a code secret, and the hit limits
 * are where they were; the one thing lost is the refusal of a guesser. It
 * says so at start-up. A signed-in person is counted either way: they are
 * their own client.
 */
@Injectable()
export class ViewerMissLimiter {
  private readonly logger = new Logger(ViewerMissLimiter.name);
  private readonly misses = new WindowedThrottlerStorage(Date.now, { sweepAbove: MISS_SWEEP_ABOVE });
  private readonly hits = new WindowedThrottlerStorage(Date.now, { sweepAbove: MISS_SWEEP_ABOVE });
  private readonly proxyKey: Buffer | null;

  constructor(config: ConfigService) {
    const key = config.get<PublicViewerConfig>('publicViewer')?.proxyKey;
    this.proxyKey = key ? Buffer.from(key) : null;
    if (this.proxyKey === null) {
      this.logger.warn(
        'PUBLIC_VIEWER_PROXY_KEY is not set: every visitor of Schemavisaren reaches the gateway from the web server\'s address, so links and codes that do not exist are not counted per visitor. Set the same key on the gateway and the web app (docs/DEPLOYMENT.md).',
      );
    }
  }

  /** The viewer's address: the web server's word for it, if the web server proves it is speaking. */
  clientOf(request: Request): string {
    const forwarded = request.headers['x-viewer-client-ip'];
    const key = request.headers['x-viewer-proxy-key'];
    if (this.proxyKey && typeof forwarded === 'string' && typeof key === 'string' && forwarded.length <= 64) {
      const given = Buffer.from(key);
      if (given.length === this.proxyKey.length && timingSafeEqual(given, this.proxyKey)) return `fwd:${clientOfAddress(forwarded)}`;
    }
    return `ip:${clientOfAddress(request.ip ?? 'unknown')}`;
  }

  /** Whether misses are counted for this client: a person always, an address only where addresses are told apart. */
  private counts(client: string): boolean {
    return this.proxyKey !== null || client.startsWith('user:');
  }

  /** Whether the client has spent its misses. Counts nothing. */
  spent(client: string): boolean {
    return this.counts(client) && this.misses.isBlocked(client, MISS);
  }

  /** The client asked for something that is no link. */
  async miss(client: string): Promise<void> {
    if (!this.counts(client)) return;
    await this.misses.increment(client, MISSES.ttl, MISSES.limit, MISSES.block, MISS);
  }

  /** A hit by a signed-in person or on a link, charged against a limit of its own. Returns the seconds to wait, or 0. */
  async charge(key: string, limit: { limit: number; ttl: number }): Promise<number> {
    const record = await this.hits.increment(key, limit.ttl, limit.limit, limit.ttl, HIT);
    return record.isBlocked ? Math.max(record.timeToBlockExpire, 1) : 0;
  }

  /** Keys held, for the tests that bound them. */
  get keysHeld(): number {
    return this.misses.size + this.hits.size;
  }
}
