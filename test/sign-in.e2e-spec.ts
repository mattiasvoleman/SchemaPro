import request from 'supertest';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';
import { LOOKUPS_PER_MINUTE } from '../src/sign-in/sign-in-methods.controller';

/**
 * "Logga in med skolkonto" over HTTP (migration 20261020090000): the admin's
 * row through the real routing table, validation pipe and RBAC guard, and
 * /login's public lookup. Who may sign in is the access-token hook's to
 * decide, in Postgres; what the database enforces under these routes is
 * scripts/test/rls-policies.sql §70–74.
 */

const SCHOOL = '33333333-3333-4333-8333-333333333333';
const TENANT = '2f6a1c3e-8b4d-4f5a-9c7e-1d2b3a4c5e6f';
const NOW = new Date('2026-10-20T08:00:00Z');

/** One school's table, behind the harness's mock. */
function plantTable(harness: TestHarness) {
  let row: Record<string, unknown> | null = null;
  const model = harness.tx['schoolSignInMethod']!;
  model['findUnique']!.mockImplementation(async () => row);
  model['create']!.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    row = { id: 'row-1', createdAt: NOW, updatedAt: NOW, ...data };
    return row;
  });
  model['update']!.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    row = { ...row, ...data, updatedAt: NOW };
    return row;
  });
  model['deleteMany']!.mockImplementation(async () => {
    const count = row ? 1 : 0;
    row = null;
    return { count };
  });
  return () => row;
}

describe('Logga in med skolkonto (e2e)', () => {
  let harness: TestHarness;
  const http = () => harness.app.getHttpServer();

  beforeEach(async () => {
    harness = await createTestApp();
  });
  afterEach(async () => {
    await harness.close();
  });

  describe('the admin card', () => {
    it('round-trips the school\'s row: none, Entra, Google, SSO-only from its own school account, removed', async () => {
      const stored = plantTable(harness);
      const admin = asUser({});
      const entraAdmin = asUser({ schoolAccount: { provider: 'azure', entraTenantId: TENANT } });

      const empty = await request(http()).get('/api/v1/sign-in-method').set('x-test-user', admin).expect(200);
      expect(empty.body).toEqual({ method: null, session: { schoolAccount: null } });

      const created = await request(http())
        .put('/api/v1/sign-in-method')
        .set('x-test-user', admin)
        .send({ provider: 'azure', domains: [' Skola.Example ', 'skola.example', 'elev.skola.example'], entraTenantId: TENANT.toUpperCase() })
        .expect(200);
      expect(created.body.method).toEqual({
        provider: 'azure',
        domains: ['skola.example', 'elev.skola.example'],
        entraTenantId: TENANT,
        googleHostedDomain: null,
        ssoOnlyForStaff: false,
        updatedAt: NOW.toISOString(),
      });
      expect(stored()).toMatchObject({ schoolId: SCHOOL });

      // Requiring the school account from a password session is refused, and nothing is written.
      const refused = await request(http())
        .put('/api/v1/sign-in-method')
        .set('x-test-user', admin)
        .send({ provider: 'azure', domains: ['skola.example'], entraTenantId: TENANT, ssoOnlyForStaff: true })
        .expect(409);
      expect(refused.body.code).toBe('SIGN_IN_SSO_ONLY_NEEDS_OWN_SCHOOL_ACCOUNT');
      expect(stored()).toMatchObject({ ssoOnlyForStaff: false });

      const ssoOnly = await request(http())
        .put('/api/v1/sign-in-method')
        .set('x-test-user', entraAdmin)
        .send({ provider: 'azure', domains: ['skola.example'], entraTenantId: TENANT, ssoOnlyForStaff: true })
        .expect(200);
      expect(ssoOnly.body).toMatchObject({
        method: { ssoOnlyForStaff: true },
        session: { schoolAccount: { provider: 'azure', entraTenantId: TENANT } },
      });

      const google = await request(http())
        .put('/api/v1/sign-in-method')
        .set('x-test-user', admin)
        .send({ provider: 'google', domains: ['skola.example'], googleHostedDomain: 'Skola.Example' })
        .expect(200);
      expect(google.body.method).toMatchObject({ provider: 'google', entraTenantId: null, googleHostedDomain: 'skola.example', ssoOnlyForStaff: false });

      await request(http()).delete('/api/v1/sign-in-method').set('x-test-user', admin).expect(200, { removed: true });
      await request(http()).delete('/api/v1/sign-in-method').set('x-test-user', admin).expect(200, { removed: false });
      expect(stored()).toBeNull();
    });

    it('refuses bodies the table would refuse, before the database', async () => {
      plantTable(harness);
      const admin = asUser({});
      for (const body of [
        { provider: 'github', domains: ['skola.example'] },
        { provider: 'azure', domains: [], entraTenantId: TENANT },
        { provider: 'azure', domains: ['localhost'], entraTenantId: TENANT },
        { provider: 'azure', domains: ['anna@skola.example'], entraTenantId: TENANT },
        { provider: 'azure', domains: Array.from({ length: 21 }, (_, i) => `d${i}.skola.example`), entraTenantId: TENANT },
        { provider: 'azure', domains: ['skola.example'], entraTenantId: 'not-a-uuid' },
        { provider: 'google', domains: ['skola.example'], googleHostedDomain: 'skola' },
        { provider: 'azure', domains: ['skola.example'], entraTenantId: TENANT, ssoOnlyForStaff: 'yes' },
        { provider: 'azure', domains: ['skola.example'], entraTenantId: TENANT, schoolId: SCHOOL },
      ]) {
        await request(http()).put('/api/v1/sign-in-method').set('x-test-user', admin).send(body).expect(400);
      }
      const noTenant = await request(http())
        .put('/api/v1/sign-in-method')
        .set('x-test-user', admin)
        .send({ provider: 'azure', domains: ['skola.example'] })
        .expect(400);
      expect(noTenant.body.code).toBe('SIGN_IN_TENANT_REQUIRED');
      expect(harness.tx['schoolSignInMethod']!['create']).not.toHaveBeenCalled();
    });

    it('is the admin\'s alone', async () => {
      plantTable(harness);
      for (const role of ['TEACHER', 'STUDENT', 'GUARDIAN']) {
        const user = asUser({ role: role as never });
        await request(http()).get('/api/v1/sign-in-method').set('x-test-user', user).expect(403);
        await request(http())
          .put('/api/v1/sign-in-method')
          .set('x-test-user', user)
          .send({ provider: 'azure', domains: ['skola.example'], entraTenantId: TENANT })
          .expect(403);
        await request(http()).delete('/api/v1/sign-in-method').set('x-test-user', user).expect(403);
      }
      await request(http()).get('/api/v1/sign-in-method').expect(401);
      expect(harness.tx['schoolSignInMethod']!['findUnique']).not.toHaveBeenCalled();
    });
  });

  describe('/login\'s lookup', () => {
    it('answers the provider of a domain without a principal, never cached', async () => {
      harness.tx.$queryRaw.mockResolvedValue([{ provider: 'azure' }]);
      const answer = await request(http()).get('/public/v1/sign-in-methods/Skola.Example').expect(200);
      expect(answer.body).toEqual({ provider: 'azure' });
      expect(answer.headers['cache-control']).toBe('no-store');
      expect(answer.headers['set-cookie']).toBeUndefined();
      expect(harness.tx.$queryRaw.mock.calls[0]![0].values).toEqual(['skola.example']);
    });

    it('answers null alike for a domain nobody names and for one that is no host name', async () => {
      harness.tx.$queryRaw.mockResolvedValue([{ provider: null }]);
      const unknown = await request(http()).get('/public/v1/sign-in-methods/okand.example').expect(200);
      const malformed = await request(http()).get(`/public/v1/sign-in-methods/${encodeURIComponent('anna@skola.example')}`).expect(200);
      expect(unknown.body).toEqual({ provider: null });
      expect(malformed.body).toEqual(unknown.body);
      expect(harness.tx.$queryRaw).toHaveBeenCalledTimes(1);
    });
  });
});

describe('/login\'s lookup under the rate limit (e2e)', () => {
  let harness: TestHarness;

  beforeAll(async () => {
    process.env['THROTTLE_LIMIT'] = '1000';
    harness = await createTestApp({ throttle: true });
  });
  afterAll(async () => {
    await harness.close();
  });

  it('stops one address after the route\'s own limit, well under the global one', async () => {
    harness.tx.$queryRaw.mockResolvedValue([{ provider: null }]);
    const send = () => request(harness.app.getHttpServer()).get('/public/v1/sign-in-methods/okand.example');
    for (let i = 0; i < LOOKUPS_PER_MINUTE; i++) {
      await send().expect(200);
    }
    await send().expect(429);
  });
});
