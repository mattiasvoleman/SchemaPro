import type { ExecutionContext } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { PER_LOGIN, PerLoginThrottlerGuard } from './per-login-throttler.guard';

/**
 * GET /api/v1/me/schools arrives from the web server for everybody (Flera
 * skolor per inloggning), so it is limited per verified login, never per
 * address.
 */
describe('PerLoginThrottlerGuard', () => {
  const contextFor = (request: Record<string, unknown>, headers: Record<string, string> = {}) =>
    ({
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({ setHeader: (name: string, value: string) => (headers[name] = value) }),
      }),
    }) as unknown as ExecutionContext;

  it('lets one login through PER_LOGIN.limit times a window, and then refuses it with Retry-After', async () => {
    const guard = new PerLoginThrottlerGuard();
    const anna = { ip: '10.0.0.1', user: { authId: 'anna' } };
    for (let i = 0; i < PER_LOGIN.limit; i++) {
      await expect(guard.canActivate(contextFor(anna))).resolves.toBe(true);
    }
    const headers: Record<string, string> = {};
    await expect(guard.canActivate(contextFor(anna, headers))).rejects.toBeInstanceOf(ThrottlerException);
    expect(Number(headers['Retry-After'])).toBeGreaterThanOrEqual(1);
  });

  it('counts each login on its own, from the one address the web server sends them all from', async () => {
    const guard = new PerLoginThrottlerGuard();
    for (let i = 0; i < PER_LOGIN.limit; i++) {
      await guard.canActivate(contextFor({ ip: '10.0.0.1', user: { authId: 'anna' } }));
    }
    for (let person = 0; person < 50; person++) {
      await expect(guard.canActivate(contextFor({ ip: '10.0.0.1', user: { authId: `person-${person}` } }))).resolves.toBe(true);
    }
  });

  it('keys a request without a login on its address, and holds no login id', async () => {
    const guard = new PerLoginThrottlerGuard();
    await guard.canActivate(contextFor({ ip: '10.0.0.2' }));
    await guard.canActivate(contextFor({ ip: '10.0.0.2', user: { authId: 'anna' } }));
    expect(guard.keysHeld).toBe(2);
    const keys = [...(guard as unknown as { logins: { entries: Map<string, unknown> } }).logins.entries.keys()];
    expect(keys).toHaveLength(2);
    expect(keys.every((key) => /^login\u0000[0-9a-f]{64}$/.test(key))).toBe(true);
  });
});
