import type { ExecutionContext } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { newToken } from '../publication/public-token';
import { CalendarFeedThrottlerGuard, PER_CLIENT, PER_FEED, SWEEP_ABOVE } from './calendar-feed-throttler.guard';

/**
 * The calendar feed's own rate limit (20261112091000): per asking address
 * and per feed, the feed's counted only for a request the client's let
 * through and a token of a feed's shape, both maps bounded.
 */

function call(target: CalendarFeedThrottlerGuard, file: string, ip: string, headers: Record<string, string> = {}) {
  const response = { headers: {} as Record<string, string>, setHeader(name: string, value: string) { this.headers[name] = value; } };
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({ ip, headers, params: { file } }),
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
  return {
    response,
    outcome: target.canActivate(context).then(
      () => 200,
      (error: unknown) => (error instanceof ThrottlerException ? 429 : Promise.reject(error)),
    ),
  };
}

describe('CalendarFeedThrottlerGuard', () => {
  it('stops a feed asked too often, from one address or many, and leaves the address its other feeds', async () => {
    const feeds = new CalendarFeedThrottlerGuard();
    const token = newToken();
    for (let i = 0; i < PER_FEED.limit; i++) expect(await call(feeds, `${token}.ics`, '203.0.113.7').outcome).toBe(200);
    expect(await call(feeds, `${token}.ics`, '203.0.113.7').outcome).toBe(429);
    // Without .ics it is the same feed, and from another address too.
    expect(await call(feeds, token, '198.51.100.9').outcome).toBe(429);
    expect(await call(feeds, `${newToken()}.ics`, '203.0.113.7').outcome).toBe(200);
  });

  it('counts an address by the hop the API trusts, whatever headers the caller sends', async () => {
    const feeds = new CalendarFeedThrottlerGuard();
    for (let i = 0; i < PER_CLIENT.limit; i++) {
      const spoofed = { 'x-forwarded-for': `192.0.2.${i % 250}`, 'x-real-ip': `192.0.2.${i % 250}`, 'x-viewer-client-ip': `192.0.2.${i % 250}` };
      expect(await call(feeds, `${newToken()}.ics`, '203.0.113.8', spoofed).outcome).toBe(200);
    }
    expect(await call(feeds, `${newToken()}.ics`, '203.0.113.8', { 'x-forwarded-for': '192.0.2.251' }).outcome).toBe(429);
    expect(await call(feeds, `${newToken()}.ics`, '203.0.113.9').outcome).toBe(200);
  });

  it('costs no feed a hit for a request the address limit refused', async () => {
    const feeds = new CalendarFeedThrottlerGuard();
    const token = newToken();
    for (let i = 0; i < PER_CLIENT.limit; i++) await call(feeds, `${newToken()}.ics`, '203.0.113.10').outcome;
    for (let i = 0; i < PER_FEED.limit + 5; i++) expect(await call(feeds, `${token}.ics`, '203.0.113.10').outcome).toBe(429);
    // The feed itself was never counted: another calendar asks it in full.
    for (let i = 0; i < PER_FEED.limit; i++) expect(await call(feeds, `${token}.ics`, '198.51.100.10').outcome).toBe(200);
  });

  it('holds no feed key for a token that cannot be a feed, and drops the keys of random ones once idle past their window', async () => {
    const feeds = new CalendarFeedThrottlerGuard();
    for (let i = 0; i < 500; i++) await call(feeds, `x${i}.ics`, '203.0.113.11').outcome;
    expect(feeds.keysHeld.feeds).toBe(0);
    let now = 0;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const swept = new CalendarFeedThrottlerGuard();
      for (let round = 0; round < 3; round++) {
        for (let i = 0; i < SWEEP_ABOVE; i++) await call(swept, `${newToken()}.ics`, `10.${round}.${i >> 8}.${i & 255}`).outcome;
        now += PER_FEED.ttl + 1_000;
      }
      expect(swept.keysHeld.feeds).toBeLessThanOrEqual(SWEEP_ABOVE + 1);
      expect(swept.keysHeld.clients).toBeLessThanOrEqual(SWEEP_ABOVE + 1);
    } finally {
      Date.now = realNow;
    }
  });

  it('answers a refusal with when to come back, no-store, noindex and no-referrer', async () => {
    const feeds = new CalendarFeedThrottlerGuard();
    const token = newToken();
    for (let i = 0; i < PER_FEED.limit; i++) await call(feeds, `${token}.ics`, '203.0.113.12').outcome;
    const refused = call(feeds, `${token}.ics`, '203.0.113.12');
    expect(await refused.outcome).toBe(429);
    expect(Number(refused.response.headers['Retry-After'])).toBeGreaterThan(0);
    expect(refused.response.headers).toMatchObject({
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      'Referrer-Policy': 'no-referrer',
    });
  });
});
