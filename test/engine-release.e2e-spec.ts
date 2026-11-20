import request from 'supertest';
import { Role } from '../src/auth/enums/role.enum';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

/**
 * Släppt för motorn over HTTP: the routes resolve, the guards and the area refuse before anything is read or written, the DTO
 * refuses what the page must not send, the write is one request that reaches the database the way the service means it (the
 * year's lock, the posts of the year, createMany that skips what is released, one log row), and what a client acts on survives the
 * exception filter, which forwards only a problem's `code` and flat `params`. A 403 row covers no handler, so the round trips are
 * here too.
 */

const YEAR_ID = '44444444-4444-4444-8444-444444444444';
const POST_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const POST_2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const PATH = '/api/v1/staffing/engine-release';

describe('Släppt för motorn (e2e)', () => {
  let harness: TestHarness;
  const http = () => harness.app.getHttpServer();
  const admin = () => asUser({});
  const releases = () => harness.tx['teachingRequirementRelease']!;
  const posts = () => harness.tx['teachingRequirement']!;
  const put = (body: Record<string, unknown>, as: string = admin()) => request(http()).put(PATH).set('x-test-user', as).send(body);

  beforeAll(async () => {
    harness = await createTestApp();
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    harness.tx['academicYear']!['findFirst']!.mockResolvedValue({ id: YEAR_ID });
    posts()['findMany']!.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.filter((id) => id === POST_ID || id === POST_2).map((id) => ({ id })),
    );
    releases()['findMany']!.mockResolvedValue([]);
    releases()['createMany']!.mockResolvedValue({ count: 1 });
    releases()['deleteMany']!.mockResolvedValue({ count: 1 });
    harness.tx['scheduleChangeLog']!['create']!.mockResolvedValue({ id: 'log-1' });
  });

  describe('reading', () => {
    it('lists the year’s released posts: the post, when, and by whom', async () => {
      releases()['findMany']!.mockResolvedValue([
        { requirementId: POST_ID, releasedById: USER_ID, releasedAt: new Date('2026-11-19T08:00:00.000Z') },
        { requirementId: POST_2, releasedById: null, releasedAt: new Date('2026-11-18T08:00:00.000Z') },
      ]);
      const response = await request(http()).get(`${PATH}?academicYearId=${YEAR_ID}`).set('x-test-user', admin()).expect(200);
      expect(response.body).toEqual({
        releases: [
          { requirementId: POST_ID, releasedAt: '2026-11-19T08:00:00.000Z', releasedById: USER_ID },
          { requirementId: POST_2, releasedAt: '2026-11-18T08:00:00.000Z', releasedById: null },
        ],
      });
    });

    it('is every administrator’s to read, the läsare’s included, and nobody else’s', async () => {
      await request(http()).get(`${PATH}?academicYearId=${YEAR_ID}`).set('x-test-user', asUser({ adminProfile: 'LASARE' as never })).expect(200);
      await request(http()).get(`${PATH}?academicYearId=${YEAR_ID}`).set('x-test-user', asUser({ adminProfile: 'EXPEDITION' as never })).expect(200);
      await request(http()).get(`${PATH}?academicYearId=${YEAR_ID}`).set('x-test-user', asUser({ role: Role.TEACHER })).expect(403);
      await request(http()).get(`${PATH}?academicYearId=${YEAR_ID}`).set('x-test-user', asUser({ role: Role.STUDENT })).expect(403);
      await request(http()).get(`${PATH}?academicYearId=${YEAR_ID}`).expect(401);
    });

    it('refuses a year that is no uuid, and 404s a year RLS hides', async () => {
      await request(http()).get(`${PATH}?academicYearId=x`).set('x-test-user', admin()).expect(400);
      harness.tx['academicYear']!['findFirst']!.mockResolvedValue(null);
      await request(http()).get(`${PATH}?academicYearId=${YEAR_ID}`).set('x-test-user', admin()).expect(404);
    });
  });

  describe('releasing and taking back', () => {
    it('releases a post as the administrator who asked: one request, the posts read, the rows written once, one log row (admin round-trip)', async () => {
      const response = await put({ academicYearId: YEAR_ID, requirementIds: [POST_ID, POST_2], released: true }).expect(200);
      expect(response.body).toEqual({ changed: 2, unchanged: 0 });
      const created = releases()['createMany']!.mock.calls[0]![0] as { data: Record<string, unknown>[]; skipDuplicates: boolean };
      expect(created.skipDuplicates).toBe(true);
      expect(created.data).toEqual([
        { requirementId: POST_ID, schoolId: SCHOOL_ID, releasedById: USER_ID },
        { requirementId: POST_2, schoolId: SCHOOL_ID, releasedById: USER_ID },
      ]);
      // The year's staffing lock first (a release and an apply of one year queue), then the posts, then the rows.
      const raw = JSON.stringify(harness.tx['$executeRaw']!.mock.calls);
      expect(raw).toContain('pg_advisory_xact_lock');
      expect(harness.tx['scheduleChangeLog']!['create']).toHaveBeenCalledTimes(1);
      const log = harness.tx['scheduleChangeLog']!['create']!.mock.calls[0]![0] as { data: Record<string, unknown> };
      expect(log.data).toMatchObject({
        schoolId: SCHOOL_ID,
        academicYearId: YEAR_ID,
        actorId: USER_ID,
        action: 'UPDATE',
        after: { kind: 'ENGINE_RELEASE', released: true, requirementIds: [POST_ID, POST_2] },
      });
    });

    it('leaves a post that is released alone, and says so: nothing is written, nothing is logged', async () => {
      releases()['findMany']!.mockResolvedValue([{ requirementId: POST_ID }]);
      const response = await put({ academicYearId: YEAR_ID, requirementIds: [POST_ID], released: true }).expect(200);
      expect(response.body).toEqual({ changed: 0, unchanged: 1 });
      expect(releases()['createMany']).not.toHaveBeenCalled();
      expect(harness.tx['scheduleChangeLog']!['create']).not.toHaveBeenCalled();
    });

    it('takes a release back for the posts that are released', async () => {
      releases()['findMany']!.mockResolvedValue([{ requirementId: POST_ID }]);
      const response = await put({ academicYearId: YEAR_ID, requirementIds: [POST_ID, POST_2], released: false }).expect(200);
      expect(response.body).toEqual({ changed: 1, unchanged: 1 });
      expect(releases()['deleteMany']).toHaveBeenCalledWith({ where: { requirementId: { in: [POST_ID] } } });
      expect(releases()['createMany']).not.toHaveBeenCalled();
    });

    it('answers a post of another year 400 ENGINE_RELEASE_POST_NOT_IN_YEAR with a flat count, writing nothing', async () => {
      posts()['findMany']!.mockResolvedValue([{ id: POST_ID }]);
      const response = await put({ academicYearId: YEAR_ID, requirementIds: [POST_ID, POST_2], released: true }).expect(400);
      expect(response.body).toMatchObject({ code: 'ENGINE_RELEASE_POST_NOT_IN_YEAR', params: { count: 1 } });
      expect(Object.keys(response.body.params)).toEqual(['count']);
      expect(releases()['createMany']).not.toHaveBeenCalled();
      expect(harness.tx['scheduleChangeLog']!['create']).not.toHaveBeenCalled();
    });

    it.each([
      ['no posts', { academicYearId: YEAR_ID, requirementIds: [], released: true }],
      ['a post that is no uuid', { academicYearId: YEAR_ID, requirementIds: ['x'], released: true }],
      ['the same post twice', { academicYearId: YEAR_ID, requirementIds: [POST_ID, POST_ID], released: true }],
      ['released that is no boolean', { academicYearId: YEAR_ID, requirementIds: [POST_ID], released: 'yes' }],
      ['a year that is no uuid', { academicYearId: 'x', requirementIds: [POST_ID], released: true }],
      ['no released at all', { academicYearId: YEAR_ID, requirementIds: [POST_ID] }],
    ])('400s %s before anything is read', async (_name, body) => {
      await put(body as Record<string, unknown>).expect(400);
      expect(harness.tx['academicYear']!['findFirst']).not.toHaveBeenCalled();
      expect(releases()['createMany']).not.toHaveBeenCalled();
    });

    it('refuses more than 5000 posts at the door', async () => {
      const many = Array.from({ length: 5001 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
      await put({ academicYearId: YEAR_ID, requirementIds: many, released: true }).expect(400);
    });

    it('refuses everyone but an administrator who writes PLANERING, before the database is touched', async () => {
      const body = { academicYearId: YEAR_ID, requirementIds: [POST_ID], released: true };
      await put(body, asUser({ role: Role.TEACHER })).expect(403);
      await put(body, asUser({ role: Role.STUDENT })).expect(403);
      await put(body, asUser({ adminProfile: 'LASARE' as never })).expect(403);
      await put(body, asUser({ adminProfile: 'EXPEDITION' as never })).expect(403);
      await request(http()).put(PATH).send(body).expect(401);
      expect(harness.tx['academicYear']!['findFirst']).not.toHaveBeenCalled();
      expect(releases()['createMany']).not.toHaveBeenCalled();
      expect(harness.tx['$executeRaw']).not.toHaveBeenCalled();
    });

    it('lets the schemaläggare release, who writes PLANERING', async () => {
      await put({ academicYearId: YEAR_ID, requirementIds: [POST_ID], released: true }, asUser({ adminProfile: 'SCHEMALAGGARE' as never })).expect(200);
      expect(releases()['createMany']).toHaveBeenCalledTimes(1);
    });
  });
});
