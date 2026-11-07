import request from 'supertest';
import { PER_ADDRESS, PER_LOGIN, RATE_LIMITED } from '../src/school-day/school-day-throttler.guard';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

/**
 * Skolans dag's two grid reads with the production rate limiter on. The web asks the API from each person's
 * browser, so a school's whole staff arrive from the one address of its NAT: the limit is per login (and per
 * route), with a high ceiling per address in the global guard's bucket. A limit per address would have given
 * sixty teachers opening the page together thirty errors.
 */
describe('Skolans dag under the rate limiter (e2e)', () => {
  let harness: TestHarness;
  const http = () => harness.app.getHttpServer();
  const login = (n: number) =>
    asUser({ role: 'TEACHER' as never, authId: `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}` });
  const grid = (as: string) => request(http()).get('/api/v1/school-day?from=2027-03-29').set('x-test-user', as);
  const free = (as: string) => request(http()).get('/api/v1/school-day/free?date=2027-03-29&from=10:00&to=11:00').set('x-test-user', as);

  beforeAll(async () => {
    harness = await createTestApp({ throttle: true });
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(() => {
    harness.tx['schoolDaySettings']!['findUnique']!.mockResolvedValue({ teacherView: 'ROOMS' });
    harness.tx['school']!['findUnique']!.mockResolvedValue({ timezone: 'Europe/Stockholm' });
    harness.tx['room']!['findMany']!.mockResolvedValue([{ id: 'r1', name: 'Sal 1', code: null }]);
    harness.tx.$queryRaw.mockResolvedValue([]);
  });

  it('answers sixty teachers from one address, more than a per-address limit of thirty would', async () => {
    let last: request.Response | undefined;
    for (let n = 1; n <= 60; n++) last = await grid(login(n)).expect(200);
    // The global guard counts each route per address, against a ceiling of its own.
    expect(last!.headers['x-ratelimit-limit']).toBe(String(PER_ADDRESS.limit));
  });

  it('stops one login past its own limit with Retry-After and a code, and only that login', async () => {
    const anna = login(1000);
    for (let i = 0; i < PER_LOGIN.limit; i++) await grid(anna).expect(200);
    const refused = await grid(anna).expect(429);
    expect(refused.body).toMatchObject({ status: 429, code: RATE_LIMITED });
    expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    await grid(login(1001)).expect(200);
    // The search has a quota of its own, so the grid being used up does not take it.
    await free(anna).expect(200);
  });
});
