/**
 * Anonymous scheduling payload sent to the Python FastAPI / OR-Tools engine.
 *
 * CRITICAL PRIVACY INVARIANT: every field in this file is a UUID or a
 * numeric/enum value. NO PII (names, emails, phone numbers, text labels)
 * must ever appear in any of these types. The `OptimizationProxyService`
 * enforces this by constructing new anonymous objects from scratch rather
 * than forwarding Prisma records.
 */

export type DayOfWeek = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type ConstraintKind = 'UNAVAILABLE' | 'PREFERRED_FREE' | 'PREFERRED_BUSY';
export type ResourceKind = 'TEACHER' | 'ROOM' | 'STUDENT_GROUP';

export interface AnonymousRequirement {
  /** Opaque anonymous id for this requirement (NOT the real DB UUID). */
  id: string;
  subjectId: string;
  studentGroupId: string;
  teacherId: string | null;
  lessonsPerWeek: number;
  minutesPerLesson: number;
}

export interface AnonymousRoom {
  id: string;
  capacity: number | null;
}

export interface AnonymousConstraint {
  id: string;
  resourceKind: ResourceKind;
  resourceId: string;
  dayOfWeek: DayOfWeek | null;
  /** ISO date string (YYYY-MM-DD) or null for recurring weekly constraints. */
  date: string | null;
  /** HH:MM:SS */
  startTime: string;
  /** HH:MM:SS */
  endTime: string;
  kind: ConstraintKind;
}

export interface AiEngineScheduleRequest {
  /** Correlation id so the AI engine can include it in its response. */
  requestId: string;
  academicYearId: string;
  requirements: AnonymousRequirement[];
  rooms: AnonymousRoom[];
  constraints: AnonymousConstraint[];
}

export interface AiEngineScheduleResponse {
  requestId: string;
  status: 'FEASIBLE' | 'INFEASIBLE' | 'OPTIMAL';
  lessons: AiEngineLesson[];
}

export interface AiEngineLesson {
  requirementId: string;
  roomId: string | null;
  dayOfWeek: DayOfWeek;
  /** HH:MM:SS */
  startTime: string;
  /** HH:MM:SS */
  endTime: string;
}
