import type { ExecutionContext } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { ConfigService } from '@nestjs/config';
import { PER_CLIENT, PER_LINK, PublicViewerThrottlerGuard, SWEEP_ABOVE } from './public-viewer-throttler.guard';
import { newToken } from './public-token';

const KEY = 'k'.repeat(32);

function guard(): PublicViewerThrottlerGuard {
  return new PublicViewerThrottlerGuard({ get: () => ({ proxyKey: KEY }) } as unknown as ConfigService);
}

function call(target: PublicViewerThrottlerGuard, token: string, ip: string, forwarded?: string) {
  const headers: Record<string, string> = forwarded ? { 'x-viewer-client-ip': forwarded, 'x-viewer-proxy-key': KEY } : {};
  const response = { headers: {} as Record<string, string>, setHeader(name: string, value: string) { this.headers[name] = value; } };
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({ ip, headers, params: { token } }),
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

describe('PublicViewerThrottlerGuard', () => {
  it('a client refused at its own limit costs the link nothing: one address cannot lock a link for everyone', async () => {
    const viewer = guard();
    const token = newToken();
    const tally: Record<number, number> = {};
    for (let i = 0; i < PER_LINK.limit + 1; i++) {
      const status = await call(viewer, token, '203.0.113.7').outcome;
      tally[status] = (tally[status] ?? 0) + 1;
    }
    expect(tally).toEqual({ 200: PER_CLIENT.limit, 429: PER_LINK.limit + 1 - PER_CLIENT.limit });
    // Another family, through the web server, still reads the link.
    expect(await call(viewer, token, '10.0.0.2', '198.51.100.200').outcome).toBe(200);
  });

  it('the link still stops when many addresses scrape it', async () => {
    const viewer = guard();
    const token = newToken();
    let refused = 0;
    for (let i = 0; i < PER_LINK.limit + 5; i++) {
      if ((await call(viewer, token, `198.51.100.${i % 200}`, `192.0.2.${i}`).outcome) === 429) refused++;
    }
    expect(refused).toBe(5);
  });

  it('holds no key for a token that cannot be a link, and a bounded number for random ones', async () => {
    const viewer = guard();
    for (let i = 0; i < 500; i++) await call(viewer, `x${i}`, '203.0.113.9', `192.0.2.${i % 250}`).outcome;
    expect(viewer.keysHeld.links).toBe(0);
    // Random well-formed tokens from many addresses: the map is swept of idle keys.
    let now = 0;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const swept = guard();
      for (let round = 0; round < 3; round++) {
        for (let i = 0; i < SWEEP_ABOVE; i++) await call(swept, newToken(), '10.0.0.2', `fwd-${round}-${i}`).outcome;
        now += 61_000;
      }
      expect(swept.keysHeld.links).toBeLessThanOrEqual(SWEEP_ABOVE + 1);
      expect(swept.keysHeld.clients).toBeLessThanOrEqual(SWEEP_ABOVE + 1);
    } finally {
      Date.now = realNow;
    }
  });

  it('answers a refusal with no-store, noindex and no-referrer', async () => {
    const viewer = guard();
    const token = newToken();
    for (let i = 0; i < PER_CLIENT.limit; i++) await call(viewer, token, '203.0.113.5').outcome;
    const refused = call(viewer, token, '203.0.113.5');
    expect(await refused.outcome).toBe(429);
    expect(refused.response.headers).toMatchObject({
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      'Referrer-Policy': 'no-referrer',
    });
  });
});
