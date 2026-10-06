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
