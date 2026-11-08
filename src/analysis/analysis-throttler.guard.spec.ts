import type { ExecutionContext } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import { ANALYSIS_RATE_LIMITED, AnalysisThrottlerGuard, PER_ADDRESS, PER_LOGIN } from './analysis-throttler.guard';

/**
 * The four views build a school's figures in the API process, so they are limited per verified login and route,
 * never per address: a school's staff arrive from the one address of its NAT.
 */
describe('AnalysisThrottlerGuard', () => {
  const contextFor = (request: Record<string, unknown>, handler: string, headers: Record<string, string> = {}) =>
    ({
      getHandler: () => ({ name: handler }),
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({ setHeader: (name: string, value: string) => (headers[name] = value) }),
      }),
    }) as unknown as ExecutionContext;

  it('keeps the limits DEPLOYMENT.md §16.3 states: 20 a minute for a login and route, 600 for an address', () => {
    expect(PER_LOGIN).toEqual({ limit: 20, ttl: 60_000 });
    expect(PER_ADDRESS).toEqual({ limit: 600, ttl: 60_000 });
  });

  it('lets one login through PER_LOGIN.limit times a window, then refuses it 429 with Retry-After and a code', async () => {
    const guard = new AnalysisThrottlerGuard();
    const anna = { ip: '10.0.0.1', user: { authId: 'anna' } };
    for (let i = 0; i < PER_LOGIN.limit; i++) {
      await expect(guard.canActivate(contextFor(anna, 'keyFigures'))).resolves.toBe(true);
    }
    const headers: Record<string, string> = {};
    const refused = await guard.canActivate(contextFor(anna, 'keyFigures', headers)).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(HttpException);
    expect((refused as HttpException).getStatus()).toBe(429);
    expect((refused as HttpException).getResponse()).toMatchObject({ code: ANALYSIS_RATE_LIMITED });
    expect(Number(headers['Retry-After'])).toBeGreaterThanOrEqual(1);
  });

  it('gives two administrators on the same address a quota each, and each view its own', async () => {
    const guard = new AnalysisThrottlerGuard();
    for (let i = 0; i < PER_LOGIN.limit; i++) await guard.canActivate(contextFor({ ip: '10.0.0.1', user: { authId: 'anna' } }, 'keyFigures'));
    await expect(guard.canActivate(contextFor({ ip: '10.0.0.1', user: { authId: 'anna' } }, 'keyFigures'))).rejects.toBeInstanceOf(HttpException);
    await expect(guard.canActivate(contextFor({ ip: '10.0.0.1', user: { authId: 'bo' } }, 'keyFigures'))).resolves.toBe(true);
    await expect(guard.canActivate(contextFor({ ip: '10.0.0.1', user: { authId: 'anna' } }, 'costBasis'))).resolves.toBe(true);
  });

  it('keys a request without a login on its address, or on unknown, and holds no login id', async () => {
    const guard = new AnalysisThrottlerGuard();
    await guard.canActivate(contextFor({ ip: '10.0.0.2' }, 'keyFigures'));
    await guard.canActivate(contextFor({}, 'keyFigures'));
    await guard.canActivate(contextFor({ ip: '10.0.0.2', user: { authId: 'anna' } }, 'keyFigures'));
    expect(guard.keysHeld).toBe(3);
    const keys = [...(guard as unknown as { logins: { entries: Map<string, unknown> } }).logins.entries.keys()];
    expect(keys.every((key) => /^analysis\u0000[0-9a-f]{64}$/.test(key))).toBe(true);
  });
});
