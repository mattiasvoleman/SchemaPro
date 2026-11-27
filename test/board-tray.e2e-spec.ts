import request from 'supertest';
import { Role } from '../src/auth/enums/role.enum';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

/**
 * Att lägga (E4) over HTTP: the route resolves with its query pipes, every administrator reads it and no teacher does, and the answer is
 * the tray of the year. A unit spec calls the service as a plain method and skips exactly what makes a route a route (the guards, the
 * pipes, the filter), so the claim "a read every administrator may make" is held here, through the request pipeline.
 */

const YEAR_ID = '44444444-4444-4444-8444-444444444444';
const GROUP_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_GROUP_ID = '66666666-6666-4666-8666-666666666666';
const POST_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const POST_2_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SUBJECT_ID = '99999999-9999-4999-8999-999999999999';
const TEACHER_ID = '88888888-8888-4888-8888-888888888888';

const post = (over: Record<string, unknown> = {}) => ({
  id: POST_ID,
  studentGroupId: GROUP_ID,
  subjectId: SUBJECT_ID,
  teacherId: TEACHER_ID,
  coTeacherId: null,
  lessonsPerWeek: 2,
  minutesPerLesson: 60,
  lessonLengths: [],
  recurrence: 'ALL_WEEKS',
  blockId: null,
  startDate: null,
  endDate: null,
  minutesBefore: 0,
  minutesAfter: 0,
  shares: [],
  ...over,
});

describe('Att lägga: grundschemats bricklåda (e2e)', () => {
  let harness: TestHarness;
  const http = () => harness.app.getHttpServer();
  const tray = (query = `academicYearId=${YEAR_ID}`) => request(http()).get(`/api/v1/board-tray?${query}`);

  beforeAll(async () => {
    harness = await createTestApp();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    harness.tx['academicYear']!['findUnique']!.mockResolvedValue({ id: YEAR_ID });
    harness.tx['teachingRequirement']!['findMany']!.mockResolvedValue([post(), post({ id: POST_2_ID, studentGroupId: OTHER_GROUP_ID, lessonsPerWeek: 1 })]);
    harness.tx['teachingRequirementPlacement']!['findMany']!.mockResolvedValue([]);
    harness.tx['masterLesson']!['findMany']!.mockResolvedValue([]);
    harness.tx['teachingBlock']!['findMany']!.mockResolvedValue([]);
  });

  it('answers an administrator with the year\'s bricks, the head\'s figures and each class\'s count, and names nobody', async () => {
    const response = await tray().set('x-test-user', asUser({})).expect(200);
    expect(response.body.academicYearId).toBe(YEAR_ID);
    expect(response.body.bricks).toHaveLength(3);
    expect(response.body.tally).toEqual({ lessons: 3, laid: 0, placedByRow: 0, left: 3 });
    expect(response.body.groups).toEqual([{ studentGroupId: GROUP_ID, left: 2 }, { studentGroupId: OTHER_GROUP_ID, left: 1 }]);
    expect(JSON.stringify(response.body)).not.toMatch(/firstName|lastName|email/);
  });

  it('shows the bricks of one class when groupId is given, with the year\'s tally', async () => {
    const response = await tray(`academicYearId=${YEAR_ID}&groupId=${OTHER_GROUP_ID}`).set('x-test-user', asUser({})).expect(200);
    expect(response.body.bricks).toHaveLength(1);
    expect(response.body.bricks[0].studentGroupId).toBe(OTHER_GROUP_ID);
    expect(response.body.tally.lessons).toBe(3);
  });

  it('is every administrator\'s to read, whatever the profile, and no teacher\'s', async () => {
    for (const adminProfile of ['FULL', 'SCHEMALAGGARE', 'EXPEDITION', 'LASARE']) {
      await tray().set('x-test-user', asUser({ adminProfile: adminProfile as never })).expect(200);
    }
    await tray().set('x-test-user', asUser({ role: Role.TEACHER })).expect(403);
    await tray().set('x-test-user', asUser({ role: Role.STUDENT })).expect(403);
  });

  it('is nobody\'s without a login', async () => {
    await tray().expect(401);
  });

  it('refuses a year or a class that is no uuid, and a missing year, before anything is read', async () => {
    await tray('academicYearId=x').set('x-test-user', asUser({})).expect(400);
    await tray().set('x-test-user', asUser({})).expect(200);
    await tray(`academicYearId=${YEAR_ID}&groupId=x`).set('x-test-user', asUser({})).expect(400);
    await tray('').set('x-test-user', asUser({})).expect(400);
    expect(harness.tx['teachingRequirement']!['findMany']).toHaveBeenCalledTimes(1);
  });

  it('answers 404 for a year the caller cannot see', async () => {
    harness.tx['academicYear']!['findUnique']!.mockResolvedValue(null);
    await tray().set('x-test-user', asUser({})).expect(404);
  });
});
