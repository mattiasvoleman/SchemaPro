import * as Network from 'expo-network';
import { getAccessToken } from '../supabase';
import { SecureTokenStore } from '../auth/secureTokenStore';
import {
  getPendingAttendanceRecords,
  getPendingQueueCount,
  incrementRetryCount,
  markAttendanceRecordSynced,
} from '../database/localDatabase';
import { AttendanceSyncWorker } from './attendance_sync_worker';

jest.mock('expo-network', () => ({ getNetworkStateAsync: jest.fn() }));
jest.mock('../supabase', () => ({ getAccessToken: jest.fn(), getSupabase: jest.fn() }));
jest.mock('../auth/secureTokenStore', () => ({ SecureTokenStore: { getTeacherSession: jest.fn() } }));
jest.mock('../database/localDatabase', () => ({
  getPendingAttendanceRecords: jest.fn(),
  getPendingQueueCount: jest.fn(),
  incrementRetryCount: jest.fn(async () => undefined),
  markAttendanceRecordSynced: jest.fn(async () => undefined),
}));

/**
 * The worker reports what went wrong as a code the banner words in the
 * reader's language — it used to hand the screen an English sentence — and
 * otherwise behaves as before: this teacher's queue only, one batch per
 * lesson, a failed batch kept and counted.
 */

const fetchMock = jest.fn();
const record = (id: string, lessonId: string) => ({
  id,
  lessonId,
  studentId: `s-${id}`,
  status: 'present' as const,
  timestamp: '2026-10-13T08:03:00.000Z',
  submittedByTeacherId: 't-1',
  retryCount: 0,
});

beforeEach(() => {
  process.env['EXPO_PUBLIC_API_BASE_URL'] = 'https://api.example.test';
  // Replaces expo's lazy fetch getter outright, so nothing requires the
  // native fetch module when the environment is torn down.
  Object.defineProperty(global, 'fetch', { value: fetchMock, writable: true, configurable: true });
  fetchMock.mockReset();
  (Network.getNetworkStateAsync as jest.Mock).mockResolvedValue({ isConnected: true, isInternetReachable: true });
  (SecureTokenStore.getTeacherSession as jest.Mock).mockResolvedValue({ teacherId: 't-1', role: 'TEACHER' });
  (getAccessToken as jest.Mock).mockResolvedValue('token');
  (getPendingQueueCount as jest.Mock).mockResolvedValue(0);
});

it('says an expired session as SESSION_EXPIRED', async () => {
  (SecureTokenStore.getTeacherSession as jest.Mock).mockResolvedValue(null);
  const status = jest.fn();
  await new AttendanceSyncWorker(status).runSyncCycle();
  expect(status).toHaveBeenCalledWith('error', 0, { code: 'SESSION_EXPIRED' });
});

it('sends one batch per lesson, marks the sent ones, and counts the failed ones as RECORDS_FAILED', async () => {
  (getPendingAttendanceRecords as jest.Mock).mockResolvedValue([record('1', 'L1'), record('2', 'L1'), record('3', 'L2')]);
  (getPendingQueueCount as jest.Mock).mockResolvedValue(1);
  fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
    const ok = JSON.parse(init.body).calendarLessonId === 'L1';
    return { ok, status: ok ? 201 : 500, json: async () => ({}), text: async () => '{}' };
  });
  const status = jest.fn();
  await new AttendanceSyncWorker(status).runSyncCycle();
  expect(getPendingAttendanceRecords).toHaveBeenCalledWith('t-1');
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(markAttendanceRecordSynced).toHaveBeenCalledTimes(2);
  // A 500 is the server's trouble, not the batch's: kept, but no retry counted.
  expect(incrementRetryCount).not.toHaveBeenCalled();
  expect(status).toHaveBeenLastCalledWith('error', 1, { code: 'RECORDS_FAILED', count: 1 });
});

it('says offline with this teacher’s own count and no problem', async () => {
  (Network.getNetworkStateAsync as jest.Mock).mockResolvedValue({ isConnected: false, isInternetReachable: false });
  (getPendingQueueCount as jest.Mock).mockResolvedValue(4);
  const status = jest.fn();
  await new AttendanceSyncWorker(status).runSyncCycle();
  expect(getPendingQueueCount).toHaveBeenCalledWith('t-1');
  expect(status).toHaveBeenCalledWith('offline', 4, null);
});

/**
 * Only a refusal of the batch itself counts toward the cap. Every failure used
 * to, so a minute of bad network or a register busy with an SS12000 apply left
 * a teacher's marks skipped for good. The queue here is the table as SQLite
 * keeps it: a retry the worker counts is read back on the next cycle, so a
 * count it should not have made shows as a record skipped, not only a call.
 */
describe('which failures count toward MAX_RETRIES', () => {
  const MAX_RETRIES = 5; // the worker's
  const answer = (status: number, body: object = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  let queue: ReturnType<typeof record>[];
  let quiet: jest.SpyInstance[];

  beforeEach(() => {
    jest.useFakeTimers();
    quiet = [jest.spyOn(console, 'error').mockImplementation(() => undefined), jest.spyOn(console, 'warn').mockImplementation(() => undefined)];
    queue = [record('1', 'L1')];
    (getPendingAttendanceRecords as jest.Mock).mockImplementation(async () => queue.map((row) => ({ ...row })));
    (getPendingQueueCount as jest.Mock).mockImplementation(async () => queue.length);
    (incrementRetryCount as jest.Mock).mockImplementation(async (id: string) => {
      queue.find((row) => row.id === id)!.retryCount += 1;
    });
    (markAttendanceRecordSynced as jest.Mock).mockImplementation(async (id: string) => {
      queue = queue.filter((row) => row.id !== id);
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    quiet.forEach((spy) => spy.mockRestore());
    (incrementRetryCount as jest.Mock).mockImplementation(async () => undefined);
    (markAttendanceRecordSynced as jest.Mock).mockImplementation(async () => undefined);
  });

  /** One poll, with the backoff's sleep run out. */
  async function cycle(worker: AttendanceSyncWorker): Promise<void> {
    const done = worker.runSyncCycle();
    await jest.runAllTimersAsync();
    await done;
  }

  it.each([
    ['a 409 from a busy register', '409', () => fetchMock.mockResolvedValue(answer(409, { code: 'BUSY' }))],
    ['a 503', '503', () => fetchMock.mockResolvedValue(answer(503))],
    ['a 401 the next sign-in renews', '401', () => fetchMock.mockResolvedValue(answer(401))],
    ['no answer at all', 'network', () => fetchMock.mockRejectedValue(new TypeError('Network request failed'))],
  ])('%s counts no retry, and the batch goes again on every cycle past MAX_RETRIES', async (_failure, logged, fail) => {
    fail();
    const status = jest.fn();
    const worker = new AttendanceSyncWorker(status);
    for (let i = 0; i < MAX_RETRIES + 2; i++) await cycle(worker);

    expect(fetchMock).toHaveBeenCalledTimes(MAX_RETRIES + 2);
    expect(incrementRetryCount).not.toHaveBeenCalled();
    expect(queue[0]?.retryCount).toBe(0);
    // The screen says what it said before, and the log the status alone.
    expect(status).toHaveBeenLastCalledWith('error', 1, { code: 'RECORDS_FAILED', count: 1 });
    expect(console.error).toHaveBeenLastCalledWith(`[SyncWorker] Batch for lesson L1 failed (${logged}).`);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(answer(201));
    await cycle(worker);
    expect(markAttendanceRecordSynced).toHaveBeenCalledWith('1');
    expect(queue).toHaveLength(0);
    expect(status).toHaveBeenLastCalledWith('connected', 0, null);
  });

  it.each([400, 422])('a %i counts a retry each cycle, and a record at MAX_RETRIES is skipped', async (refusal) => {
    fetchMock.mockResolvedValue(answer(refusal));
    const worker = new AttendanceSyncWorker(jest.fn());
    for (let i = 0; i < MAX_RETRIES + 2; i++) await cycle(worker);

    expect(fetchMock).toHaveBeenCalledTimes(MAX_RETRIES);
    expect(incrementRetryCount).toHaveBeenCalledTimes(MAX_RETRIES);
    expect(incrementRetryCount).toHaveBeenCalledWith('1');
    expect(queue[0]?.retryCount).toBe(MAX_RETRIES);
    expect(console.warn).toHaveBeenLastCalledWith(`[SyncWorker] Skipping record 1: exceeded ${MAX_RETRIES} retries.`);
  });
});
