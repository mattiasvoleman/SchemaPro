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

// ─── Krisläge ─────────────────────────────────────────────────────────────────

/** What a teacher can say of a pupil on their list. (Not in the building is the administration's to say.) */
export type CrisisMarkState = 'FOUND' | 'MISSING';

/**
 * What a queued mark says: found or missing, or RETRACTED, the taking back of the
 * teacher's own "found with me" (the pupil is unmarked again on the gateway).
 */
export type QueuedMarkState = CrisisMarkState | 'RETRACTED';

/** A pupil picked in the search for "found with me", for the pending row alone: the queue is not a list of pupils. */
export interface PendingCrisisPupil {
  readonly firstName: string;
  readonly lastName: string;
  readonly className: string | null;
}

/**
 * A mark in the local Krisläge queue that has not yet been sent. It names its
 * group by the call (a list the gateway gave the phone), by the lesson (a
 * list the phone built from its own cache) or, for a teacher with no group right
 * now who found a pupil, by the alarm: exactly one of the three, as the gateway
 * refuses a mark that names more or none.
 */
export interface PendingCrisisMark {
  /** The phone's own id: sending it twice stores it once. */
  readonly id: string;
  readonly callId: string | null;
  readonly lessonId: string | null;
  /** The alarm itself, for "found with me" with no group. Absent reads as null. */
  readonly alarmId?: string | null;
  readonly studentId: string;
  readonly state: QueuedMarkState;
  /** When the teacher tapped, by the phone's clock. */
  readonly at: string; // ISO 8601
  readonly teacherId: string;
  readonly retryCount: number;
  /**
   * The pupil's name and class, kept only while the mark is unsent so that the pending row can name
   * them (the lists the phone holds do not): the queue drops them when the gateway has the mark.
   */
  readonly pupil?: PendingCrisisPupil | null;
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

/** What the gateway says over the socket when an alarm starts or ends (it carries no names). */
export interface CrisisUpdatedPayload {
  readonly alarmId: string;
  readonly changedAt: string; // ISO 8601
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

/** GUARDIAN_DECLINED (Ledighetspolicy): a guardian did not consent, and the request ended there. */
export type LeaveRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'GUARDIAN_DECLINED';

/**
 * The school's three choices about leave (Ledighetspolicy, GET /leave-policy).
 * All off as a school leaves them: `{ false, null, 'REFUSE', 'OFF' }`.
 * `shortNotice` means something only when `minDaysAhead` is set.
 */
export type LeaveShortNotice = 'REFUSE' | 'FLAG';
export type LeaveContactMode = 'OFF' | 'OPTIONAL' | 'REQUIRED';

export interface LeavePolicy {
  /** Every guardian with active custody consents before the request is decided. */
  readonly requireAllGuardians: boolean;
  /** Calendar days before the first day, 1..90; null: no minimum. */
  readonly minDaysAhead: number | null;
  /** What a request that comes later meets: a refusal, or a flag for whoever decides. */
  readonly shortNotice: LeaveShortNotice;
  /** The temporary contact during the leave: not asked for, asked for, or required. */
  readonly contact: LeaveContactMode;
}

/** A third party's details, written by the family: shown to the family that wrote them, never in a notice. */
export interface LeaveContact {
  readonly name: string;
  readonly phone: string;
  readonly relation: string;
}

/** The request's consent as a whole; WAITING means someone who can answer has not. */
export type LeaveConsentState = 'NOT_REQUIRED' | 'WAITING' | 'GIVEN' | 'REFUSED';
/** The signed-in guardian's own part; NOT_ASKED for everyone else and for whoever applied. */
export type LeaveConsentMine = 'NOT_ASKED' | 'WAITING' | 'GIVEN' | 'REFUSED' | 'ENDED';

export interface LeaveConsent {
  /** The school asked for consent when the request was written. */
  readonly required: boolean;
  readonly state: LeaveConsentState;
  readonly mine: LeaveConsentMine;
  // asked / given / waiting are the staff's counts; a family gets null and the app draws none.
}

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
  // The three below come from Ledighetspolicy. A gateway from before it sends none, and a row without
  // them is drawn as it always was: the app shows only what the answer says.
  /** The request came closer to the first day than the school's minimum, and was flagged instead of refused. */
  readonly shortNotice?: boolean;
  /** The temporary contact the family gave; null when none was. */
  readonly contact?: LeaveContact | null;
  readonly consent?: LeaveConsent;
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
  | 'LEAVE_REQUESTED'
  | 'SUPERVISION_COVER'
  | 'SUPERVISION_COVER_WITHDRAWN'
  | 'COVER_REQUESTED'
  | 'COVER_REQUEST_ACCEPTED'
  | 'COVER_REQUEST_CLOSED'
  | 'ABSENCE_WATCH_DIGEST'
  | 'CRISIS_ALARM'
  | 'CRISIS_ENDED'
  | 'CRISIS_GUARDIAN_AFTER'
  | 'LESSON_REPORT_REMINDER'
  | 'REPORTING_RATE_DIGEST'
  | 'ACK_REQUESTED'
  | 'ACK_REMINDER'
  | 'LESSON_PUPIL_MOVED'
  | 'LEAVE_CONSENT_REQUESTED'
  | 'LEAVE_CONSENT_REMINDER'
  | 'LEAVE_CONSENT_REFUSED';

export interface NotificationRow {
  readonly id: string;
  readonly type: NotificationType;
  readonly meta: Record<string, unknown> | null;
  readonly readAt: string | null;
  readonly createdAt: string;
}
