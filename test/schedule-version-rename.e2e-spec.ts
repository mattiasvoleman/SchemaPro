import request from 'supertest';
import { Role } from '../src/auth/enums/role.enum';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

/**
 * Döp om en version (E9) over HTTP, through the real route, pipe and guard: only an administrator renames, the name is a name (1 to 120 characters, and no
 * other field), and the answer is the version as the list gives it. The service's own spec calls it directly and never meets the pipe or the guard.
 */
const VERSION = '55555555-5555-4555-8555-555555555555';
const YEAR = '44444444-4444-4444-8444-444444444444';

describe('Döp om en version (e2e)', () => {
  let harness: TestHarness;
  const http = () => harness.app.getHttpServer();
  const rename = (body: object, user = asUser({})) => request(http()).patch(`/api/v1/schedule-versions/${VERSION}`).set('x-test-user', user).send(body);

  beforeAll(async () => {
    harness = await createTestApp();
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    harness.tx['scheduleVersion']!['findUnique']!.mockResolvedValue({ id: VERSION });
    harness.tx['scheduleVersion']!['update']!.mockImplementation(async (args: { data: { name: string } }) => ({
      id: VERSION,
      academicYearId: YEAR,
      name: args.data.name,
      lessonCount: 3,
      createdAt: new Date('2026-08-06T12:00:00.000Z'),
    }));
  });

  it('is the administrator\'s: a teacher, a pupil and a caller with no principal never reach the service', async () => {
    for (const role of [Role.TEACHER, Role.STUDENT]) await rename({ name: 'Nytt' }, asUser({ role })).expect(403);
    await request(http()).patch(`/api/v1/schedule-versions/${VERSION}`).send({ name: 'Nytt' }).expect(401);
    expect(harness.tx['scheduleVersion']!['update']).not.toHaveBeenCalled();
  });

  it('is the schemaläggning area\'s: the profiles that write it reach the service, expedition and läsare are refused by name before it, and so are a guardian and the huvudman', async () => {
    for (const adminProfile of ['FULL', 'REKTOR', 'SCHEMALAGGARE']) await rename({ name: 'Nytt' }, asUser({ adminProfile, hrRead: false } as never)).expect(200);
    expect(harness.tx['scheduleVersion']!['update']).toHaveBeenCalledTimes(3);
    for (const adminProfile of ['EXPEDITION', 'LASARE']) {
      const refused = await rename({ name: 'Nytt' }, asUser({ adminProfile, hrRead: false } as never)).expect(403);
      expect(refused.body).toMatchObject({ code: 'AREA_NOT_YOURS' });
    }
    for (const role of [Role.GUARDIAN, Role.HUVUDMAN]) await rename({ name: 'Nytt' }, asUser({ role })).expect(403);
    expect(harness.tx['scheduleVersion']!['update']).toHaveBeenCalledTimes(3);
  });

  it('takes a name and nothing else: an empty one, one over 120 characters, another field and an id that is no uuid are 400 before the service', async () => {
    for (const body of [{}, { name: '' }, { name: 'x'.repeat(121) }, { name: 42 }, { name: 'Nytt', lessonCount: 0 }, { name: 'Nytt', lessons: [] }]) {
      await rename(body).expect(400);
    }
    await request(http()).patch('/api/v1/schedule-versions/inte-ett-id').set('x-test-user', asUser({})).send({ name: 'Nytt' }).expect(400);
    expect(harness.tx['scheduleVersion']!['update']).not.toHaveBeenCalled();
  });

  it('answers 200 with the version under its new name', async () => {
    const response = await rename({ name: 'Före vårjusteringar' }).expect(200);
    expect(response.body).toEqual({ id: VERSION, academicYearId: YEAR, name: 'Före vårjusteringar', lessonCount: 3, createdAt: '2026-08-06T12:00:00.000Z' });
  });

  it('answers 404 for a version that is not there', async () => {
    harness.tx['scheduleVersion']!['findUnique']!.mockResolvedValue(null);
    await rename({ name: 'Nytt' }).expect(404);
  });
});
