import request from 'supertest';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

/**
 * Säkerhetsnät (E9) over HTTP, through the real route, pipe, guard and exception filter: what the page saw (`expected`) is checked by the pipe, a
 * lesson somebody else has changed is a 409 whose code and flat `fields` reach the client (a problem forwards a code and flat params and drops
 * every other field, which the service's own spec cannot see), and a date that is no YYYY-MM-DD is a 400 with a code, and not a 500.
 */
const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const YEAR_ID = '44444444-4444-4444-8444-444444444444';
const SUBJECT_ID = '99999999-9999-4999-8999-999999999999';
const GROUP_ID = '88888888-8888-4888-8888-888888888888';
const ROOM_ID = '66666666-6666-4666-8666-666666666666';
const LESSON_ID = '12121212-1212-4212-8212-121212121212';
const WROTE = new Date('2026-11-28T09:00:00.000Z');
const time = (hh: number, mm = 0) => new Date(Date.UTC(1970, 0, 1, hh, mm));

describe('Lektionen ändrad av någon annan (e2e)', () => {
  let harness: TestHarness;
  const http = () => harness.app.getHttpServer();
  const patch = (body: object) => request(http()).patch(`/api/v1/master-lessons/${LESSON_ID}`).set('x-test-user', asUser({})).send(body);
  const stored = () => ({
    id: LESSON_ID,
    academicYearId: YEAR_ID,
    subjectId: SUBJECT_ID,
    studentGroupId: GROUP_ID,
    teacherId: null,
    coTeacherId: null,
    roomId: ROOM_ID,
    dayOfWeek: 3,
    startTime: time(13),
    endTime: time(14),
    isLocked: true,
    isParked: false,
    exemptFrom: [],
    fromPlacement: false,
    updatedAt: WROTE,
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
  beforeEach(() => {
    jest.clearAllMocks();
    const tx = harness.tx;
    tx['masterLesson']!['findUnique']!.mockResolvedValue(stored());
    tx['masterLesson']!['update']!.mockImplementation(async (args: { data: Record<string, unknown> }) => ({ ...stored(), ...args.data }));
    tx['masterLesson']!['findMany']!.mockResolvedValue([]);
    // The row lock of a request that says what the page saw: the row as it stands.
    tx.$queryRaw.mockResolvedValue([{ updatedAt: WROTE }]);
  });

  it('answers 409 with the code and the fields flat in params when the lesson is not as the page saw it, and writes nothing', async () => {
    const response = await patch({ dayOfWeek: 2, expected: { dayOfWeek: 1, startTime: '13:00' } }).expect(409);
    expect(response.body).toMatchObject({ code: 'LESSON_CHANGED', params: { fields: 'dayOfWeek' } });
    expect(typeof response.body.detail).toBe('string');
    expect(harness.tx['masterLesson']!['update']).not.toHaveBeenCalled();
  });

  it('lets a request through that holds what the page saw, and one that says nothing of it, as before', async () => {
    await patch({ dayOfWeek: 2, expected: { dayOfWeek: 3, startTime: '13:00' } }).expect(200);
    await patch({ roomId: ROOM_ID }).expect(200);
    expect(harness.tx['masterLesson']!['update']).toHaveBeenCalledTimes(2);
  });

  it('refuses what the pipe can see is no reading of a lesson: a field that is not one, a clock that is not one, a day with a time, a shape that is no object', async () => {
    for (const expected of [{ colour: 'red' }, { startTime: '9' }, { startDate: '2026-09-07T00:00:00.000Z' }, { dayOfWeek: 9 }, { roomId: 'Sal 1' }, 'dag']) {
      await patch({ expected }).expect(400);
    }
    expect(harness.tx['masterLesson']!['update']).not.toHaveBeenCalled();
  });

  it('answers 400 with a code for a day that is no YYYY-MM-DD, and not the 500 it was', async () => {
    for (const startDate of ['20260817', '2026-W34-1', '2026-229']) {
      const response = await patch({ startDate }).expect(400);
      expect(response.body).toMatchObject({ code: 'LESSON_DATE_FORM' });
    }
    expect(harness.tx['masterLesson']!['update']).not.toHaveBeenCalled();
    await patch({ startDate: '2026-09-07' }).expect(200);
  });
});
