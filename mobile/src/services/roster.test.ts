import { getAccessToken, getSupabase } from './supabase';
import { ApiError } from './api';
import { getCalendarLesson, upsertCalendarLesson, upsertStudents } from './database/localDatabase';
import { fetchRoster, openLessonForAttendance, rosterRefusal } from './roster';

jest.mock('./supabase', () => ({ getAccessToken: jest.fn(), getSupabase: jest.fn() }));
jest.mock('./database/localDatabase', () => ({
  getCalendarLesson: jest.fn(),
  upsertStudents: jest.fn(),
  upsertCalendarLesson: jest.fn(),
}));

/**
 * The roster a teacher ticks down on the phone, and the cache it is written to.
 *
 * Through the real gateway client against a stubbed fetch, so what is pinned
 * is the request the gateway receives — its URL, method and bearer — and what
 * the cache holds afterwards. Supabase is a mock that fails the test if asked:
 * the app built this list itself from four tables until the roster had one
 * reader on the gateway, and the broadcast that later replaces the cached
 * pupils asks that reader too.
 *
 * `reload` stands for the schedule screen reading itself again, which it does
 * after a refusal; it answers whether that read succeeded.
 */

const LESSON = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const ROUTE = `https://api.example.test/api/v1/attendance/lessons/${LESSON}/roster`;

const fetchMock = jest.fn();
const answer = (status: number, body?: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => (body === undefined ? '' : JSON.stringify(body)),
});

const lesson = {
  id: LESSON,
  startTime: '2026-10-14T07:10:00.000Z',
  endTime: '2026-10-14T08:00:00.000Z',
  subjectName: 'Matematik',
  roomName: 'B204',
};

// What this phone saved at an earlier open, or a broadcast wrote since: the
// pupils as they were then, and a room that has changed since.
const CACHED = { ...lesson, roomName: 'A101', studentIds: ['ada', 'bo'] };

// The gateway orders by Postgres collation, which folds Å into A.
const GATEWAY_ORDER = [
  { id: 'asa', firstName: 'Åsa', lastName: 'Åkesson' },
  { id: 'ada', firstName: 'Ada', lastName: 'Andersson' },
  { id: 'osten', firstName: 'Östen', lastName: 'Öberg' },
];

beforeEach(() => {
  process.env['EXPO_PUBLIC_API_BASE_URL'] = 'https://api.example.test/';
  Object.defineProperty(global, 'fetch', { value: fetchMock, writable: true, configurable: true });
  fetchMock.mockReset();
  (getAccessToken as jest.Mock).mockResolvedValue('jwt-teacher');
  (getCalendarLesson as jest.Mock).mockResolvedValue(null);
  (getSupabase as jest.Mock).mockImplementation(() => {
    throw new Error('The roster is the gateway’s to answer, not a Supabase table’s.');
  });
});

describe('the roster of a lesson', () => {
  it('is asked of the gateway’s one roster reader, and of no Supabase table', async () => {
    fetchMock.mockResolvedValue(answer(200, { students: GATEWAY_ORDER }));

    const roster = await fetchRoster(LESSON);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ROUTE);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({ 'X-SchemaPro-Client': 'app', Authorization: 'Bearer jwt-teacher' });
    expect(roster).toEqual(GATEWAY_ORDER);
    expect(getSupabase).not.toHaveBeenCalled();
  });

  it('caches exactly the pupils the gateway named, the set a broadcast replaces them with', async () => {
    fetchMock.mockResolvedValue(answer(200, { students: GATEWAY_ORDER }));
    const reload = jest.fn(async () => true);

    const opening = await openLessonForAttendance(lesson, reload);

    // In Swedish order, which neither Postgres nor SQLite gives: Å and Ö
    // after Z. displayName is built here and never leaves the device.
    expect(upsertStudents).toHaveBeenCalledWith([
      { id: 'ada', displayName: 'Ada Andersson', photoUri: null },
      { id: 'asa', displayName: 'Åsa Åkesson', photoUri: null },
      { id: 'osten', displayName: 'Östen Öberg', photoUri: null },
    ]);
    const fresh = { ...lesson, studentIds: ['ada', 'asa', 'osten'] };
    expect(opening).toEqual({ kind: 'OPEN', lesson: fresh, fromCache: false });
    expect(upsertCalendarLesson).toHaveBeenCalledWith(fresh);
    expect(reload).not.toHaveBeenCalled();
    expect(getSupabase).not.toHaveBeenCalled();
  });

  it('caches a lesson with nobody active on it as empty, not as the last list', async () => {
    fetchMock.mockResolvedValue(answer(200, { students: [] }));
    (getCalendarLesson as jest.Mock).mockResolvedValue(CACHED);

    const opening = await openLessonForAttendance(lesson, async () => true);

    expect(opening).toEqual({ kind: 'OPEN', lesson: { ...lesson, studentIds: [] }, fromCache: false });
    expect(upsertCalendarLesson).toHaveBeenCalledWith({ ...lesson, studentIds: [] });
  });

  it.each([
    [403, 'NOT_ASSIGNED', 'You are not assigned to this lesson and cannot record attendance for it.'],
    [404, 'NOT_FOUND', `Calendar lesson not found: ${LESSON}`],
  ] as const)('opens nothing on %i, not even the cached copy, and says %s once the schedule is read again', async (status, refusal, message) => {
    // Recording a register for a lesson the teacher is not on is refused the
    // same way, so a list opened from the cache could never be sent.
    fetchMock.mockResolvedValue(answer(status, { statusCode: status, message }));
    (getCalendarLesson as jest.Mock).mockResolvedValue(CACHED);
    const reload = jest.fn(async () => true);

    const opening = await openLessonForAttendance(lesson, reload);

    expect(opening).toEqual({ kind: 'NOT_OPENED', message: `schedule.refused.${refusal}` });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(upsertStudents).not.toHaveBeenCalled();
    expect(upsertCalendarLesson).not.toHaveBeenCalled();
  });

  it('leaves the reload’s own failure on screen when the schedule could not be read again', async () => {
    // Said over a schedule that failed to load, the refusal would explain a
    // row that is still listed and hide why it is still there.
    fetchMock.mockResolvedValue(answer(404, { statusCode: 404, message: `Calendar lesson not found: ${LESSON}` }));

    const opening = await openLessonForAttendance(lesson, async () => false);

    expect(opening).toEqual({ kind: 'NOT_OPENED', message: null });
  });

  it.each([
    ['a 503', () => fetchMock.mockResolvedValue(answer(503, { statusCode: 503, message: 'Service Unavailable' }))],
    ['a 429', () => fetchMock.mockResolvedValue(answer(429, { statusCode: 429, message: 'ThrottlerException: Too Many Requests' }))],
    ['no answer', () => fetchMock.mockRejectedValue(new TypeError('Network request failed'))],
  ])('opens the cached copy on %s, with the lesson as the schedule shows it', async (_, gatewayFails) => {
    // The register opened through Supabase alone before it asked the
    // gateway; an outage of the gateway must not close it. The queue holds
    // the marks under this lesson's id until the gateway answers.
    gatewayFails();
    (getCalendarLesson as jest.Mock).mockResolvedValue(CACHED);
    const reload = jest.fn(async () => true);

    const opening = await openLessonForAttendance(lesson, reload);

    expect(getCalendarLesson).toHaveBeenCalledWith(LESSON);
    expect(opening).toEqual({ kind: 'OPEN', lesson: { ...lesson, studentIds: ['ada', 'bo'] }, fromCache: true });
    expect(upsertStudents).not.toHaveBeenCalled();
    expect(upsertCalendarLesson).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it.each([
    ['a 503', 'schedule.openError', () => fetchMock.mockResolvedValue(answer(503, { statusCode: 503 }))],
    ['no answer', 'schedule.openError', () => fetchMock.mockRejectedValue(new TypeError('Network request failed'))],
    ['a 429', 'schedule.busy', () => fetchMock.mockResolvedValue(answer(429, { statusCode: 429 }))],
  ] as const)('opens nothing on %s with nothing cached, and says %s', async (_, message, gatewayFails) => {
    // A 429 is the per-address limit a school or kommun behind one address
    // shares, and it clears within a minute: the teacher is told to wait
    // rather than that the lesson cannot be opened.
    gatewayFails();

    const opening = await openLessonForAttendance(lesson, async () => true);

    expect(opening).toEqual({ kind: 'NOT_OPENED', message });
    expect(upsertCalendarLesson).not.toHaveBeenCalled();
  });

  it('says the lesson could not be opened when the cache cannot be read either', async () => {
    fetchMock.mockRejectedValue(new TypeError('Network request failed'));
    (getCalendarLesson as jest.Mock).mockRejectedValue(new Error('[LocalDatabase] Database is not initialized.'));

    const opening = await openLessonForAttendance(lesson, async () => true);

    expect(opening).toEqual({ kind: 'NOT_OPENED', message: 'schedule.openError' });
  });

  it('tells a refusal from a gateway it could not reach', () => {
    expect(rosterRefusal(new ApiError(403, 'Forbidden'))).toBe('NOT_ASSIGNED');
    expect(rosterRefusal(new ApiError(404, 'Not Found'))).toBe('NOT_FOUND');
    expect(rosterRefusal(new TypeError('Network request failed'))).toBeNull();
    expect(rosterRefusal(new ApiError(429, 'Too Many Requests'))).toBeNull();
    expect(rosterRefusal(new ApiError(500, 'Internal server error'))).toBeNull();
    expect(rosterRefusal(new ApiError(401, 'Not authenticated.', 'NOT_AUTHENTICATED'))).toBeNull();
    expect(rosterRefusal(new ApiError(0, 'EXPO_PUBLIC_API_BASE_URL is not set.', 'NOT_CONFIGURED'))).toBeNull();
  });
});
