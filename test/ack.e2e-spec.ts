import { Prisma } from '@prisma/client';
import request from 'supertest';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

const REQ = '44444444-4444-4444-8444-444444444444';
const PUPIL = '55555555-5555-4555-8555-555555555555';
const BODY = { title: 'Utflykt', body: 'Vi åker kl. 8.', rule: 'ANY', studentIds: [PUPIL] };

/**
 * Kvittens' routes: who may reach them and what a request must be. The mocks
 * stand in for the database, so these hold the role and area gates and the
 * validation and say nothing of row security; RLS sections 370-374 and the
 * adapter probe (probe-kvittens.ts) say who reads which row.
 */
describe('/api/v1/acknowledgements (e2e)', () => {
  let harness: TestHarness;
  const http = () => request(harness.app.getHttpServer());

  beforeAll(async () => {
    harness = await createTestApp();
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    harness.tx['ackSetting']!['findUnique']!.mockResolvedValue({ enabled: true, remindAfterDays: 2 });
    harness.tx['ackRequest']!['findMany']!.mockResolvedValue([]);
    harness.tx.$queryRaw.mockResolvedValue([{ enabled: true, ids: [PUPIL], days: 2 }]);
  });

  describe('the staff', () => {
    it.each(['STUDENT', 'GUARDIAN'])('refuses %s every staff route', async (role) => {
      const as = asUser({ role: role as never });
      await http().get('/api/v1/acknowledgements').set('x-test-user', as).expect(403);
      await http().get('/api/v1/acknowledgements/settings').set('x-test-user', as).expect(403);
      await http().get('/api/v1/acknowledgements/pupils').set('x-test-user', as).expect(403);
      await http().get(`/api/v1/acknowledgements/${REQ}`).set('x-test-user', as).expect(403);
      await http().put('/api/v1/acknowledgements/settings').set('x-test-user', as).send({ enabled: true }).expect(403);
      await http().post('/api/v1/acknowledgements').set('x-test-user', as).send(BODY).expect(403);
      expect(harness.tx['ackRequest']!['createMany']).not.toHaveBeenCalled();
    });

    it('refuses nobody-in-particular without a token', async () => {
      await http().get('/api/v1/acknowledgements').expect(401);
      await http().get('/api/v1/acknowledgements/mine').expect(401);
      await http().post(`/api/v1/acknowledgements/${REQ}/confirm`).expect(401);
    });

    it('lets a teacher read and ask, and not turn kvittens on', async () => {
      const teacher = asUser({ role: 'TEACHER' as never });
      const settings = await http().get('/api/v1/acknowledgements/settings').set('x-test-user', teacher).expect(200);
      expect(settings.body).toEqual({ enabled: true, remindAfterDays: 2 });
      await http().get('/api/v1/acknowledgements').set('x-test-user', teacher).expect(200);
      await http().put('/api/v1/acknowledgements/settings').set('x-test-user', teacher).send({ enabled: true }).expect(403);
      expect(harness.tx['ackSetting']!['upsert']).not.toHaveBeenCalled();
    });

    it('lets every profile read, the Drift profiles write, and the läsare not', async () => {
      for (const adminProfile of ['FULL', 'REKTOR', 'SCHEMALAGGARE', 'EXPEDITION', 'LASARE']) {
        const as = asUser({ adminProfile: adminProfile as never });
        await http().get('/api/v1/acknowledgements').set('x-test-user', as).expect(200);
        await http().get('/api/v1/acknowledgements/settings').set('x-test-user', as).expect(200);
      }
      for (const adminProfile of ['FULL', 'REKTOR', 'SCHEMALAGGARE', 'EXPEDITION']) {
        await http().put('/api/v1/acknowledgements/settings').set('x-test-user', asUser({ adminProfile: adminProfile as never })).send({ enabled: true }).expect(200);
      }
      const lasare = asUser({ adminProfile: 'LASARE' as never });
      const refused = await http().put('/api/v1/acknowledgements/settings').set('x-test-user', lasare).send({ enabled: true }).expect(403);
      expect(refused.body.code).toBe('AREA_NOT_YOURS');
      expect(refused.body.detail).toContain('Drift');
      await http().post('/api/v1/acknowledgements').set('x-test-user', lasare).send(BODY).expect(403);
    });

    it('answers 404 for a request the caller may not read', async () => {
      harness.tx['ackRequest']!['findUnique']!.mockResolvedValue(null);
      const res = await http().get(`/api/v1/acknowledgements/${REQ}`).set('x-test-user', asUser({ role: 'TEACHER' as never })).expect(404);
      expect(res.body.code).toBe('ACK_NOT_FOUND');
    });

    it('refuses an id that is not a uuid, and takes "mine" for the guardian\'s list and not for an id', async () => {
      await http().get('/api/v1/acknowledgements/not-an-id').set('x-test-user', asUser({})).expect(400);
      await http().get('/api/v1/acknowledgements/mine').set('x-test-user', asUser({})).expect(403);
    });
  });

  describe('validation', () => {
    const admin = asUser({});
    it.each([
      ['no title', { ...BODY, title: '' }],
      ['a blank title', { ...BODY, title: '   ' }],
      ['a title of 121 characters', { ...BODY, title: 't'.repeat(121) }],
      ['no text', { ...BODY, body: '' }],
      ['a text of 2001 characters', { ...BODY, body: 'b'.repeat(2001) }],
      ['a rule it does not know', { ...BODY, rule: 'MOST' }],
      ['no rule', { title: 'T', body: 'B', studentIds: [PUPIL] }],
      ['no pupils', { ...BODY, studentIds: [] }],
      ['a pupil that is not an id', { ...BODY, studentIds: ['nobody'] }],
      ['2001 pupils', { ...BODY, studentIds: Array.from({ length: 2001 }, () => PUPIL) }],
      ['a field it does not know', { ...BODY, remindAt: '2026-01-01' }],
    ])('refuses %s with a 400 before the database', async (_label, body) => {
      await http().post('/api/v1/acknowledgements').set('x-test-user', admin).send(body).expect(400);
      expect(harness.tx['ackRequest']!['createMany']).not.toHaveBeenCalled();
    });

    it('refuses a reminder of 0 or 31 days, and a switch that is not a boolean, and takes null for none', async () => {
      await http().put('/api/v1/acknowledgements/settings').set('x-test-user', admin).send({ remindAfterDays: 0 }).expect(400);
      await http().put('/api/v1/acknowledgements/settings').set('x-test-user', admin).send({ remindAfterDays: 31 }).expect(400);
      await http().put('/api/v1/acknowledgements/settings').set('x-test-user', admin).send({ enabled: 'yes' }).expect(400);
      await http().put('/api/v1/acknowledgements/settings').set('x-test-user', admin).send({ remindAfterDays: null }).expect(200);
      expect(harness.tx['ackSetting']!['upsert']).toHaveBeenCalledWith(expect.objectContaining({ update: { remindAfterDays: null } }));
    });

    it('trims the title and the text, and writes the request', async () => {
      harness.tx['user']!['findMany']!.mockResolvedValue([{ id: PUPIL }]);
      harness.tx['guardianStudent']!['findMany']!.mockResolvedValue([{ studentId: PUPIL, guardianId: '66666666-6666-4666-8666-666666666666' }]);
      const res = await http().post('/api/v1/acknowledgements').set('x-test-user', admin).send({ ...BODY, title: '  Utflykt  ', body: ' Vi åker kl. 8. ' }).expect(201);
      expect(res.body).toMatchObject({ pupils: 1, guardians: 1, withoutGuardian: [] });
      expect(harness.tx['ackRequest']!['createMany']!.mock.calls[0]![0].data[0]).toMatchObject({ title: 'Utflykt', body: 'Vi åker kl. 8.', rule: 'ANY' });
    });
  });

  describe('the guardian', () => {
    const guardian = asUser({ role: 'GUARDIAN' as never });

    it('reads only the guardian’s own list and confirms; every other role is refused both', async () => {
      harness.tx['ackRequest']!['findMany']!.mockResolvedValue([]);
      await http().get('/api/v1/acknowledgements/mine').set('x-test-user', guardian).expect(200);
      for (const role of ['TEACHER', 'STUDENT', 'SCHOOL_ADMIN']) {
        await http().post(`/api/v1/acknowledgements/${REQ}/confirm`).set('x-test-user', asUser({ role: role as never })).expect(403);
      }
    });

    it('confirms, and answers the time', async () => {
      harness.tx.$queryRaw.mockResolvedValue([{ at: new Date('2026-11-03T10:00:00Z') }]);
      const res = await http().post(`/api/v1/acknowledgements/${REQ}/confirm`).set('x-test-user', guardian).expect(200);
      expect(res.body).toEqual({ ackedAt: '2026-11-03T10:00:00.000Z' });
    });

    it.each([
      ['KV404', 404, 'ACK_NOT_FOUND'],
      ['KV410', 409, 'ACK_CUSTODY_ENDED'],
      ['KV403', 403, 'ACK_NOT_A_GUARDIAN'],
    ])('answers the database’s %s as %i with its code', async (state, status, code) => {
      harness.tx.$queryRaw.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Raw query failed', { code: 'P2010', clientVersion: 'test', meta: { driverAdapterError: { cause: { originalCode: state } } } }),
      );
      const res = await http().post(`/api/v1/acknowledgements/${REQ}/confirm`).set('x-test-user', guardian).expect(status);
      expect(res.body.code).toBe(code);
    });
  });
});
