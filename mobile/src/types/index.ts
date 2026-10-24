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
  /** What went wrong, as a code the banner words (services/sync SyncProblem). */
  readonly problem: SyncProblem | null;
}

export type SyncProblem =
  | { readonly code: 'SESSION_EXPIRED' }
  | { readonly code: 'RECORDS_FAILED'; readonly count: number }
  /** Marks the server refused for good: never sent again, named apart for the teacher to check and discard. */
  | { readonly code: 'RECORDS_REFUSED'; readonly count: number };

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
  /** False for a pupil who has left: still linked, but no week to show. */
  readonly isActive: boolean;
  /**
   * The day the child's school is on, as the gateway said (YYYY-MM-DD): what
   * "today" is for a report or a leave about this child. Absent from a
   * gateway older than the field; schoolDate falls back to the phone's day.
   */
  readonly schoolToday?: string;
}

export type AbsenceReportType = 'SICK' | 'APPOINTMENT' | 'OTHER';

export interface AbsenceReportRow {
  readonly id: string;
  readonly studentId: string;
  /** Who reported it: only the reporter may take it back (the gateway's 403 otherwise). */
  readonly reportedById: string;
  readonly date: string;
  readonly startTime: string | null;
  readonly endTime: string | null;
  readonly type: AbsenceReportType;
  readonly note: string | null;
  /**
   * Whether the gateway would take it back now: the withdrawal's own rule,
   * its reporter only and from the school's today on. Absent from a gateway
   * older than the field (mayWithdraw).
   */
  readonly removable?: boolean;
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
  /** MENTOR or ADMIN once decided (Mentorns ledighetsbeslut); null before, and for older decisions. */
  readonly decidedAs: 'MENTOR' | 'ADMIN' | null;
  readonly createdAt: string;
}

export type NotificationType =
  | 'ABSENCE_UNREPORTED'
  | 'LEAVE_DECIDED'
  | 'LESSON_CANCELLED'
  | 'LESSON_SUBSTITUTE'
  | 'LESSON_ROOM_CHANGED'
  | 'SCHEDULE_CHANGED'
  | 'ROOM_BOOKING_DECIDED'
  | 'TEACHER_ABSENCE_REPORTED'
  | 'LESSON_COVER_WITHDRAWN'
  | 'LESSON_REINSTATED'
  | 'LESSON_SUPERVISED_STUDY'
  | 'CANCELLATION_DIGEST'
  | 'LEAVE_REQUESTED';

export interface NotificationRow {
  readonly id: string;
  readonly type: NotificationType;
  readonly meta: Record<string, unknown> | null;
  readonly readAt: string | null;
  readonly createdAt: string;
}
