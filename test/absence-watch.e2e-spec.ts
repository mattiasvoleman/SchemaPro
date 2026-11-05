import request from 'supertest';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

const LIMIT_ID = '44444444-4444-4444-8444-444444444444';
const SHARE = { recipientGroup: 'MENTOR', kind: 'SHARE', basis: 'INVALID', percent: 10, windowDays: 14 };

const limitRow = {
  id: LIMIT_ID,
  schoolId: '33333333-3333-4333-8333-333333333333',
  recipientGroup: 'MENTOR',
  kind: 'SHARE',
  basis: 'INVALID',
  percent: 10,
  windowDays: 14,
  consecutiveDays: null,
};

/**
 * Frånvarobevakning's routes: who may reach them and what a request must be.
 * The mocks stand in for the database, so these hold the role and area gates
 * and the validation and say nothing of row security; the RLS sections 305-308
 * and the adapter probe say who reads which finding.
 */
describe('/api/v1/absence-watch (e2e)', () => {
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
    harness.tx['absenceWatchSetting']!['findFirst']!.mockResolvedValue(null);
    harness.tx['absenceWatchLimit']!['findMany']!.mockResolvedValue([limitRow]);
    harness.tx['absenceWatchFinding']!['findMany']!.mockResolvedValue([]);
  });

  describe('the switch and the limits are the administrators', () => {
    it.each(['TEACHER', 'STUDENT', 'GUARDIAN'])('refuses %s every route but the findings', async (role) => {
      const as = asUser({ role: role as never });
      await http().get('/api/v1/absence-watch').set('x-test-user', as).expect(403);
      await http().put('/api/v1/absence-watch/settings').set('x-test-user', as).send({ enabled: true }).expect(403);
      await http().post('/api/v1/absence-watch/limits').set('x-test-user', as).send(SHARE).expect(403);
      await http().put(`/api/v1/absence-watch/limits/${LIMIT_ID}`).set('x-test-user', as).send({ percent: 20, windowDays: 28 }).expect(403);
      await http().delete(`/api/v1/absence-watch/limits/${LIMIT_ID}`).set('x-test-user', as).expect(403);
      expect(harness.tx['absenceWatchSetting']!['upsert']).not.toHaveBeenCalled();
      expect(harness.tx['absenceWatchLimit']!['create']).not.toHaveBeenCalled();
    });

    it('refuses nobody-in-particular without a token', async () => {
      await http().get('/api/v1/absence-watch').expect(401);
      await http().get('/api/v1/absence-watch/findings').expect(401);
    });

    it('lets every profile read the switch and the limits, and the Drift profiles write them; the läsare does not', async () => {
      for (const adminProfile of ['FULL', 'REKTOR', 'SCHEMALAGGARE', 'EXPEDITION', 'LASARE']) {
        const as = asUser({ adminProfile: adminProfile as never });
        const read = await http().get('/api/v1/absence-watch').set('x-test-user', as).expect(200);
        expect(read.body).toMatchObject({ settings: { enabled: false }, limits: [{ id: LIMIT_ID }] });
      }
      for (const adminProfile of ['FULL', 'REKTOR', 'SCHEMALAGGARE', 'EXPEDITION']) {
        await http().put('/api/v1/absence-watch/settings').set('x-test-user', asUser({ adminProfile: adminProfile as never })).send({ enabled: true }).expect(200);
      }
      const lasare = asUser({ adminProfile: 'LASARE' as never });
      const refused = await http().put('/api/v1/absence-watch/settings').set('x-test-user', lasare).send({ enabled: true }).expect(403);
      expect(refused.body.code).toBe('AREA_NOT_YOURS');
      expect(refused.body.detail).toContain('Drift');
      await http().post('/api/v1/absence-watch/limits').set('x-test-user', lasare).send(SHARE).expect(403);
      await http().delete(`/api/v1/absence-watch/limits/${LIMIT_ID}`).set('x-test-user', lasare).expect(403);
    });
  });

  describe('validation', () => {
    const admin = asUser({});
    it.each([
      ['a percent of 0', { ...SHARE, percent: 0 }],
      ['a percent of 101', { ...SHARE, percent: 101 }],
      ['a window of 6 days', { ...SHARE, windowDays: 6 }],
      ['a window of 61 days', { ...SHARE, windowDays: 61 }],
      ['a share with no percent', { recipientGroup: 'MENTOR', kind: 'SHARE', basis: 'ALL', windowDays: 14 }],
      ['a share with days in a row', { ...SHARE, consecutiveDays: 3 }],
      ['a run of 1 day', { recipientGroup: 'REKTOR', kind: 'CONSECUTIVE', basis: 'ALL', consecutiveDays: 1 }],
      ['a run of 31 days', { recipientGroup: 'REKTOR', kind: 'CONSECUTIVE', basis: 'ALL', consecutiveDays: 31 }],
      ['a run with no days', { recipientGroup: 'REKTOR', kind: 'CONSECUTIVE', basis: 'ALL' }],
      ['a run with a percent', { recipientGroup: 'REKTOR', kind: 'CONSECUTIVE', basis: 'ALL', consecutiveDays: 3, percent: 10 }],
      ['a group it does not know', { ...SHARE, recipientGroup: 'STUDENT' }],
      ['a basis it does not know', { ...SHARE, basis: 'SICK' }],
      ['a kind it does not know', { ...SHARE, kind: 'WEEKLY' }],
    ])('refuses %s with a 400 before the database', async (_label, body) => {
      await http().post('/api/v1/absence-watch/limits').set('x-test-user', admin).send(body).expect(400);
      expect(harness.tx['absenceWatchLimit']!['create']).not.toHaveBeenCalled();
    });

    it('takes null for the figures its kind does not use, and refuses null for the ones it does', async () => {
      harness.tx['absenceWatchLimit']!['create']!.mockResolvedValue(limitRow);
      await http().post('/api/v1/absence-watch/limits').set('x-test-user', admin).send({ ...SHARE, consecutiveDays: null }).expect(201);
      await http().post('/api/v1/absence-watch/limits').set('x-test-user', admin).send({ ...SHARE, percent: null }).expect(400);
      await http()
        .post('/api/v1/absence-watch/limits')
        .set('x-test-user', admin)
        .send({ recipientGroup: 'REKTOR', kind: 'CONSECUTIVE', basis: 'ALL', consecutiveDays: 5, percent: null, windowDays: null })
        .expect(201);
      expect(harness.tx['absenceWatchLimit']!['create']).toHaveBeenCalledTimes(2);
    });

    it('refuses a cadence it does not know, and a switch that is not a boolean', async () => {
      await http().put('/api/v1/absence-watch/settings').set('x-test-user', admin).send({ mentorCadence: 'DAILY' }).expect(400);
      await http().put('/api/v1/absence-watch/settings').set('x-test-user', admin).send({ enabled: 'yes' }).expect(400);
      await http().put('/api/v1/absence-watch/settings').set('x-test-user', admin).send({ nonsense: 1 }).expect(400);
    });

    it('refuses an id that is not a uuid', async () => {
      await http().put('/api/v1/absence-watch/limits/not-an-id').set('x-test-user', admin).send({ percent: 20, windowDays: 28 }).expect(400);
      await http().delete('/api/v1/absence-watch/limits/not-an-id').set('x-test-user', admin).expect(400);
    });

    it('creates a limit of each kind', async () => {
      harness.tx['absenceWatchLimit']!['create']!.mockResolvedValue(limitRow);
      await http().post('/api/v1/absence-watch/limits').set('x-test-user', admin).send(SHARE).expect(201);
      harness.tx['absenceWatchLimit']!['create']!.mockResolvedValue({ ...limitRow, kind: 'CONSECUTIVE', percent: null, windowDays: null, consecutiveDays: 5 });
      const run = await http()
        .post('/api/v1/absence-watch/limits')
        .set('x-test-user', admin)
        .send({ recipientGroup: 'REKTOR', kind: 'CONSECUTIVE', basis: 'ALL', consecutiveDays: 5 })
        .expect(201);
      expect(run.body.consecutiveDays).toBe(5);
    });

    it('removes a limit with a 204, and answers 404 for one that belongs to another school', async () => {
      harness.tx['absenceWatchLimit']!['deleteMany']!.mockResolvedValue({ count: 1 });
      await http().delete(`/api/v1/absence-watch/limits/${LIMIT_ID}`).set('x-test-user', admin).expect(204);
      harness.tx['absenceWatchLimit']!['deleteMany']!.mockResolvedValue({ count: 0 });
      await http().delete(`/api/v1/absence-watch/limits/${LIMIT_ID}`).set('x-test-user', admin).expect(404);
    });
  });

  describe('the findings', () => {
    it.each(['SCHOOL_ADMIN', 'TEACHER', 'GUARDIAN'])('are read by %s, and the read is written to the read log', async (role) => {
      harness.tx['absenceWatchFinding']!['findMany']!.mockResolvedValue([
        {
          id: 'f1', studentId: 'p1', recipientGroup: 'MENTOR', kind: 'SHARE', basis: 'INVALID', percent: 10, windowDays: 14, consecutiveDays: null,
          firstCrossedOn: new Date('2026-09-24T00:00:00Z'), lastSeenOn: new Date('2026-09-25T00:00:00Z'), clearedOn: null,
          absentMinutes: 60, recordedMinutes: 600, streakDays: null,
          student: { firstName: 'Elev', lastName: 'Ett', studentGroup: { name: '7A' } },
        },
      ]);
      const response = await http().get('/api/v1/absence-watch/findings').set('x-test-user', asUser({ role: role as never })).expect(200);
      expect(response.body.findings).toHaveLength(1);
      expect(response.body.findings[0]).toMatchObject({ studentName: 'Elev Ett', className: '7A', firstCrossedOn: '2026-09-24', absentMinutes: 60 });
      expect(Object.keys(response.body.findings[0])).not.toEqual(expect.arrayContaining(['reason', 'note', 'type']));
      const kinds = harness.tx.$executeRaw.mock.calls.map(([statement]) => (statement as { values: unknown[] }).values[0]);
      expect(kinds).toEqual(['ATTENDANCE', 'PEOPLE']);
    });

    it('are not for a pupil', async () => {
      await http().get('/api/v1/absence-watch/findings').set('x-test-user', asUser({ role: 'STUDENT' as never })).expect(403);
    });

    it('can include the recent ones, and refuse nothing else in the query', async () => {
      await http().get('/api/v1/absence-watch/findings?recent=1').set('x-test-user', asUser({})).expect(200);
      expect(harness.tx['absenceWatchFinding']!['findMany']).toHaveBeenLastCalledWith(
        expect.objectContaining({ where: { OR: [{ clearedOn: null }, { clearedOn: { gte: expect.any(Date) } }] } }),
      );
      await http().get('/api/v1/absence-watch/findings?recent=1&x=1').set('x-test-user', asUser({})).expect(400);
    });
  });
});
