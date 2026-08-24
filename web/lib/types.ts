// Domain types mirrored from the Prisma schema (subset used by the web UI).

export type UserRole = "STUDENT" | "TEACHER" | "SCHOOL_ADMIN" | "GUARDIAN";
export type AbsenceReportType = "SICK" | "APPOINTMENT" | "OTHER";
export type LeaveRequestStatus = "PENDING" | "APPROVED" | "REJECTED";
/** A room type the school owns and names itself. */
export interface RoomType {
  id: string;
  name: string;
  /** Present only for the six values that predate school-owned types. */
  legacyKey?: string | null;
  _count?: { rooms: number; subjects: number };
}
export type LessonStatus = "SCHEDULED" | "CANCELLED" | "COMPLETED" | "RESCHEDULED";
export type AttendanceStatus = "UNKNOWN" | "PRESENT" | "ABSENT" | "LATE" | "EXCUSED";
/**
 * GRADE_LEVEL is the one target that is not a row anywhere: there is no
 * "årskurs 5" to point at, so such a rule carries a year range instead of an
 * id. One rule covers a whole stage, and it also reaches a teaching group whose
 * own year is unset but whose members are in that stage — which a rule aimed at
 * a single group never could.
 */
export type ConstraintResource =
  | "TEACHER"
  | "ROOM"
  | "STUDENT_GROUP"
  | "GRADE_LEVEL";
export type ConstraintType = "UNAVAILABLE" | "PREFERRED_FREE" | "PREFERRED_BUSY";

export interface Profile {
  id: string;
  authId: string;
  schoolId: string;
  role: UserRole;
  firstName: string;
  lastName: string;
  email: string;
  studentGroupId: string | null;
}

export interface School {
  id: string;
  name: string;
  slug: string;
  timezone: string;
}

export interface Subject {
  id: string;
  name: string;
  code: string | null;
  color: string | null;
  /** When set, the optimizer only places this subject in rooms of this type. */
  requiredRoomTypeId: string | null;
}

export interface Room {
  id: string;
  name: string;
  code: string | null;
  capacity: number | null;
  roomTypeId: string | null;
  /** Inclusive year range the room may host; null at either end means no limit. */
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
  requiresApproval: boolean;
}

export type RoomBookingStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";

export interface RoomBooking {
  id: string;
  roomId: string;
  bookedById: string;
  title: string;
  startsAt: string;
  endsAt: string;
  status: RoomBookingStatus;
  decidedById: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
}

export interface AcademicYear {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  isActive: boolean;
}

/** A home class (7A) or a teaching group cutting across classes (Ma71). */
export type StudentGroupKind = "CLASS" | "TEACHING_GROUP";

export interface StudentGroup {
  id: string;
  academicYearId: string;
  name: string;
  kind: StudentGroupKind;
  gradeLevel: number | null;
}

export interface Person {
  id: string;
  role: UserRole;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  isActive: boolean;
  /**
   * When the invitation email was last sent, or null for somebody who has
   * been added to the roster but never contacted. They cannot sign in until
   * an admin invites them.
   */
  invitedAt: string | null;
  studentGroupId: string | null;
}

export interface TeachingRequirement {
  id: string;
  academicYearId: string;
  subjectId: string;
  studentGroupId: string;
  teacherId: string | null;
  /** Optional second teacher scheduled together with the lead (co-teaching). */
  coTeacherId: string | null;
  lessonsPerWeek: number;
  minutesPerLesson: number;
  /**
   * Which weeks the subject is read over — said once on the requirement and
   * inherited by every lesson generated from it, rather than corrected lesson
   * by lesson in the master timetable afterwards.
   */
  recurrence: LessonRecurrence;
  /**
   * YYYY-MM-DD, or null for the academic year's own boundary.
   *
   * Date-only from BOTH doors now. Supabase always rendered the DATE column
   * this way; the POST/PATCH response from NestJS used to send the same field
   * as "2027-01-11T00:00:00.000Z", so the shape of a requirement depended on
   * whether you had just saved it or just reloaded. The instant is cut at its
   * source (src/resources/teaching-requirements.service.ts, toResponse) rather
   * than here — see that comment for why the server and not the client.
   *
   * Consumers may therefore compare these as strings, which lib/teaching-hours.ts
   * and lib/ics.ts both do, and hand them straight to an `<input type="date">`.
   */
  startDate: string | null;
  endDate: string | null;
}

export interface AvailabilityConstraint {
  id: string;
  resourceType: ConstraintResource;
  userId: string | null;
  roomId: string | null;
  studentGroupId: string | null;
  /** Inclusive year range for a GRADE_LEVEL rule; null at an open end. */
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
  dayOfWeek: number | null;
  date: string | null;
  startTime: string;
  endTime: string;
  type: ConstraintType;
  reason: string | null;
}

/**
 * The school's lunch rules and the size of its dining hall — one row, so the
 * hooks read and write it as a single value rather than a collection.
 *
 * These used to live in one administrator's browser under
 * `schemapro.scheduleRules`, which meant a colleague pressing "generera" ran
 * under different rules and nothing anywhere said so.
 */
export interface LunchSettings {
  id: string;
  lunchEnabled: boolean;
  /** HH:MM:SS as PostgreSQL returns a `time` column. */
  lunchStartTime: string;
  lunchEndTime: string;
  lunchMinutes: number;
  /** Null means the school has no seat limit worth modelling. */
  diningSeats: number | null;
  maxLessonsPerDayPerGroup: number | null;
}

export type LessonRecurrence = "ALL_WEEKS" | "ODD_WEEKS" | "EVEN_WEEKS";

export interface MasterLesson {
  id: string;
  academicYearId: string;
  subjectId: string;
  studentGroupId: string;
  teacherId: string | null;
  /** Optional second teacher (co-teaching); published as ASSISTANT. */
  coTeacherId: string | null;
  roomId: string | null;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  /** Locked lessons survive regeneration and are pinned on the grid. */
  isLocked: boolean;
  /** Which weeks the lesson runs; ISO week parity, not a count from the start. */
  recurrence: LessonRecurrence;
  /** YYYY-MM-DD, or null for the academic year's own boundary. */
  startDate: string | null;
  endDate: string | null;
  /** Additional classes attending (beyond the primary group). */
  extraGroupIds: string[];
  /** Individual participating students (electives across classes). */
  studentIds: string[];
}

export interface CalendarLessonRow {
  id: string;
  subjectId: string;
  studentGroupId: string;
  roomId: string | null;
  date: string;
  startsAt: string;
  endsAt: string;
  status: LessonStatus;
  note: string | null;
}

export interface AttendanceRecordRow {
  id: string;
  calendarLessonId: string;
  studentId: string;
  status: AttendanceStatus;
  recordedAt: string | null;
  note: string | null;
}

export interface GuardianLink {
  id: string;
  guardianId: string;
  studentId: string;
}

export interface AbsenceReport {
  id: string;
  studentId: string;
  reportedById: string;
  date: string;
  startTime: string | null;
  endTime: string | null;
  type: AbsenceReportType;
  note: string | null;
  createdAt: string;
}

export interface LeaveRequest {
  id: string;
  studentId: string;
  requestedById: string;
  startDate: string;
  endDate: string;
  reason: string;
  status: LeaveRequestStatus;
  decidedById: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
}
