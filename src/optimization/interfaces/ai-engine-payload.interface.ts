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
export type RoomTypeKind =
  | 'CLASSROOM'
  | 'LABORATORY'
  | 'GYMNASIUM'
  | 'AUDITORIUM'
  | 'WORKSHOP'
  | 'OTHER';

export interface AnonymousRequirement {
  /** Opaque anonymous id for this requirement (NOT the real DB UUID). */
  id: string;
  subjectId: string;
  studentGroupId: string;
  teacherId: string | null;
  lessonsPerWeek: number;
  minutesPerLesson: number;
  /** Active-student headcount — an aggregate used for room-capacity checks. */
  studentGroupSize: number;
  /** When set, lessons for this requirement may only use rooms of this type. */
  requiredRoomType: RoomTypeKind | null;
  /** Optional second teacher scheduled together with the lead (co-teaching). */
  coTeacherId: string | null;
}

export interface AnonymousRoom {
  id: string;
  capacity: number | null;
  /** Room category (an enum, not PII) enabling type eligibility checks. */
  type: RoomTypeKind | null;
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

/**
 * A locked master lesson forwarded as an immovable placement. The solver
 * schedules the remaining demand around these: no generated lesson may
 * overlap a fixed lesson that shares its teacher, student group, or room.
 */
export interface AnonymousFixedLesson {
  id: string;
  teacherId: string | null;
  coTeacherId: string | null;
  studentGroupId: string;
  /** Additional classes attending (multi-class lessons block them all). */
  extraGroupIds?: string[];
  roomId: string | null;
  dayOfWeek: DayOfWeek;
  /** HH:MM:SS */
  startTime: string;
  /** HH:MM:SS */
  endTime: string;
}

/**
 * A slot the previous (unlocked) schedule used for a requirement. Enables
 * minimal-disruption re-optimization: the solver is rewarded for keeping
 * lessons on these slots.
 */
export interface AnonymousPreviousLesson {
  requirementId: string;
  dayOfWeek: DayOfWeek;
  /** HH:MM:SS */
  startTime: string;
}

/** Per-request objective weights; unset fields fall back to engine defaults. */
export interface ObjectiveWeights {
  preferredFree?: number;
  preferredBusy?: number;
  disruption?: number;
  spread?: number;
  teacherGap?: number;
}

/** Optional hard scheduling rules forwarded to the engine. */
export interface ScheduleRules {
  /** HH:MM:SS */
  lunchStartTime?: string;
  /** HH:MM:SS */
  lunchEndTime?: string;
  lunchMinutes?: number;
  maxLessonsPerDayPerGroup?: number;
}

export interface AiEngineScheduleRequest {
  /** Correlation id so the AI engine can include it in its response. */
  requestId: string;
  academicYearId: string;
  requirements: AnonymousRequirement[];
  rooms: AnonymousRoom[];
  constraints: AnonymousConstraint[];
  /** Locked master lessons the solver must plan around (never re-placed). */
  fixedLessons: AnonymousFixedLesson[];
  /** Previous unlocked placements, for minimal-disruption re-optimization. */
  previousLessons: AnonymousPreviousLesson[];
  weights?: ObjectiveWeights | null;
  rules?: ScheduleRules | null;
}

export type ConflictCategory =
  | 'REQUIREMENT_DEMAND'
  | 'TEACHER_OVERLAP'
  | 'ROOM_OVERLAP'
  | 'GROUP_OVERLAP'
  | 'ROOM_CAPACITY'
  | 'AVAILABILITY'
  | 'INSUFFICIENT_RESOURCES';

export interface AiEngineConflictDetail {
  category: ConflictCategory;
  /** Human-readable but PII-free — the engine only ever saw anonymous ids. */
  message: string;
  requirementIds: string[];
  roomIds: string[];
  constraintIds: string[];
  resourceIds: string[];
}

export interface AiEngineConflictAnalysis {
  summary: string;
  conflicts: AiEngineConflictDetail[];
}

export interface AiEngineScheduleResponse {
  requestId: string;
  status: 'FEASIBLE' | 'INFEASIBLE' | 'OPTIMAL';
  lessons: AiEngineLesson[];
  conflicts?: AiEngineConflictAnalysis | null;
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
