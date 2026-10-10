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
  expect(incrementRetryCount).toHaveBeenCalledWith('3');
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
