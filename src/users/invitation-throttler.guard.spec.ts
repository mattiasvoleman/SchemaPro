import type { ExecutionContext } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { InvitationThrottlerGuard, PER_ADDRESS_INVITATIONS, PER_LOGIN_INVITATIONS } from './invitation-throttler.guard';
import { PerLoginThrottlerGuard } from './per-login-throttler.guard';

/**
 * POST /api/v1/users/invitations: a part of the mass invitation, per verified login, never per address. It was five a minute per address,
 * and a school is one address (the web calls the API from every browser behind one NAT): a run of fifteen parts was refused at the
 * sixth, and the block of the minute was every other administrator's too.
 */
describe('InvitationThrottlerGuard', () => {
  const contextFor = (request: Record<string, unknown>, headers: Record<string, string> = {}) =>
    ({
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({ setHeader: (name: string, value: string) => (headers[name] = value) }),
      }),
    }) as unknown as ExecutionContext;

  it('lets one login send thirty parts a minute, which is six times a run, and refuses the next with Retry-After', async () => {
    const guard = new InvitationThrottlerGuard();
    const rektor = { ip: '10.0.0.1', user: { authId: 'rektor' } };
    for (let i = 0; i < PER_LOGIN_INVITATIONS.limit; i += 1) {
      await expect(guard.canActivate(contextFor(rektor))).resolves.toBe(true);
    }
    const headers: Record<string, string> = {};
    await expect(guard.canActivate(contextFor(rektor, headers))).rejects.toBeInstanceOf(ThrottlerException);
    expect(Number(headers['Retry-After'])).toBeGreaterThanOrEqual(1);
    expect(PER_LOGIN_INVITATIONS).toEqual({ limit: 30, ttl: 60_000 });
  });

  it('counts a run of fifteen parts, which five a minute per address refused at the sixth, and every other administrator of the school with it', async () => {
    const guard = new InvitationThrottlerGuard();
    const school = '10.0.0.1';
    for (let part = 0; part < 15; part += 1) {
      await expect(guard.canActivate(contextFor({ ip: school, user: { authId: 'rektor' } }))).resolves.toBe(true);
    }
    for (const administrator of ['skolchef', 'expedition', 'schemalaggare']) {
      await expect(guard.canActivate(contextFor({ ip: school, user: { authId: administrator } }))).resolves.toBe(true);
    }
  });

  it('is a bucket of its own: a login that has spent its invitations is not refused the pages every person loads', async () => {
    const invitations = new InvitationThrottlerGuard();
    const pages = new PerLoginThrottlerGuard();
    const rektor = { ip: '10.0.0.1', user: { authId: 'rektor' } };
    for (let i = 0; i < PER_LOGIN_INVITATIONS.limit; i += 1) await invitations.canActivate(contextFor(rektor));
    await expect(pages.canActivate(contextFor(rektor))).resolves.toBe(true);
    // And the route is in the key, so that two guards of this kind in one store would not share it either.
    const keys = [...(invitations as unknown as { logins: { entries: Map<string, unknown> } }).logins.entries.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^login\u0000[0-9a-f]{64}$/);
  });

  it('gives the global guard a ceiling of the school\'s own for the route, far over what one login may send', () => {
    expect(PER_ADDRESS_INVITATIONS.limit).toBeGreaterThanOrEqual(PER_LOGIN_INVITATIONS.limit * 20);
    expect(PER_ADDRESS_INVITATIONS.ttl).toBe(60_000);
  });
});
