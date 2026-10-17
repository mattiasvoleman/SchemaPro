import * as Network from 'expo-network';
import { getAccessToken } from '../supabase';
import { SecureTokenStore } from '../auth/secureTokenStore';
import {
  discardRefusedRecords,
  getPendingAttendanceRecords,
  getQueueCounts,
  getRefusedLessons,
  incrementRetryCount,
  markAttendanceRecordSynced,
} from '../database/localDatabase';
import { AttendanceSyncWorker } from './attendance_sync_worker';

jest.mock('expo-network', () => ({ getNetworkStateAsync: jest.fn() }));
jest.mock('../supabase', () => ({ getAccessToken: jest.fn(), getSupabase: jest.fn() }));
jest.mock('../auth/secureTokenStore', () => ({ SecureTokenStore: { getTeacherSession: jest.fn() } }));
jest.mock('../database/localDatabase', () => ({
  discardRefusedRecords: jest.fn(async () => undefined),
  getRefusedLessons: jest.fn(async () => []),
  getPendingAttendanceRecords: jest.fn(),
  getQueueCounts: jest.fn(),
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
  (getQueueCounts as jest.Mock).mockResolvedValue({ pending: 0, refused: 0 });
});

it('says an expired session as SESSION_EXPIRED', async () => {
  (SecureTokenStore.getTeacherSession as jest.Mock).mockResolvedValue(null);
  const status = jest.fn();
  await new AttendanceSyncWorker(status).runSyncCycle();
  expect(status).toHaveBeenCalledWith('error', 0, { code: 'SESSION_EXPIRED' });
});

it('sends one batch per lesson, marks the sent ones, and counts the failed ones as RECORDS_FAILED', async () => {
  (getPendingAttendanceRecords as jest.Mock).mockResolvedValue([record('1', 'L1'), record('2', 'L1'), record('3', 'L2')]);
  (getQueueCounts as jest.Mock).mockResolvedValue({ pending: 1, refused: 0 });
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

it('names this teacher’s refused lessons, and discards only the ones shown, for this teacher, then says where it stands', async () => {
  const lesson = { lessonId: 'L1', subjectName: 'Matematik', startTime: null, markedAt: '2026-10-13T08:03:00.000Z', count: 2 };
  (getRefusedLessons as jest.Mock).mockResolvedValue([lesson]);
  (getPendingAttendanceRecords as jest.Mock).mockResolvedValue([]);
  const status = jest.fn();
  const worker = new AttendanceSyncWorker(status);

  await expect(worker.refusedLessons()).resolves.toEqual([lesson]);
  expect(getRefusedLessons).toHaveBeenCalledWith('t-1', 5);

  await worker.discardRefused(['L1']);
  expect(discardRefusedRecords).toHaveBeenCalledWith('t-1', 5, ['L1']);
  expect(status).toHaveBeenLastCalledWith('connected', 0, null);

  (discardRefusedRecords as jest.Mock).mockClear();
  await worker.discardRefused([]);
  expect(discardRefusedRecords).not.toHaveBeenCalled();
});

it('sends each pupil’s latest mark once, and settles the earlier ones with it', async () => {
  // Every submit queues the whole class again: two submits of one lesson.
  (getPendingAttendanceRecords as jest.Mock).mockResolvedValue([
    { ...record('1', 'L1'), studentId: 's-a', status: 'absent' as const },
    { ...record('2', 'L1'), studentId: 's-b' },
    { ...record('3', 'L1'), studentId: 's-a', status: 'late' as const },
  ]);
  fetchMock.mockResolvedValue({ ok: true, status: 201, json: async () => ({}), text: async () => '{}' });
  await new AttendanceSyncWorker(jest.fn()).runSyncCycle();

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const body = JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body) as { records: Array<{ studentId: string; status: string }> };
  expect(body.records).toEqual([
    expect.objectContaining({ studentId: 's-a', status: 'LATE' }),
    expect.objectContaining({ studentId: 's-b', status: 'PRESENT' }),
  ]);
  expect((markAttendanceRecordSynced as jest.Mock).mock.calls.map(([id]) => id).sort()).toEqual(['1', '2', '3']);
});

it('sends a lesson of more pupils than the gateway takes at once in batches of 200', async () => {
  (getPendingAttendanceRecords as jest.Mock).mockResolvedValue(
    Array.from({ length: 250 }, (_, i) => ({ ...record(String(i), 'L1'), studentId: `s-${i}` })),
  );
  fetchMock.mockResolvedValue({ ok: true, status: 201, json: async () => ({}), text: async () => '{}' });
  await new AttendanceSyncWorker(jest.fn()).runSyncCycle();

  const sizes = fetchMock.mock.calls.map((call) => (JSON.parse((call as [string, { body: string }])[1].body) as { records: unknown[] }).records.length);
  expect(sizes).toEqual([200, 50]);
  expect(markAttendanceRecordSynced).toHaveBeenCalledTimes(250);
});

it('says offline with this teacher’s own count and no problem', async () => {
  (Network.getNetworkStateAsync as jest.Mock).mockResolvedValue({ isConnected: false, isInternetReachable: false });
  (getQueueCounts as jest.Mock).mockResolvedValue({ pending: 4, refused: 0 });
  const status = jest.fn();
  await new AttendanceSyncWorker(status).runSyncCycle();
  expect(getQueueCounts).toHaveBeenCalledWith('t-1', 5);
  expect(status).toHaveBeenCalledWith('offline', 4, null);
});

it('names the refused records apart when offline too, out of the pending count', async () => {
  (Network.getNetworkStateAsync as jest.Mock).mockResolvedValue({ isConnected: false, isInternetReachable: false });
  (getQueueCounts as jest.Mock).mockResolvedValue({ pending: 4, refused: 25 });
  const status = jest.fn();
  await new AttendanceSyncWorker(status).runSyncCycle();
  expect(status).toHaveBeenCalledWith('offline', 4, { code: 'RECORDS_REFUSED', count: 25 });
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
    (getQueueCounts as jest.Mock).mockImplementation(async (_teacher: string, max: number) => ({
      pending: queue.filter((row) => row.retryCount < max).length,
      refused: queue.filter((row) => row.retryCount >= max).length,
    }));
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

  it.each([400, 403, 404, 422])('a %i counts a retry each cycle, and a record at MAX_RETRIES is refused, named and not pending', async (refusal) => {
    fetchMock.mockResolvedValue(answer(refusal));
    const status = jest.fn();
    const worker = new AttendanceSyncWorker(status);
    await cycle(worker);
    // While it is tried again, the banner says so.
    expect(status).toHaveBeenLastCalledWith('error', 1, { code: 'RECORDS_FAILED', count: 1 });
    for (let i = 1; i < MAX_RETRIES + 2; i++) await cycle(worker);

    expect(fetchMock).toHaveBeenCalledTimes(MAX_RETRIES);
    expect(incrementRetryCount).toHaveBeenCalledTimes(MAX_RETRIES);
    expect(incrementRetryCount).toHaveBeenCalledWith('1');
    expect(queue[0]?.retryCount).toBe(MAX_RETRIES);
    // Then it is refused: never sent again, not pending, and named, so the
    // banner no longer turns green over a lesson that is missing.
    expect(status).toHaveBeenLastCalledWith('error', 0, { code: 'RECORDS_REFUSED', count: 1 });
  });

  it('sends a new record beside a refused one, and keeps naming the refused one', async () => {
    queue = [{ ...record('1', 'L1'), retryCount: MAX_RETRIES }, record('2', 'L2')];
    fetchMock.mockResolvedValue(answer(201));
    const status = jest.fn();
    await cycle(new AttendanceSyncWorker(status));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body).calendarLessonId).toBe('L2');
    expect(status).toHaveBeenCalledWith('syncing', 1, null);
    expect(status).toHaveBeenLastCalledWith('error', 0, { code: 'RECORDS_REFUSED', count: 1 });
  });
});
