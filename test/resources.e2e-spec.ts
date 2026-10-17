import request from 'supertest';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

const SUBJECT_ID = '99999999-9999-4999-8999-999999999999';
const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';

describe('Resource CRUD (e2e)', () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = await createTestApp();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('subjects', () => {
    // A subject delete locks the lokal timplans that hold it first, with a raw
    // FOR SHARE read (subjects.service.ts); the auto-vivifying mock would hand
    // back a model proxy for `$queryRaw`, which is not callable.
    beforeEach(() => {
      Object.assign(harness.tx, { $queryRaw: jest.fn().mockResolvedValue([]) });
    });
    afterEach(() => {
      delete (harness.tx as Record<string, unknown>)['$queryRaw'];
    });

    it('creates a subject for the caller school', async () => {
      harness.tx['subject']!['create']!.mockResolvedValue({
        id: SUBJECT_ID,
        schoolId: SCHOOL_ID,
        name: 'Mathematics',
        code: 'MA',
        color: '#4f46e5',
      });

      const response = await request(harness.app.getHttpServer())
        .post('/api/v1/subjects')
        .set('x-test-user', asUser({}))
        .send({ name: 'Mathematics', code: 'MA', color: '#4f46e5' })
        .expect(201);

      expect(response.body).toMatchObject({ id: SUBJECT_ID, name: 'Mathematics' });
      // Tenant id must come from the JWT principal, never the request body.
      const createArgs = harness.tx['subject']!['create']!.mock.calls[0]?.[0] as {
        data: { schoolId: string };
      };
      expect(createArgs.data.schoolId).toBe(SCHOOL_ID);
    });

    it('rejects unknown body properties (whitelist)', async () => {
      await request(harness.app.getHttpServer())
        .post('/api/v1/subjects')
        .set('x-test-user', asUser({}))
        .send({ name: 'Math', schoolId: 'evil-other-school' })
        .expect(400);
    });

    it('updates and deletes a subject', async () => {
      harness.tx['subject']!['update']!.mockResolvedValue({
        id: SUBJECT_ID,
        name: 'Maths',
      });
      harness.tx['subject']!['delete']!.mockResolvedValue({ id: SUBJECT_ID });

      await request(harness.app.getHttpServer())
        .patch(`/api/v1/subjects/${SUBJECT_ID}`)
        .set('x-test-user', asUser({}))
        .send({ name: 'Maths' })
        .expect(200);

      await request(harness.app.getHttpServer())
        .delete(`/api/v1/subjects/${SUBJECT_ID}`)
        .set('x-test-user', asUser({}))
        .expect(204);
      const lock = harness.tx['$queryRaw'] as unknown as jest.Mock;
      expect(lock).toHaveBeenCalledTimes(1);
      expect(lock.mock.invocationCallOrder[0]).toBeLessThan(
        harness.tx['subject']!['delete']!.mock.invocationCallOrder[0]!,
      );
    });

    it('409s deleting a subject a decided lokal timplan holds, naming the plan, and deletes nothing', async () => {
      harness.tx['localTimplan']!['findMany']!.mockResolvedValueOnce([{ name: 'Grundskolan 2024' }]);

      const response = await request(harness.app.getHttpServer())
        .delete(`/api/v1/subjects/${SUBJECT_ID}`)
        .set('x-test-user', asUser({}))
        .expect(409);

      expect(response.body).toMatchObject({ status: 409, code: 'TIMPLAN_IS_DECIDED' });
      expect(response.body.detail).toContain('den beslutade lokala timplanen "Grundskolan 2024"');
      expect(harness.tx['subject']!['delete']).not.toHaveBeenCalled();
    });

    it('denies teachers and students (RBAC)', async () => {
      for (const role of ['TEACHER', 'STUDENT']) {
        await request(harness.app.getHttpServer())
          .post('/api/v1/subjects')
          .set('x-test-user', asUser({ role: role as never }))
          .send({ name: 'Physics' })
          .expect(403);
      }
    });
  });

  describe('rooms', () => {
    it('creates a room', async () => {
      harness.tx['room']!['create']!.mockResolvedValue({
        id: SUBJECT_ID,
        name: 'B12',
        capacity: 30,
      });

      await request(harness.app.getHttpServer())
        .post('/api/v1/rooms')
        .set('x-test-user', asUser({}))
        .send({ name: 'B12', capacity: 30 })
        .expect(201);
    });
  });

  describe('school units', () => {
    const UNIT_ID = '20000000-0000-4000-8000-0000000000f6';
    const unit = { id: UNIT_ID, name: 'Norra F–6', code: '11111111', schoolTypes: ['GR'], gradeFrom: 0, gradeTo: 6, ss12000Id: null };

    it('lists, creates, updates and removes the caller school\'s units as its admin', async () => {
      const server = harness.app.getHttpServer();
      harness.tx['schoolUnit']!['findMany']!.mockResolvedValue([unit]);
      const listed = await request(server).get('/api/v1/school-units').set('x-test-user', asUser({})).expect(200);
      expect(listed.body).toEqual([{ id: UNIT_ID, name: 'Norra F–6', code: '11111111', schoolTypes: ['GR'], gradeFrom: 0, gradeTo: 6, fromSource: false }]);

      harness.tx['schoolUnit']!['findMany']!.mockResolvedValue([]);
      harness.tx['schoolUnit']!['create']!.mockResolvedValue(unit);
      await request(server)
        .post('/api/v1/school-units')
        .set('x-test-user', asUser({}))
        .send({ name: 'Norra F–6', code: '1111 1111', schoolTypes: ['GR'], gradeFrom: 0, gradeTo: 6 })
        .expect(201);
      const created = harness.tx['schoolUnit']!['create']!.mock.calls[0]?.[0] as { data: Record<string, unknown> };
      // The school from the JWT principal, the code as eight digits.
      expect(created.data).toMatchObject({ schoolId: SCHOOL_ID, code: '11111111' });

      harness.tx['schoolUnit']!['findFirst']!.mockResolvedValue(unit);
      harness.tx['schoolUnit']!['update']!.mockResolvedValue({ ...unit, gradeTo: 5 });
      const patched = await request(server).patch(`/api/v1/school-units/${UNIT_ID}`).set('x-test-user', asUser({})).send({ gradeTo: 5 }).expect(200);
      expect(patched.body).toMatchObject({ gradeTo: 5 });

      harness.tx['schoolUnit']!['deleteMany']!.mockResolvedValue({ count: 1 });
      await request(server).delete(`/api/v1/school-units/${UNIT_ID}`).set('x-test-user', asUser({})).expect(204);
    });

    it('refuses a skolform it does not know, a grade past 10 and a field it does not take', async () => {
      const server = harness.app.getHttpServer();
      for (const body of [{ name: 'X', schoolTypes: ['GY'] }, { name: 'X', gradeFrom: 0, gradeTo: 11 }, { name: 'X', schoolId: SCHOOL_ID }]) {
        await request(server).post('/api/v1/school-units').set('x-test-user', asUser({})).send(body).expect(400);
      }
      expect(harness.tx['schoolUnit']!['create']).not.toHaveBeenCalled();
    });

    it('is the administrator\'s alone', async () => {
      for (const role of ['TEACHER', 'STUDENT', 'GUARDIAN']) {
        await request(harness.app.getHttpServer()).get('/api/v1/school-units').set('x-test-user', asUser({ role: role as never })).expect(403);
        await request(harness.app.getHttpServer())
          .post('/api/v1/school-units')
          .set('x-test-user', asUser({ role: role as never }))
          .send({ name: 'X' })
          .expect(403);
      }
    });
  });

  describe('sites', () => {
    const NORRA = '10000000-0000-4000-8000-0000000001a1';
    const SODRA = '20000000-0000-4000-8000-0000000001a2';

    it('lists, creates, renames, saves the travel times of and removes the caller school\'s sites as its admin', async () => {
      const server = harness.app.getHttpServer();
      harness.tx['$executeRaw']!.mockResolvedValue(1);
      harness.tx['site']!['findMany']!.mockResolvedValue([{ id: NORRA, name: 'Norra' }, { id: SODRA, name: 'Södra' }]);
      harness.tx['siteTravelTime']!['findMany']!.mockResolvedValue([{ siteAId: NORRA, siteBId: SODRA, minutes: 15 }]);
      harness.tx['room']!['groupBy']!.mockResolvedValue([{ siteId: null, _count: { _all: 2 } }]);
      const listed = await request(server).get('/api/v1/sites').set('x-test-user', asUser({})).expect(200);
      expect(listed.body).toEqual({
        sites: [
          { id: NORRA, name: 'Norra', roomCount: 0 },
          { id: SODRA, name: 'Södra', roomCount: 0 },
        ],
        travelTimes: [{ siteAId: NORRA, siteBId: SODRA, minutes: 15 }],
        roomsWithoutSite: 2,
      });

      harness.tx['site']!['create']!.mockResolvedValue({ id: NORRA, name: 'Norra' });
      await request(server).post('/api/v1/sites').set('x-test-user', asUser({})).send({ name: ' Norra ' }).expect(201);
      expect(harness.tx['site']!['create']).toHaveBeenCalledWith({
        data: { schoolId: SCHOOL_ID, name: 'Norra' },
        select: { id: true, name: true },
      });

      harness.tx['site']!['findFirst']!.mockResolvedValue({ id: NORRA });
      harness.tx['site']!['update']!.mockResolvedValue({ id: NORRA, name: 'Norr' });
      harness.tx['room']!['count']!.mockResolvedValue(0);
      await request(server).patch(`/api/v1/sites/${NORRA}`).set('x-test-user', asUser({})).send({ name: 'Norr' }).expect(200);

      harness.tx['siteTravelTime']!['findMany']!.mockResolvedValue([]);
      const saved = await request(server)
        .put('/api/v1/sites/travel-times')
        .set('x-test-user', asUser({}))
        .send({ times: [{ siteIds: [SODRA, NORRA], minutes: 15 }] })
        .expect(200);
      expect(saved.body).toEqual([{ siteAId: NORRA, siteBId: SODRA, minutes: 15 }]);

      harness.tx['site']!['deleteMany']!.mockResolvedValue({ count: 1 });
      await request(server).delete(`/api/v1/sites/${NORRA}`).set('x-test-user', asUser({})).expect(204);
    });

    it('refuses a name past 60, minutes past 240, a pair of one site and a field it does not take', async () => {
      const server = harness.app.getHttpServer();
      await request(server).post('/api/v1/sites').set('x-test-user', asUser({})).send({ name: 'x'.repeat(61) }).expect(400);
      await request(server).post('/api/v1/sites').set('x-test-user', asUser({})).send({ name: 'X', schoolId: SCHOOL_ID }).expect(400);
      for (const times of [[{ siteIds: [NORRA, SODRA], minutes: 241 }], [{ siteIds: [NORRA], minutes: 5 }], [{ siteIds: [NORRA, 'x'], minutes: 5 }]]) {
        await request(server).put('/api/v1/sites/travel-times').set('x-test-user', asUser({})).send({ times }).expect(400);
      }
      expect(harness.tx['site']!['create']).not.toHaveBeenCalled();
      expect(harness.tx['siteTravelTime']!['upsert']).not.toHaveBeenCalled();
    });

    it('is read by every administrator, written by planering, and nobody else\'s', async () => {
      const server = harness.app.getHttpServer();
      for (const role of ['TEACHER', 'STUDENT', 'GUARDIAN']) {
        await request(server).get('/api/v1/sites').set('x-test-user', asUser({ role: role as never })).expect(403);
        await request(server).post('/api/v1/sites').set('x-test-user', asUser({ role: role as never })).send({ name: 'X' }).expect(403);
      }
      const expedition = asUser({ adminProfile: 'EXPEDITION' } as never);
      harness.tx['site']!['findMany']!.mockResolvedValue([]);
      harness.tx['siteTravelTime']!['findMany']!.mockResolvedValue([]);
      harness.tx['room']!['groupBy']!.mockResolvedValue([]);
      await request(server).get('/api/v1/sites').set('x-test-user', expedition).expect(200);
      await request(server).post('/api/v1/sites').set('x-test-user', expedition).send({ name: 'X' }).expect(403);
      await request(server).put('/api/v1/sites/travel-times').set('x-test-user', expedition).send({ times: [] }).expect(403);
      expect(harness.tx['site']!['create']).not.toHaveBeenCalled();
    });

    it('puts a room on a site through the rooms route', async () => {
      harness.tx['room']!['update']!.mockResolvedValue({ id: SUBJECT_ID, siteId: NORRA });
      await request(harness.app.getHttpServer())
        .patch(`/api/v1/rooms/${SUBJECT_ID}`)
        .set('x-test-user', asUser({}))
        .send({ siteId: NORRA })
        .expect(200);
      expect(harness.tx['room']!['update']).toHaveBeenCalledWith({ where: { id: SUBJECT_ID }, data: { siteId: NORRA } });
    });
  });

  describe('calendar publish', () => {
    it('requires SCHOOL_ADMIN', async () => {
      await request(harness.app.getHttpServer())
        .post('/api/v1/calendar/publish')
        .set('x-test-user', asUser({ role: 'TEACHER' as never }))
        .send({ academicYearId: SUBJECT_ID })
        .expect(403);
    });

    it('404s when the academic year is not visible', async () => {
      harness.tx['academicYear']!['findUnique']!.mockResolvedValue(null);

      await request(harness.app.getHttpServer())
        .post('/api/v1/calendar/publish')
        .set('x-test-user', asUser({}))
        .send({ academicYearId: SUBJECT_ID })
        .expect(404);
    });
  });
});
