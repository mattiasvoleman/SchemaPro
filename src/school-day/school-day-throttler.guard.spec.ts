import type { ExecutionContext } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import { PER_LOGIN, RATE_LIMITED, SchoolDayThrottlerGuard } from './school-day-throttler.guard';

/**
 * The two reads that build a grid are limited per verified login and route, never per address: the web asks the
 * API from each person's browser, so a school's whole staff arrive from the one address of its NAT.
 */
describe('SchoolDayThrottlerGuard', () => {
  const contextFor = (request: Record<string, unknown>, handler: string, headers: Record<string, string> = {}) =>
    ({
      getHandler: () => ({ name: handler }),
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({ setHeader: (name: string, value: string) => (headers[name] = value) }),
      }),
    }) as unknown as ExecutionContext;

  it('lets one login through PER_LOGIN.limit times a window, then refuses it 429 with Retry-After and a code', async () => {
    const guard = new SchoolDayThrottlerGuard();
    const anna = { ip: '10.0.0.1', user: { authId: 'anna' } };
    for (let i = 0; i < PER_LOGIN.limit; i++) {
      await expect(guard.canActivate(contextFor(anna, 'grid'))).resolves.toBe(true);
    }
    const headers: Record<string, string> = {};
    const refused = await guard.canActivate(contextFor(anna, 'grid', headers)).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(HttpException);
    expect((refused as HttpException).getStatus()).toBe(429);
    expect((refused as HttpException).getResponse()).toMatchObject({ code: RATE_LIMITED });
    expect(Number(headers['Retry-After'])).toBeGreaterThanOrEqual(1);
  });

  it('gives two teachers on the same address a quota each: one using hers up leaves the other hers', async () => {
    const guard = new SchoolDayThrottlerGuard();
    for (let i = 0; i < PER_LOGIN.limit; i++) {
      await guard.canActivate(contextFor({ ip: '10.0.0.1', user: { authId: 'anna' } }, 'grid'));
    }
    await expect(guard.canActivate(contextFor({ ip: '10.0.0.1', user: { authId: 'anna' } }, 'grid'))).rejects.toBeInstanceOf(HttpException);
    // The whole staff of a school, from the one address: sixty teachers open the page in the same minute.
    for (let person = 0; person < 60; person++) {
      await expect(guard.canActivate(contextFor({ ip: '10.0.0.1', user: { authId: `teacher-${person}` } }, 'grid'))).resolves.toBe(true);
    }
  });

  it('counts the grid and the search apart: a login that has used up one still has the other', async () => {
    const guard = new SchoolDayThrottlerGuard();
    const bo = { ip: '10.0.0.3', user: { authId: 'bo' } };
    for (let i = 0; i < PER_LOGIN.limit; i++) await guard.canActivate(contextFor(bo, 'grid'));
    await expect(guard.canActivate(contextFor(bo, 'grid'))).rejects.toBeInstanceOf(HttpException);
    await expect(guard.canActivate(contextFor(bo, 'free'))).resolves.toBe(true);
  });

  it('keys a request without a login on its address, and holds no login id', async () => {
    const guard = new SchoolDayThrottlerGuard();
    await guard.canActivate(contextFor({ ip: '10.0.0.2' }, 'grid'));
    await guard.canActivate(contextFor({ ip: '10.0.0.2', user: { authId: 'anna' } }, 'grid'));
    expect(guard.keysHeld).toBe(2);
    const keys = [...(guard as unknown as { logins: { entries: Map<string, unknown> } }).logins.entries.keys()];
    expect(keys).toHaveLength(2);
    expect(keys.every((key) => /^school-day\u0000[0-9a-f]{64}$/.test(key))).toBe(true);
  });
});
