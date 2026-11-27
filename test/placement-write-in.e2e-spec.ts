import request from 'supertest';
import { Role } from '../src/auth/enums/role.enum';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

/**
 * Skriv in förläggningarna (E4b) over HTTP: the routes resolve, with their query and body pipes, and the guards say who may do what. A unit spec calls the
 * service as a plain method and skips exactly what makes a route a route (the guards, the pipes, the filter), so the claims here are held through the
 * request pipeline: the preview is every administrator's to read; the write is the scheduler's, as a hand edit of the grundschema is; no teacher does either.
 * What the write decides is held by placement-write-in.spec.ts and placement-write-in.service.spec.ts, and against a real database by probe-skriv-in.ts.
 */

const YEAR_ID = '44444444-4444-4444-8444-444444444444';

describe('Skriv in förläggningarna (e2e)', () => {
  let harness: TestHarness;
  const http = () => harness.app.getHttpServer();
  const preview = (query = `academicYearId=${YEAR_ID}`) => request(http()).get(`/api/v1/placement-write-in?${query}`);
  const write = (body: Record<string, unknown> = { academicYearId: YEAR_ID }) => request(http()).post('/api/v1/placement-write-in').send(body);

  beforeAll(async () => {
    harness = await createTestApp();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // A year the caller cannot see: whatever reaches the service answers 404, and nothing is written.
    harness.tx['academicYear']!['findUnique']!.mockResolvedValue(null);
  });

  it('lets every administrator read the preview, whatever the profile, and no teacher or pupil', async () => {
    for (const adminProfile of ['FULL', 'SCHEMALAGGARE', 'EXPEDITION', 'LASARE']) {
      await preview().set('x-test-user', asUser({ adminProfile: adminProfile as never })).expect(404);
    }
    await preview().set('x-test-user', asUser({ role: Role.TEACHER })).expect(403);
    await preview().set('x-test-user', asUser({ role: Role.STUDENT })).expect(403);
    await preview().expect(401);
  });

  it('lets the scheduler write, and the profiles that may not edit the grundschema not', async () => {
    for (const adminProfile of ['FULL', 'SCHEMALAGGARE']) {
      await write().set('x-test-user', asUser({ adminProfile: adminProfile as never })).expect(404);
    }
    for (const adminProfile of ['EXPEDITION', 'LASARE']) {
      await write().set('x-test-user', asUser({ adminProfile: adminProfile as never })).expect(403);
    }
    await write().set('x-test-user', asUser({ role: Role.TEACHER })).expect(403);
    await write().expect(401);
    expect(harness.tx['masterLesson']!['createManyAndReturn']).not.toHaveBeenCalled();
    expect(harness.tx['masterLesson']!['deleteMany']).not.toHaveBeenCalled();
  });

  it('refuses a year that is no uuid, or none, before the service is reached', async () => {
    await preview('academicYearId=x').set('x-test-user', asUser({})).expect(400);
    await preview('').set('x-test-user', asUser({})).expect(400);
    await write({ academicYearId: 'x' }).set('x-test-user', asUser({})).expect(400);
    await write({}).set('x-test-user', asUser({})).expect(400);
    expect(harness.tx['academicYear']!['findUnique']).not.toHaveBeenCalled();
  });
});
