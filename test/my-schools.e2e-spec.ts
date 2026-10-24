import request from 'supertest';
import { PER_ADDRESS, PER_LOGIN } from '../src/users/per-login-throttler.guard';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

/**
 * GET /api/v1/me/schools (Flera skolor per inloggning) with the production
 * rate limiter on: the web server asks it for everybody with several
 * schools, from one address, so the route has a bucket of its own per
 * address (PER_ADDRESS) in place of the global one, and the per-login one.
 */
describe('the login\'s schools under the rate limiter (e2e)', () => {
  let harness: TestHarness;
  const http = () => harness.app.getHttpServer();
  const login = (n: number) =>
    asUser({ role: 'TEACHER' as never, authId: `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}` });

  beforeAll(async () => {
    harness = await createTestApp({ throttle: true });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('answers more people from one address than the global limit lets through, in a bucket of its own', async () => {
    let last: request.Response | undefined;
    for (let n = 1; n <= 130; n++) {
      last = await request(http()).get('/api/v1/me/schools').set('x-test-user', login(n)).expect(200);
    }
    // The global guard counts the route per address, against its own limit.
    expect(last!.headers['x-ratelimit-limit']).toBe(String(PER_ADDRESS.limit));
    expect(Number(last!.headers['x-ratelimit-remaining'])).toBe(PER_ADDRESS.limit - 130);
  });

  it('stops one login past its own limit, and only that login', async () => {
    const anna = login(1000);
    for (let i = 0; i < PER_LOGIN.limit; i++) {
      await request(http()).get('/api/v1/me/schools').set('x-test-user', anna).expect(200);
    }
    await request(http()).get('/api/v1/me/schools').set('x-test-user', anna).expect(429);
    await request(http()).get('/api/v1/me/schools').set('x-test-user', login(1001)).expect(200);
  });
});
