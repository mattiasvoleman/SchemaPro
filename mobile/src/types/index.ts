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

// ─── Guardian / student experience ──────────────────────────────────────────

export type UserRole = 'STUDENT' | 'TEACHER' | 'SCHOOL_ADMIN' | 'GUARDIAN';

export interface ChildRow {
  readonly linkId: string;
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string;
}

export type AbsenceReportType = 'SICK' | 'APPOINTMENT' | 'OTHER';

export interface AbsenceReportRow {
  readonly id: string;
  readonly studentId: string;
  readonly date: string;
  readonly startTime: string | null;
  readonly endTime: string | null;
  readonly type: AbsenceReportType;
  readonly note: string | null;
}

export type LeaveRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface LeaveRequestRow {
  readonly id: string;
  readonly studentId: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly reason: string;
  readonly status: LeaveRequestStatus;
  readonly decisionNote: string | null;
  readonly createdAt: string;
}

export interface NotificationRow {
  readonly id: string;
  readonly type:
    | 'ABSENCE_UNREPORTED'
    | 'LEAVE_DECIDED'
    | 'LESSON_CANCELLED'
    | 'LESSON_SUBSTITUTE'
    | 'SCHEDULE_CHANGED';
  readonly meta: Record<string, unknown> | null;
  readonly readAt: string | null;
  readonly createdAt: string;
}
