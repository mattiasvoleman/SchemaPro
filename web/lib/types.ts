// Domain types mirrored from the Prisma schema (subset used by the web UI).

export type UserRole = "STUDENT" | "TEACHER" | "SCHOOL_ADMIN" | "GUARDIAN";
export type AbsenceReportType = "SICK" | "APPOINTMENT" | "OTHER";
export type LeaveRequestStatus = "PENDING" | "APPROVED" | "REJECTED";
export type RoomType =
  | "CLASSROOM"
  | "LABORATORY"
  | "GYMNASIUM"
  | "AUDITORIUM"
  | "WORKSHOP"
  | "OTHER";
export type LessonStatus = "SCHEDULED" | "CANCELLED" | "COMPLETED" | "RESCHEDULED";
export type AttendanceStatus = "UNKNOWN" | "PRESENT" | "ABSENT" | "LATE" | "EXCUSED";
export type ConstraintResource = "TEACHER" | "ROOM" | "STUDENT_GROUP";
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
  requiredRoomType: RoomType | null;
}

export interface Room {
  id: string;
  name: string;
  code: string | null;
  capacity: number | null;
  type: RoomType;
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

export interface StudentGroup {
  id: string;
  academicYearId: string;
  name: string;
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
}

export interface AvailabilityConstraint {
  id: string;
  resourceType: ConstraintResource;
  userId: string | null;
  roomId: string | null;
  studentGroupId: string | null;
  dayOfWeek: number | null;
  date: string | null;
  startTime: string;
  endTime: string;
  type: ConstraintType;
  reason: string | null;
}

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
