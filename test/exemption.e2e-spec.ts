import request from 'supertest';
import { Role } from '../src/auth/enums/role.enum';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

/**
 * Undantag med flit over HTTP, through the real route, pipe and guard (g467): the question "Lägg ändå" is answered by an administrator and by nobody
 * else, and only with the two names the board can be answered for. The unit specs call the service; a 403 row stops at the guard.
 */
const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const YEAR_ID = '44444444-4444-4444-8444-444444444444';
const SUBJECT_ID = '99999999-9999-4999-8999-999999999999';
const GROUP_ID = '88888888-8888-4888-8888-888888888888';
const LESSON_ID = '12121212-1212-4212-8212-121212121212';
const time = (hh: number, mm = 0) => new Date(Date.UTC(1970, 0, 1, hh, mm));

describe('Undantag med flit (e2e)', () => {
  let harness: TestHarness;
  const http = () => harness.app.getHttpServer();
  const patch = (user: string, body: object) => request(http()).patch(`/api/v1/master-lessons/${LESSON_ID}`).set('x-test-user', user).send(body);
  const stored = () => ({
    id: LESSON_ID,
    academicYearId: YEAR_ID,
    subjectId: SUBJECT_ID,
    studentGroupId: GROUP_ID,
    teacherId: null,
    coTeacherId: null,
    roomId: null,
    dayOfWeek: 1,
    startTime: time(14, 30),
    endTime: time(15, 30),
    isLocked: true,
    isParked: false,
    exemptFrom: ['FRAME'],
    fromPlacement: false,
    recurrence: 'ALL_WEEKS',
    startDate: null,
    endDate: null,
    extraGroups: [],
    participants: [],
    school: { id: SCHOOL_ID, timezone: 'Europe/Stockholm', _count: { academicYears: 1, teacherWorkRules: 0, teacherEmployments: 0 } },
  });

  beforeAll(async () => {
    harness = await createTestApp();
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(() => jest.clearAllMocks());

  it('is for the administrator: a teacher, a pupil and a caller with no principal never reach the service', async () => {
    for (const role of [Role.TEACHER, Role.STUDENT]) {
      await patch(asUser({ role }), { exempt: ['FRAME'] }).expect(403);
      await request(http()).post('/api/v1/master-lessons/judge').set('x-test-user', asUser({ role })).send({ moves: [{ lessonId: LESSON_ID, exempt: ['FRAME'] }] }).expect(403);
    }
    await request(http()).patch(`/api/v1/master-lessons/${LESSON_ID}`).send({ exempt: ['FRAME'] }).expect(401);
    expect(harness.tx['masterLesson']!['update']).not.toHaveBeenCalled();
  });

  it('takes the two names and no other: a rule that cannot be exempted, the column’s own name, and a shape that is no list are 400 before the service', async () => {
    for (const exempt of [['TEACHER'], ['GRADE_RULE'], ['SCHOOL_DAY'], 'FRAME', ['frame'], ['FRAME', 'LUNCH', 'FRAME']]) {
      await patch(asUser({}), { exempt }).expect(400);
    }
    await patch(asUser({}), { exemptFrom: ['FRAME'] }).expect(400);
    await request(http()).post('/api/v1/master-lessons/judge').set('x-test-user', asUser({})).send({ moves: [{ lessonId: LESSON_ID, exempt: ['TEACHER'] }] }).expect(400);
    expect(harness.tx['masterLesson']!['update']).not.toHaveBeenCalled();
  });

  it('lets an administrator take an exemption back: the 200 is the lesson without it', async () => {
    const tx = harness.tx;
    tx['masterLesson']!['findUnique']!.mockResolvedValue(stored());
    tx['masterLesson']!['update']!.mockResolvedValue({ ...stored(), exemptFrom: [] });
    tx['masterLesson']!['findMany']!.mockResolvedValue([]);
    tx.$queryRaw.mockResolvedValue([]);
    const response = await patch(asUser({}), { exempt: [] }).expect(200);
    expect(response.body).toMatchObject({ id: LESSON_ID, dayOfWeek: 1 });
    expect('exemptFrom' in response.body).toBe(false);
    expect((tx['masterLesson']!['update']!.mock.calls[0]![0] as { data: Record<string, unknown> }).data).toMatchObject({ exemptFrom: [] });
    expect(response.body.warnings ?? []).toEqual([]);
  });
});
