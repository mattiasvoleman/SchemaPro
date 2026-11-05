import request from 'supertest';
import { HUVUDMAN_NO_SCHOOL } from '../src/auth/huvudman.guard';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

/**
 * GET /api/v1/openapi.json, through the whole app: the document of the
 * gateway's /api/v1 is read by the school's administrators and by nobody else.
 * Each case is a request the guards answer, over the real routing table; the
 * document's content (which needs the DTO classes compiled with the swagger
 * plugin) is held by test/openapi-document.openapi-spec.ts.
 */
describe('OpenAPI endpoint (e2e)', () => {
  let harness: TestHarness;
  const http = () => harness.app.getHttpServer();
  const URL = '/api/v1/openapi.json';
  const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';

  beforeAll(async () => {
    harness = await createTestApp();
  });

  afterAll(async () => {
    await harness.close();
  });

  describe.each(['FULL', 'REKTOR', 'SCHEMALAGGARE', 'EXPEDITION', 'LASARE'])('an administrator with the profile %s', (adminProfile) => {
    it('reads the document as JSON', async () => {
      const response = await request(http()).get(URL).set('x-test-user', asUser({ adminProfile } as never)).expect(200);

      expect(response.headers['content-type']).toMatch(/^application\/json/);
      expect(response.body).toMatchObject({ openapi: '3.0.0', info: { title: 'Rastra API' } });
      expect(Object.keys(response.body.paths)).toContain('/api/v1/openapi.json');
    });
  });

  it('serves the same bytes on every ask: built once, cached', async () => {
    const first = await request(http()).get(URL).set('x-test-user', asUser({})).expect(200);
    const second = await request(http()).get(URL).set('x-test-user', asUser({ adminProfile: 'LASARE' } as never)).expect(200);

    expect(second.text).toBe(first.text);
    expect(first.text.endsWith('}\n')).toBe(true);
  });

  it('serves the huvudman’s reader at a school, who reads every school the huvudman owns as a läsare', async () => {
    const reader = asUser({
      adminProfile: 'LASARE',
      huvudman: { id: SCHOOL_ID, name: 'Vimmerby kommun', memberId: SCHOOL_ID, role: 'PLANERARE', firstName: 'Pia', lastName: 'P' },
    } as never);

    await request(http()).get(URL).set('x-test-user', reader).expect(200);
  });

  describe.each(['TEACHER', 'STUDENT', 'GUARDIAN', 'SYSTEM_ADMIN'])('a %s', (role) => {
    it('is refused with a 403 and gets no document', async () => {
      const response = await request(http()).get(URL).set('x-test-user', asUser({ role } as never)).expect(403);

      expect(response.body).not.toHaveProperty('openapi');
      expect(response.body).toMatchObject({ status: 403 });
    });
  });

  it('refuses the huvudman’s member with no school named, with that guard’s own refusal', async () => {
    const response = await request(http())
      .get(URL)
      .set('x-test-user', JSON.stringify({ authId: '11111111-1111-4111-8111-111111111111', role: 'HUVUDMAN' }))
      .expect(403);

    expect(response.body).toMatchObject({ code: HUVUDMAN_NO_SCHOOL });
  });

  it('refuses a caller with no login, whatever else the request carries: an integration key is not a login', async () => {
    await request(http()).get(URL).expect(401);
    await request(http()).get(URL).set('x-api-key', 'sp_0123456789abcdef0123456789abcdef0123456789abcdef').expect(401);
    await request(http()).get(URL).set('authorization', 'Bearer not-a-token').expect(401);
  });

  it('is a read: no verb but GET reaches it', async () => {
    for (const verb of ['post', 'put', 'patch', 'delete'] as const) {
      const response = await request(http())[verb](URL).set('x-test-user', asUser({})).send({});
      expect(response.status).toBe(404);
    }
  });
});
