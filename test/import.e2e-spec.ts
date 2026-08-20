import request from 'supertest';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

/**
 * CSV import over HTTP.
 *
 * The bodies here are the ones web/lib/csv.ts actually posts after parsing a
 * school's file. That is the point of the suite: the service specs prove the
 * row semantics, and these prove the payload survives routing, the global
 * whitelist validation and RBAC on the way in.
 */

const YEAR_ID = '44444444-4444-4444-8444-444444444444';
const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const GROUP_ID = '55555555-5555-4555-8555-555555555555';

const post = (harness: TestHarness, path: string) =>
  request(harness.app.getHttpServer())
    .post(`/api/v1/import/${path}`)
    .set('x-test-user', asUser({}));

describe('CSV import (e2e)', () => {
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

  describe('routes accept what the browser sends', () => {
    it('imports teachers without emailing a single one of them', async () => {
      // Uploading a staff list is roster preparation, often weeks before term
      // starts. Inviting is a separate, deliberate act — see the invitation
      // routes in portal.e2e-spec.ts.
      harness.tx['user']!['findFirst']!.mockResolvedValue(null);
      harness.tx['user']!['create']!.mockResolvedValue({ id: 'u-1' });

      const response = await post(harness, 'teachers')
        .send({
          rows: [
            { firstName: 'Karin', lastName: 'Ek', email: 'karin.ek@example.com' },
          ],
        })
        .expect(201);

      expect(response.body).toEqual({ created: 1, skipped: 0, errors: [] });
      expect(harness.supabase.inviteUser).not.toHaveBeenCalled();

      const { data } = harness.tx['user']!['create']!.mock.calls[0]?.[0] as {
        data: { invitedAt: Date | null };
      };
      expect(data.invitedAt).toBeNull();
    });

    it('imports students, resolving the class by name for the posted year', async () => {
      harness.tx['studentGroup']!['findMany']!.mockResolvedValue([
        { id: GROUP_ID, name: '7A' },
      ]);
      harness.tx['user']!['findFirst']!.mockResolvedValue(null);
      harness.tx['user']!['create']!.mockResolvedValue({ id: 'u-2' });

      const response = await post(harness, 'students')
        .send({
          academicYearId: YEAR_ID,
          rows: [
            {
              firstName: 'Alma',
              lastName: 'Berg',
              email: 'alma@example.com',
              className: '7A',
            },
          ],
        })
        .expect(201);

      expect(response.body).toMatchObject({ created: 1, errors: [] });
      const findArgs = harness.tx['studentGroup']!['findMany']!.mock
        .calls[0]?.[0] as { where: { academicYearId: string } };
      expect(findArgs.where.academicYearId).toBe(YEAR_ID);
    });

    it('imports classes', async () => {
      harness.tx['studentGroup']!['findMany']!.mockResolvedValue([]);
      harness.tx['studentGroup']!['create']!.mockResolvedValue({ id: GROUP_ID });

      await post(harness, 'groups')
        .send({
          academicYearId: YEAR_ID,
          rows: [{ name: '7A', gradeLevel: 7 }],
        })
        .expect(201);
    });

    it('imports teaching-group memberships', async () => {
      harness.tx['studentGroup']!['findMany']!.mockResolvedValue([
        { id: GROUP_ID, name: 'Ma71' },
      ]);
      harness.tx['user']!['findMany']!.mockResolvedValue([
        { id: 'u-3', email: 'alma@example.com' },
      ]);
      harness.tx['studentGroupMember']!['findMany']!.mockResolvedValue([]);
      harness.tx['studentGroupMember']!['createMany']!.mockResolvedValue({
        count: 1,
      });

      await post(harness, 'group-members')
        .send({
          academicYearId: YEAR_ID,
          rows: [{ groupName: 'Ma71', email: 'alma@example.com' }],
        })
        .expect(201);
    });

    it('imports room types with no year in the body at all', async () => {
      // The web dialog omits academicYearId for this kind. With
      // forbidNonWhitelisted validation, sending one anyway would be a 400 —
      // so this route and the client must agree, and here they are checked
      // against each other rather than by inspection.
      harness.tx['roomType']!['findMany']!.mockResolvedValue([]);
      harness.tx['roomType']!['create']!.mockResolvedValue({ id: 'rt-1' });

      const response = await post(harness, 'room-types')
        .send({ rows: [{ name: 'Textilslöjd' }, { name: 'Hemkunskapssal' }] })
        .expect(201);

      expect(response.body).toMatchObject({ created: 2, errors: [] });
      const createArgs = harness.tx['roomType']!['create']!.mock.calls[0]?.[0] as {
        data: { schoolId: string };
      };
      expect(createArgs.data.schoolId).toBe(SCHOOL_ID);
    });

    it('400s if a client does send a year to the room-type route', async () => {
      await post(harness, 'room-types')
        .send({ academicYearId: YEAR_ID, rows: [{ name: 'Bildsal' }] })
        .expect(400);
    });
  });

  describe('validation', () => {
    it('rejects an empty row list rather than reporting a no-op success', async () => {
      await post(harness, 'teachers').send({ rows: [] }).expect(400);
    });

    it('rejects a row list over the cap', async () => {
      const rows = Array.from({ length: 501 }, (_, i) => ({
        firstName: 'A',
        lastName: 'B',
        email: `person${i}@example.com`,
      }));

      await post(harness, 'teachers').send({ rows }).expect(400);
    });

    it('rejects a malformed email, naming the field', async () => {
      const response = await post(harness, 'teachers')
        .send({ rows: [{ firstName: 'A', lastName: 'B', email: 'not-an-email' }] })
        .expect(400);

      expect(JSON.stringify(response.body)).toContain('email');
    });

    it('rejects a student row missing its class', async () => {
      await post(harness, 'students')
        .send({
          academicYearId: YEAR_ID,
          rows: [{ firstName: 'A', lastName: 'B', email: 'a@example.com' }],
        })
        .expect(400);
    });

    it('rejects a year that is not a uuid', async () => {
      await post(harness, 'students')
        .send({ academicYearId: '2026/2027', rows: [] })
        .expect(400);
    });

    it('never lets a body carry the tenant id', async () => {
      await post(harness, 'teachers')
        .send({
          schoolId: 'some-other-school',
          rows: [{ firstName: 'A', lastName: 'B', email: 'a@example.com' }],
        })
        .expect(400);
    });
  });

  describe('RBAC', () => {
    it.each(['TEACHER', 'STUDENT', 'GUARDIAN'])(
      'denies %s on every import route',
      async (role) => {
        for (const path of [
          'teachers',
          'students',
          'groups',
          'room-types',
          'group-members',
        ]) {
          await request(harness.app.getHttpServer())
            .post(`/api/v1/import/${path}`)
            .set('x-test-user', asUser({ role: role as never }))
            .send({ rows: [{ name: 'x' }] })
            .expect(403);
        }
      },
    );

    it('403s a school admin with no school on the principal', async () => {
      await request(harness.app.getHttpServer())
        .post('/api/v1/import/room-types')
        .set('x-test-user', asUser({ schoolId: undefined }))
        .send({ rows: [{ name: 'Aula' }] })
        .expect(403);
    });
  });
});

describe('CSV import rate limit (e2e)', () => {
  let harness: TestHarness;

  beforeAll(async () => {
    // Its own app: the limiter counts per process, so a shared one would leak
    // into — and be leaked into by — every other spec in this file.
    process.env['THROTTLE_LIMIT'] = '1000';
    harness = await createTestApp({ throttle: true });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('cuts a runaway client off at the 10 imports/minute the controller declares', async () => {
    harness.tx['roomType']!['findMany']!.mockResolvedValue([]);
    harness.tx['roomType']!['create']!.mockResolvedValue({ id: 'rt-1' });

    const send = () =>
      request(harness.app.getHttpServer())
        .post('/api/v1/import/room-types')
        .set('x-test-user', asUser({}))
        .send({ rows: [{ name: 'Aula' }] });

    // The route limit (10) must bind before the global default (1000 in the
    // test environment), or the decorator is not doing anything.
    for (let i = 0; i < 10; i++) {
      await send().expect(201);
    }
    await send().expect(429);
  });
});
