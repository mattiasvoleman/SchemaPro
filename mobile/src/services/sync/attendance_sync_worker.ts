import * as Network from 'expo-network';
import { getAccessToken } from '../supabase';
import { SecureTokenStore } from '../auth/secureTokenStore';
import { apiRequest } from '../api';
import {
  getPendingAttendanceRecords,
  getPendingQueueCount,
  incrementRetryCount,
  markAttendanceRecordSynced,
} from '../database/localDatabase';
import type { AttendanceStatus, PendingAttendanceRecord, SyncProblem, SyncStatus } from '../../types';

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

/**
 * What went wrong, as a code the banner words in the reader's language. The
 * worker used to hand the screen an English sentence; a code keeps the words
 * in the catalogue and the worker free of them.
 */
export type { SyncProblem };

export type SyncStatusCallback = (
  status: SyncStatus,
  pendingCount: number,
  problem: SyncProblem | null,
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

/** Local statuses are lowercase; the NestJS API uses the Prisma enum. */
const STATUS_TO_API: Record<AttendanceStatus, string> = {
  present: 'PRESENT',
  absent: 'ABSENT',
  late: 'LATE',
  excused: 'EXCUSED',
};

/**
 * Pushes every pending record for one lesson as a single batch to
 * `POST /api/v1/attendance/report` — the idempotent ingestion endpoint the
 * gateway exposes (safe to retry from this offline queue). Through the app's
 * one gateway client (services/api.ts), which checks the base URL is TLS and
 * throws on any status that is not a success.
 */
export async function pushLessonBatch(
  calendarLessonId: string,
  records: readonly PendingAttendanceRecord[],
  token: string,
): Promise<void> {
  await apiRequest<void>('/api/v1/attendance/report', {
    method: 'POST',
    token,
    body: {
      calendarLessonId,
      records: records.map((record) => ({
        studentId: record.studentId,
        status: STATUS_TO_API[record.status],
        // When the teacher actually marked it, not when the network came back.
        // A batch can sit in this queue for a day; without it the register says
        // the whole class was marked at once, hours after the lesson ended.
        recordedAt: record.timestamp,
      })),
    },
  });
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

    // Whose queue this is, before anything is counted or sent. A tablet is
    // shared, and signing out leaves the encrypted store keyed — so "the
    // queue" is not this teacher's queue. Sending a colleague's rows would
    // submit them under this session's token, and the server stamps the
    // recorder from the bearer it is given: an official document about a child
    // signed by a teacher who was never in the room. Counting them is milder
    // and still wrong — a badge that will not go down however much work you do.
    const session = await SecureTokenStore.getTeacherSession();
    if (!session) {
      this.onStatusChange('error', 0, { code: 'SESSION_EXPIRED' });
      return;
    }

    const online = await isOnline();
    if (!online) {
      this.onStatusChange('offline', await getPendingQueueCount(session.teacherId), null);
      return;
    }

    const records = await getPendingAttendanceRecords(session.teacherId);
    if (records.length === 0) {
      // Rows may still be queued for somebody else on this device. They are
      // theirs to send, so the count shown is this teacher's own: nought.
      this.onStatusChange('connected', 0, null);
      return;
    }

    this.isSyncing = true;
    this.onStatusChange('syncing', records.length, null);

    const token = await getAccessToken();
    if (!token) {
      this.isSyncing = false;
      this.onStatusChange('error', records.length, { code: 'SESSION_EXPIRED' });
      return;
    }

    let failureCount = 0;

    // Batch per lesson — the API ingests one lesson's records per request.
    const byLesson = new Map<string, PendingAttendanceRecord[]>();
    for (const record of records) {
      if (record.retryCount >= MAX_RETRIES) {
        // Silently skip — do not log PII, only the ID.
        console.warn(`[SyncWorker] Skipping record ${record.id}: exceeded ${MAX_RETRIES} retries.`);
        continue;
      }
      const list = byLesson.get(record.lessonId) ?? [];
      list.push(record);
      byLesson.set(record.lessonId, list);
    }

    for (const [lessonId, batch] of byLesson) {
      const maxRetryInBatch = Math.max(...batch.map((record) => record.retryCount));
      const delay = backoffDelay(maxRetryInBatch);
      if (delay > 0) await sleep(delay);

      try {
        await pushLessonBatch(lessonId, batch, token);
        await Promise.all(batch.map((record) => markAttendanceRecordSynced(record.id)));
      } catch (err) {
        await Promise.all(batch.map((record) => incrementRetryCount(record.id)));
        failureCount += batch.length;
        // The status only: a message can carry the gateway's words about a
        // child, and this log is not the place for them.
        const status = err instanceof Error && 'status' in err ? String((err as { status: unknown }).status) : 'network';
        console.error(`[SyncWorker] Batch for lesson ${lessonId} failed (${status}).`);
      }
    }

    this.isSyncing = false;
    const remaining = await getPendingQueueCount(session.teacherId);

    if (failureCount > 0 && remaining > 0) {
      this.onStatusChange('error', remaining, { code: 'RECORDS_FAILED', count: failureCount });
    } else {
      this.onStatusChange('connected', remaining, null);
    }
  }
}
