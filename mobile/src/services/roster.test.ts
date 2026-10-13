import { getAccessToken, getSupabase } from './supabase';
import { ApiError } from './api';
import { upsertCalendarLesson, upsertStudents } from './database/localDatabase';
import { cacheLessonForAttendance, fetchRoster, rosterRefusal } from './roster';

jest.mock('./supabase', () => ({ getAccessToken: jest.fn(), getSupabase: jest.fn() }));
jest.mock('./database/localDatabase', () => ({
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
    expect(init.headers).toEqual({ Authorization: 'Bearer jwt-teacher' });
    expect(roster).toEqual(GATEWAY_ORDER);
    expect(getSupabase).not.toHaveBeenCalled();
  });

  it('caches exactly the pupils the gateway named, the set a broadcast replaces them with', async () => {
    fetchMock.mockResolvedValue(answer(200, { students: GATEWAY_ORDER }));

    const cached = await cacheLessonForAttendance(lesson);

    // In Swedish order, which neither Postgres nor SQLite gives: Å and Ö
    // after Z. displayName is built here and never leaves the device.
    expect(upsertStudents).toHaveBeenCalledWith([
      { id: 'ada', displayName: 'Ada Andersson', photoUri: null },
      { id: 'asa', displayName: 'Åsa Åkesson', photoUri: null },
      { id: 'osten', displayName: 'Östen Öberg', photoUri: null },
    ]);
    expect(cached).toEqual({ ...lesson, studentIds: ['ada', 'asa', 'osten'] });
    expect(upsertCalendarLesson).toHaveBeenCalledWith(cached);
    expect(getSupabase).not.toHaveBeenCalled();
  });

  it('caches a lesson with nobody active on it as empty, not as the last list', async () => {
    fetchMock.mockResolvedValue(answer(200, { students: [] }));

    const cached = await cacheLessonForAttendance(lesson);

    expect(cached.studentIds).toEqual([]);
    expect(upsertCalendarLesson).toHaveBeenCalledWith({ ...lesson, studentIds: [] });
  });

  it.each([
    [403, 'NOT_ASSIGNED', 'You are not assigned to this lesson and cannot record attendance for it.'],
    [404, 'NOT_FOUND', `Calendar lesson not found: ${LESSON}`],
  ] as const)('writes nothing when the gateway answers %i, and says why: %s', async (status, refusal, message) => {
    // Recording a register for a lesson the teacher is not on is refused the
    // same way, so a list opened from the cache could never be sent.
    fetchMock.mockResolvedValue(answer(status, { statusCode: status, message }));

    const failure = await cacheLessonForAttendance(lesson).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect(rosterRefusal(failure)).toBe(refusal);
    expect(upsertStudents).not.toHaveBeenCalled();
    expect(upsertCalendarLesson).not.toHaveBeenCalled();
  });

  it('tells a refusal from a gateway it could not reach', async () => {
    fetchMock.mockRejectedValue(new TypeError('Network request failed'));
    const offline = await cacheLessonForAttendance(lesson).catch((error: unknown) => error);

    expect(rosterRefusal(offline)).toBeNull();
    expect(upsertCalendarLesson).not.toHaveBeenCalled();
    expect(rosterRefusal(new ApiError(500, 'Internal server error'))).toBeNull();
    expect(rosterRefusal(new ApiError(401, 'Not authenticated.', 'NOT_AUTHENTICATED'))).toBeNull();
    expect(rosterRefusal(new ApiError(0, 'EXPO_PUBLIC_API_BASE_URL is not set.', 'NOT_CONFIGURED'))).toBeNull();
  });
});
