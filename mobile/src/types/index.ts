// ─────────────────────────────────────────────────────────────────────────────
// Domain Types
// All IDs are UUIDv4. No PII flows to the AI engine — anonymizedId is used
// there instead. displayName stays on-device only.
// ─────────────────────────────────────────────────────────────────────────────

export type AttendanceStatus = 'present' | 'absent' | 'late' | 'excused';

export type SyncStatus = 'connected' | 'offline' | 'syncing' | 'error';

// ─── Roster ──────────────────────────────────────────────────────────────────

export interface Student {
  readonly id: string;
  readonly displayName: string;
  readonly photoUri: string | null;
}

// ─── Lesson ──────────────────────────────────────────────────────────────────

export interface CalendarLesson {
  readonly id: string;
  readonly startTime: string; // ISO 8601
  readonly endTime: string; // ISO 8601
  readonly subjectName: string;
  readonly roomName: string;
  readonly studentIds: readonly string[];
}

// ─── Attendance ───────────────────────────────────────────────────────────────

export interface AttendanceRecord {
  readonly id: string;
  readonly lessonId: string;
  readonly studentId: string;
  readonly status: AttendanceStatus;
  readonly timestamp: string; // ISO 8601
  readonly submittedByTeacherId: string;
  readonly isSynced: boolean;
}

/** A record in the local SQLite queue that has not yet been pushed to the API. */
export interface PendingAttendanceRecord {
  readonly id: string;
  readonly lessonId: string;
  readonly studentId: string;
  readonly status: AttendanceStatus;
  readonly timestamp: string; // ISO 8601
  readonly submittedByTeacherId: string;
  /** Number of failed push attempts. Used to drive exponential backoff. */
  retryCount: number;
}

// ─── Auth ────────────────────────────────────────────────────────────────────

export interface AuthState {
  readonly isAuthenticated: boolean;
  readonly teacherId: string | null;
  readonly role: string | null;
}

// ─── Sync ─────────────────────────────────────────────────────────────────────

export interface SyncState {
  readonly status: SyncStatus;
  readonly lastSyncedAt: string | null; // ISO 8601
  readonly pendingCount: number;
  readonly errorMessage: string | null;
}

// ─── Network ──────────────────────────────────────────────────────────────────

export interface NetworkState {
  readonly isConnected: boolean;
  readonly isInternetReachable: boolean;
}

// ─── WebSocket Payloads ───────────────────────────────────────────────────────

export interface CalendarLessonUpdatedPayload {
  readonly lessonId: string;
  readonly updatedLesson: CalendarLesson;
}
