import { getAccessToken } from './supabase';
import { ApiError, apiRequest } from './api';
import { pushLessonBatch } from './sync/attendance_sync_worker';

jest.mock('./supabase', () => ({ getAccessToken: jest.fn(), getSupabase: jest.fn() }));
jest.mock('expo-network', () => ({ getNetworkStateAsync: jest.fn() }));
jest.mock('./database/localDatabase', () => ({}));
jest.mock('./auth/secureTokenStore', () => ({ SecureTokenStore: {} }));

/**
 * The app's one gateway client, and the attendance batch that now goes
 * through it. The batch is the regression that matters: it is the offline
 * queue's only way out, so its URL, bearer, body and failure on a refusal
 * must be exactly what the gateway's idempotent ingestion expected before.
 */

const fetchMock = jest.fn();
const answer = (status: number, body?: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => (body === undefined ? '' : JSON.stringify(body)),
});

beforeEach(() => {
  process.env['EXPO_PUBLIC_API_BASE_URL'] = 'https://api.example.test/';
  // Replaces expo's lazy fetch getter outright, so nothing requires the
  // native fetch module when the environment is torn down.
  Object.defineProperty(global, 'fetch', { value: fetchMock, writable: true, configurable: true });
  fetchMock.mockReset();
  (getAccessToken as jest.Mock).mockResolvedValue('session-token');
});

describe('apiRequest', () => {
  it('sends the session bearer to the TLS base, JSON in and out', async () => {
    fetchMock.mockResolvedValue(answer(200, { enabled: true }));
    await expect(apiRequest('/api/v1/push/config')).resolves.toEqual({ enabled: true });
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.test/api/v1/push/config', {
      method: 'GET',
      headers: { Authorization: 'Bearer session-token' },
    });
  });

  it('resolves a 204 to undefined', async () => {
    fetchMock.mockResolvedValue(answer(204));
    await expect(apiRequest('/api/v1/devices/release', { method: 'POST', body: { token: 't' } })).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      headers: { Authorization: 'Bearer session-token', 'Content-Type': 'application/json' },
      body: '{"token":"t"}',
    });
  });

  it('carries the gateway’s code on a refusal', async () => {
    fetchMock.mockResolvedValue(answer(400, { code: 'WEEK_OUT_OF_RANGE', message: 'Veckan ligger utanför det som går att visa.' }));
    const error = await apiRequest('/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 400, code: 'WEEK_OUT_OF_RANGE' });
  });

  it('refuses without a session, and a cleartext base, before any request', async () => {
    (getAccessToken as jest.Mock).mockResolvedValue(null);
    await expect(apiRequest('/x')).rejects.toMatchObject({ status: 401, code: 'NOT_AUTHENTICATED' });
    process.env['EXPO_PUBLIC_API_BASE_URL'] = 'http://api.example.test';
    await expect(apiRequest('/x')).rejects.toThrow(/https/);
    delete process.env['EXPO_PUBLIC_API_BASE_URL'];
    await expect(apiRequest('/x')).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes an abort signal through', async () => {
    fetchMock.mockResolvedValue(answer(204));
    const controller = new AbortController();
    await apiRequest('/x', { method: 'POST', body: {}, signal: controller.signal });
    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
  });
});

describe('pushLessonBatch (the offline queue’s way out)', () => {
  const record = (studentId: string, status: 'present' | 'absent') => ({
    id: `r-${studentId}`,
    lessonId: 'lesson-1',
    studentId,
    status,
    timestamp: '2026-10-13T08:03:00.000Z',
    submittedByTeacherId: 't-1',
    retryCount: 0,
  });

  it('posts one lesson’s records to the idempotent ingestion endpoint with the worker’s bearer', async () => {
    fetchMock.mockResolvedValue(answer(201, { saved: 2 }));
    await pushLessonBatch('lesson-1', [record('s-1', 'present'), record('s-2', 'absent')], 'worker-token');
    expect(getAccessToken).not.toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.test/api/v1/attendance/report');
    expect(init).toMatchObject({
      method: 'POST',
      headers: { Authorization: 'Bearer worker-token', 'Content-Type': 'application/json' },
    });
    expect(JSON.parse(init.body)).toEqual({
      calendarLessonId: 'lesson-1',
      records: [
        { studentId: 's-1', status: 'PRESENT', recordedAt: '2026-10-13T08:03:00.000Z' },
        { studentId: 's-2', status: 'ABSENT', recordedAt: '2026-10-13T08:03:00.000Z' },
      ],
    });
  });

  it('throws on a refusal, so the queue keeps the rows and counts a retry', async () => {
    fetchMock.mockResolvedValue(answer(500));
    await expect(pushLessonBatch('lesson-1', [record('s-1', 'present')], 'worker-token')).rejects.toMatchObject({ status: 500 });
  });
});
