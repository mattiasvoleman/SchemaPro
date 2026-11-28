import request from 'supertest';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

const ADMIN_PROFILES = ['FULL', 'REKTOR', 'SCHEMALAGGARE', 'EXPEDITION', 'LASARE'];
const WRITERS = ['FULL', 'REKTOR', 'SCHEMALAGGARE'];
const WEIGHTS = { preferredFree: 12, preferredBusy: 4, disruption: 9, spread: 6, teacherGap: 1 };

/**
 * Optimeringsprofilen over HTTP (P5): who reads it, who saves it and what a save must be. The mocks stand in for the database, so these
 * hold the guards, the validation and the shape of the answer; which rows a role reaches is the RLS suite's section 601, and the save
 * against a real database is scripts/test/probe-optimeringsprofil.ts.
 */
describe('/api/v1/optimization/profile (e2e)', () => {
  let harness: TestHarness;
  const http = () => request(harness.app.getHttpServer());
  const profile = (adminProfile: string) => asUser({ adminProfile: adminProfile as never, hrRead: false });

  beforeAll(async () => {
    harness = await createTestApp();
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    harness.tx['optimizationProfile']!['findUnique']!.mockResolvedValue(null);
    harness.tx['optimizationProfile']!['upsert']!.mockImplementation(async ({ create }: { create: Record<string, number> }) => ({
      ...create,
      updatedAt: new Date('2026-11-26T08:00:00Z'),
    }));
  });

  it.each(['TEACHER', 'STUDENT', 'GUARDIAN'])('refuses %s both ways: the profile is the administrators\'', async (role) => {
    await http().get('/api/v1/optimization/profile').set('x-test-user', asUser({ role: role as never })).expect(403);
    await http().put('/api/v1/optimization/profile').set('x-test-user', asUser({ role: role as never })).send(WEIGHTS).expect(403);
    expect(harness.tx['optimizationProfile']!['findUnique']).not.toHaveBeenCalled();
    expect(harness.tx['optimizationProfile']!['upsert']).not.toHaveBeenCalled();
  });

  it('refuses nobody-in-particular without a token', async () => {
    await http().get('/api/v1/optimization/profile').expect(401);
    await http().put('/api/v1/optimization/profile').send(WEIGHTS).expect(401);
  });

  it('answers the defaults to every administrator profile, the läsare included, for a school that has saved nothing', async () => {
    for (const adminProfile of ADMIN_PROFILES) {
      const response = await http().get('/api/v1/optimization/profile').set('x-test-user', profile(adminProfile)).expect(200);
      expect(response.body).toEqual({ weights: { preferredFree: 10, preferredBusy: 5, disruption: 8, spread: 3, teacherGap: 2 }, stored: false, updatedAt: null });
    }
  });

  it('saves for the profiles that write Schemaläggning, and answers with what is saved', async () => {
    for (const adminProfile of WRITERS) {
      const response = await http().put('/api/v1/optimization/profile').set('x-test-user', profile(adminProfile)).send(WEIGHTS).expect(200);
      expect(response.body).toEqual({ weights: WEIGHTS, stored: true, updatedAt: '2026-11-26T08:00:00.000Z' });
    }
    expect(harness.tx['optimizationProfile']!['upsert']).toHaveBeenCalledTimes(WRITERS.length);
  });

  it('refuses a save from the expedition and the läsare by the area, and writes nothing', async () => {
    for (const adminProfile of ['EXPEDITION', 'LASARE']) {
      const response = await http().put('/api/v1/optimization/profile').set('x-test-user', profile(adminProfile)).send(WEIGHTS).expect(403);
      expect(response.body.code).toBeDefined();
    }
    expect(harness.tx['optimizationProfile']!['upsert']).not.toHaveBeenCalled();
  });

  it.each([
    ['a weight over 1000', { ...WEIGHTS, spread: 1001 }],
    ['a negative weight', { ...WEIGHTS, spread: -1 }],
    ['a fraction', { ...WEIGHTS, spread: 2.5 }],
    ['a string', { ...WEIGHTS, spread: '3' }],
    ['a missing weight', { preferredFree: 1, preferredBusy: 1, disruption: 1, spread: 1 }],
    ['nothing', {}],
  ])('refuses %s with a 400 and writes nothing', async (_what, body) => {
    await http().put('/api/v1/optimization/profile').set('x-test-user', profile('FULL')).send(body).expect(400);
    expect(harness.tx['optimizationProfile']!['upsert']).not.toHaveBeenCalled();
  });

  it('has no delete and no other verb: the row goes with the school', async () => {
    for (const verb of ['post', 'patch', 'delete'] as const) {
      await http()[verb]('/api/v1/optimization/profile').set('x-test-user', profile('FULL')).send(WEIGHTS).expect(404);
    }
  });
});
