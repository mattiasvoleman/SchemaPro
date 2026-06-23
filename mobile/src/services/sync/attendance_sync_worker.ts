import * as Network from 'expo-network';
import { SecureTokenStore } from '../auth/secureTokenStore';
import {
  getPendingAttendanceRecords,
  getPendingQueueCount,
  incrementRetryCount,
  markAttendanceRecordSynced,
} from '../database/localDatabase';
import type { PendingAttendanceRecord, SyncStatus } from '../../types';

// ─────────────────────────────────────────────────────────────────────────────
// Exponential backoff: delay = min(BASE * 2^retryCount, MAX_DELAY)
//   retry 0 →   0 ms (immediate first attempt)
//   retry 1 → 1 000 ms
//   retry 2 → 2 000 ms
//   retry 3 → 4 000 ms
//   retry 4 → 8 000 ms
//   retry 5+ → capped at 30 000 ms
// After MAX_RETRIES the record is left in the queue for manual resolution.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;
const POLL_INTERVAL_MS = 15_000;

const API_BASE_URL = process.env['EXPO_PUBLIC_API_BASE_URL'];

export type SyncStatusCallback = (
  status: SyncStatus,
  pendingCount: number,
  errorMessage: string | null,
) => void;

function backoffDelay(retryCount: number): number {
  if (retryCount === 0) return 0;
  return Math.min(BASE_DELAY_MS * Math.pow(2, retryCount - 1), MAX_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isOnline(): Promise<boolean> {
  const state = await Network.getNetworkStateAsync();
  return state.isConnected === true && state.isInternetReachable === true;
}

async function pushRecord(record: PendingAttendanceRecord, token: string): Promise<void> {
  if (!API_BASE_URL) {
    throw new Error('[SyncWorker] EXPO_PUBLIC_API_BASE_URL is not set.');
  }

  const response = await fetch(`${API_BASE_URL}/attendance`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      id: record.id,
      lessonId: record.lessonId,
      studentId: record.studentId,
      status: record.status,
      timestamp: record.timestamp,
    }),
  });

  if (!response.ok) {
    throw new Error(`[SyncWorker] Server rejected record ${record.id} with status ${response.status}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export class AttendanceSyncWorker {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private isSyncing = false;
  private readonly onStatusChange: SyncStatusCallback;

  constructor(onStatusChange: SyncStatusCallback) {
    this.onStatusChange = onStatusChange;
  }

  /** Start the polling loop. Safe to call multiple times (idempotent). */
  start(): void {
    if (this.intervalHandle !== null) return;
    void this.runSyncCycle();
    this.intervalHandle = setInterval(() => {
      void this.runSyncCycle();
    }, POLL_INTERVAL_MS);
  }

  /** Stop the polling loop and cancel any in-flight interval. */
  stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /** Public entry point so the UI can request an immediate sync. */
  async runSyncCycle(): Promise<void> {
    if (this.isSyncing) return;

    const online = await isOnline();
    if (!online) {
      const pending = await getPendingQueueCount();
      this.onStatusChange('offline', pending, null);
      return;
    }

    const records = await getPendingAttendanceRecords();
    if (records.length === 0) {
      this.onStatusChange('connected', 0, null);
      return;
    }

    this.isSyncing = true;
    this.onStatusChange('syncing', records.length, null);

    const token = await SecureTokenStore.getToken();
    if (!token) {
      this.isSyncing = false;
      this.onStatusChange('error', records.length, 'Session expired — please log in again.');
      return;
    }

    let failureCount = 0;

    for (const record of records) {
      if (record.retryCount >= MAX_RETRIES) {
        // Silently skip — do not log PII, only the ID.
        console.warn(`[SyncWorker] Skipping record ${record.id}: exceeded ${MAX_RETRIES} retries.`);
        continue;
      }

      const delay = backoffDelay(record.retryCount);
      if (delay > 0) await sleep(delay);

      try {
        await pushRecord(record, token);
        await markAttendanceRecordSynced(record.id);
      } catch (err) {
        await incrementRetryCount(record.id);
        failureCount++;
        const msg = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[SyncWorker] ${msg}`);
      }
    }

    this.isSyncing = false;
    const remaining = await getPendingQueueCount();

    if (failureCount > 0 && remaining > 0) {
      this.onStatusChange(
        'error',
        remaining,
        `${failureCount} record(s) failed — will retry automatically.`,
      );
    } else {
      this.onStatusChange('connected', remaining, null);
    }
  }
}
