import type { ConfigService } from '@nestjs/config';
import type { ExecutionContext } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { StaffViewerThrottlerGuard } from './staff-viewer-throttler.guard';
import { newCode } from './public-token';
import { MISSES, PER_PERSON, PER_STAFF_LINK, ViewerMissLimiter } from './viewer-miss-limiter';

const limiter = () => new ViewerMissLimiter({ get: () => ({ proxyKey: 'k'.repeat(32) }) } as unknown as ConfigService);

function call(guard: StaffViewerThrottlerGuard, user: { userId?: string; authId: string } | undefined, token: string) {
  const response = { headers: {} as Record<string, string>, setHeader(name: string, value: string) { this.headers[name] = value; } };
  const context = {
    switchToHttp: () => ({ getRequest: () => ({ user, params: { token } }), getResponse: () => response }),
  } as unknown as ExecutionContext;
  return {
    response,
    outcome: guard.canActivate(context).then(
      () => 200,
      (error: unknown) => (error instanceof ThrottlerException ? 429 : Promise.reject(error)),
    ),
  };
}

describe('StaffViewerThrottlerGuard', () => {
  it('marks every answer, a refusal included, private, no-store, noindex and no-referrer', async () => {
    const guard = new StaffViewerThrottlerGuard(limiter());
    const first = call(guard, { userId: 'a', authId: 'a' }, newCode());
    expect(await first.outcome).toBe(200);
    expect(first.response.headers).toMatchObject({ 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
  });

  it('refuses a person after their limit with a time to come back, and not another person', async () => {
    const guard = new StaffViewerThrottlerGuard(limiter());
    const tally: Record<number, number> = {};
    for (let i = 0; i < PER_PERSON.limit + 5; i++) {
      const status = await call(guard, { userId: 'a', authId: 'a' }, newCode()).outcome;
      tally[status] = (tally[status] ?? 0) + 1;
    }
    expect(tally).toEqual({ 200: PER_PERSON.limit, 429: 5 });
    const refused = call(guard, { userId: 'a', authId: 'a' }, newCode());
    expect(await refused.outcome).toBe(429);
    expect(Number(refused.response.headers['Retry-After'])).toBeGreaterThan(0);
    expect(refused.response.headers['Cache-Control']).toBe('private, no-store');
    expect(await call(guard, { userId: 'b', authId: 'b' }, newCode()).outcome).toBe(200);
  });

  it('refuses one link after its limit whoever reads it', async () => {
    const guard = new StaffViewerThrottlerGuard(limiter());
    const code = newCode();
    let refused = 0;
    for (let i = 0; i < PER_STAFF_LINK.limit + 3; i++) {
      if ((await call(guard, { userId: `u${i}`, authId: `u${i}` }, code).outcome) === 429) refused++;
    }
    expect(refused).toBe(3);
  });

  it('refuses a person who has spent their misses, before anything is read', async () => {
    const shared = limiter();
    const guard = new StaffViewerThrottlerGuard(shared);
    for (let i = 0; i <= MISSES.limit; i++) await shared.miss('user:a');
    const refused = call(guard, { userId: 'a', authId: 'a' }, newCode());
    expect(await refused.outcome).toBe(429);
    expect(Number(refused.response.headers['Retry-After'])).toBe(MISSES.block / 1000);
  });

  it('leaves a request with no person to JwtAuthGuard, which answers it first', async () => {
    const guard = new StaffViewerThrottlerGuard(limiter());
    expect(await call(guard, undefined, newCode()).outcome).toBe(200);
  });

  it('charges no link for an address that is no link', async () => {
    const shared = limiter();
    const guard = new StaffViewerThrottlerGuard(shared);
    for (let i = 0; i < 50; i++) await call(guard, { userId: 'a', authId: 'a' }, `x${i}`).outcome;
    // 50 person hits, and no link key held for the junk.
    expect(shared.keysHeld).toBe(1);
  });
});
