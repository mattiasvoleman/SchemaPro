import * as Network from 'expo-network';
import { getAccessToken } from '../supabase';
import { SecureTokenStore } from '../auth/secureTokenStore';
import { ApiError, apiRequest } from '../api';
import {
  discardRefusedRecords,
  getPendingAttendanceRecords,
  getQueueCounts,
  getRefusedLessons,
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
// Only a permanent refusal counts as a retry (isPermanentFailure). After
// MAX_RETRIES of those the record is refused: never sent again, left out of
// the pending count and named in the banner (RECORDS_REFUSED), which names
// the lessons and lets the teacher discard them once the register has been
// checked on the web. A transient failure is sent again on every cycle,
// however many there are. Only a pupil's latest mark is sent, at most
// MAX_BATCH_RECORDS a batch.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_RETRIES = 5;
/** The most records the gateway takes in one batch (report-attendance.dto.ts, ArrayMaxSize). */
const MAX_BATCH_RECORDS = 200;
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

/**
 * Whether a failed push counts toward MAX_RETRIES: only a 4xx the same batch
 * would get again. No answer at all, a 5xx, 408 and 429 say nothing about the
 * marks, and nor do 409, a busy or conflicting server that a retry resolves,
 * and 401, a sign-in the next cycle renews (the gateway also answers 401 when
 * it cannot check a token for a moment). Counting those gave up on a
 * teacher's register after a minute of bad network or a busy server, and
 * nothing ever sent it again. A 401 also answers an account the school has
 * deactivated: the batch is then refused before it reaches the register, on
 * every cycle until the account is active again or the teacher signs out,
 * and is kept, as the banner says.
 */
function isPermanentFailure(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  return err.status >= 400 && err.status < 500 && ![401, 408, 409, 429].includes(err.status);
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

  /** This teacher's refused records by lesson, for the banner to name. */
  async refusedLessons(): Promise<Awaited<ReturnType<typeof getRefusedLessons>>> {
    const session = await SecureTokenStore.getTeacherSession();
    return session ? getRefusedLessons(session.teacherId, MAX_RETRIES) : [];
  }

  /**
   * Forgets this teacher's refused records of the lessons the teacher was
   * shown and chose to discard, and says where the queue stands. A record
   * refused meanwhile, of a lesson not shown, stays.
   */
  async discardRefused(lessonIds: readonly string[]): Promise<void> {
    const session = await SecureTokenStore.getTeacherSession();
    if (!session || lessonIds.length === 0) return;
    await discardRefusedRecords(session.teacherId, MAX_RETRIES, lessonIds);
    await this.runSyncCycle();
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
      const { pending, refused } = await getQueueCounts(session.teacherId, MAX_RETRIES);
      this.onStatusChange('offline', pending, refusal(refused));
      return;
    }

    const queued = await getPendingAttendanceRecords(session.teacherId);
    // A refused record is never sent again; it stays only to be named.
    const records = queued.filter((record) => record.retryCount < MAX_RETRIES);
    if (records.length === 0) {
      // Rows may still be queued for somebody else on this device. They are
      // theirs to send, so the count shown is this teacher's own: nought,
      // with this teacher's refused ones named.
      const refused = queued.length;
      this.onStatusChange(refused > 0 ? 'error' : 'connected', 0, refusal(refused));
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
      const list = byLesson.get(record.lessonId) ?? [];
      list.push(record);
      byLesson.set(record.lessonId, list);
    }

    for (const [lessonId, rows] of byLesson) {
      for (const { batch, covered } of latestMarksInBatches(rows)) {
        const maxRetryInBatch = Math.max(...covered.map((record) => record.retryCount));
        const delay = backoffDelay(maxRetryInBatch);
        if (delay > 0) await sleep(delay);

        try {
          await pushLessonBatch(lessonId, batch, token);
          await Promise.all(covered.map((record) => markAttendanceRecordSynced(record.id)));
        } catch (err) {
          if (isPermanentFailure(err)) {
            await Promise.all(covered.map((record) => incrementRetryCount(record.id)));
          }
          failureCount += covered.length;
          // The status only: a message can carry the gateway's words about a
          // child, and this log is not the place for them.
          const status = err instanceof Error && 'status' in err ? String((err as { status: unknown }).status) : 'network';
          console.error(`[SyncWorker] Batch for lesson ${lessonId} failed (${status}).`);
        }
      }
    }

    this.isSyncing = false;
    const { pending, refused } = await getQueueCounts(session.teacherId, MAX_RETRIES);

    // A refusal is named first: it asks something of the teacher, and a
    // failure is sent again by itself.
    if (refused > 0) {
      this.onStatusChange('error', pending, refusal(refused));
    } else if (failureCount > 0 && pending > 0) {
      this.onStatusChange('error', pending, { code: 'RECORDS_FAILED', count: failureCount });
    } else {
      this.onStatusChange('connected', pending, null);
    }
  }
}

/**
 * A lesson's rows as the batches to send: the latest mark of each pupil, at
 * most MAX_BATCH_RECORDS a batch, each with the rows it settles (the pupil's
 * earlier marks too). Every submit queues the whole class again, so a lesson
 * marked twice offline would otherwise send each pupil twice, and a large
 * lesson past the gateway's limit, which refuses the whole batch.
 */
function latestMarksInBatches(
  rows: readonly PendingAttendanceRecord[],
): Array<{ batch: PendingAttendanceRecord[]; covered: PendingAttendanceRecord[] }> {
  const byPupil = new Map<string, PendingAttendanceRecord[]>();
  for (const row of rows) byPupil.set(row.studentId, [...(byPupil.get(row.studentId) ?? []), row]);
  const pupils = [...byPupil.values()];
  const parts: Array<{ batch: PendingAttendanceRecord[]; covered: PendingAttendanceRecord[] }> = [];
  for (let i = 0; i < pupils.length; i += MAX_BATCH_RECORDS) {
    const part = pupils.slice(i, i + MAX_BATCH_RECORDS);
    // The queue is read oldest first, so a pupil's latest mark is the last.
    parts.push({ batch: part.map((marks) => marks[marks.length - 1]!), covered: part.flat() });
  }
  return parts;
}

/** The banner's problem for this teacher's refused records, if any. */
function refusal(refused: number): SyncProblem | null {
  return refused > 0 ? { code: 'RECORDS_REFUSED', count: refused } : null;
}
