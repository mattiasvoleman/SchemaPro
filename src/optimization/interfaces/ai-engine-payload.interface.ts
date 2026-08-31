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
/**
 * GRADE_LEVEL is the one target that is not a row in any table: there is no
 * "årskurs 5" to point at, so such a constraint carries a year range instead of
 * a resource id and the engine matches it against each group's own year span.
 * A school reserving a lunch sitting for åk 4-6 authors one rule rather than
 * one per class — and the rule then also catches a teaching group whose own
 * gradeLevel is null but whose members are year 5, which a group-targeted rule
 * never could.
 */
export type ResourceKind = 'TEACHER' | 'ROOM' | 'STUDENT_GROUP' | 'GRADE_LEVEL';
/**
 * An opaque room-type token. Room types are school-owned rows whose names the
 * school authors, so what crosses to the solver is an anonymised id: the
 * engine only needs to know that a room's type and a requirement's required
 * type are the SAME token, never what the school calls it.
 */
export type RoomTypeKind = string;

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
  /**
   * The years this group's students actually belong to, derived from their
   * home classes. Null when the group has no members with a year at all —
   * then no room limit can be checked against it.
   */
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
}

/**
 * A group the week concerns, and how many children it brings to lunch.
 *
 * Zero for a teaching group: its students eat with their home class, and
 * counting them again would fill the hall twice over with the same children.
 * Sent as its own list rather than as a field on each requirement, because a
 * class whose lessons are all placed by hand has no requirement left — and it
 * still eats.
 */
export interface AnonymousGroup {
  id: string;
  lunchHeadcount: number;
}

export interface AnonymousRoom {
  id: string;
  capacity: number | null;
  /** Room category (an enum, not PII) enabling type eligibility checks. */
  type: RoomTypeKind | null;
  /**
   * Inclusive year range the room may host; null means no limit at that end.
   * Keeps a stage's rooms to that stage.
   */
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
}

/** A soft wish that a subject's lessons land in particular rooms. */
export interface AnonymousRoomPreference {
  id: string;
  subjectId: string;
  /** Either a type… */
  roomType: string | null;
  /** …or named rooms. The gateway sends exactly one of the two. */
  roomIds: string[];
  /** Paid per lesson placed elsewhere, relative to the other objectives. */
  weight: number;
}

export interface AnonymousConstraint {
  id: string;
  resourceKind: ResourceKind;
  /**
   * Absent for GRADE_LEVEL, which names a year range instead. Optional rather
   * than a minted throwaway id: an id nothing can match is a rule that
   * validates, saves, lists and constrains nothing, with no error anywhere.
   */
  resourceId?: string;
  /** Inclusive year range for a GRADE_LEVEL rule; null at an open end. */
  minGradeLevel?: number | null;
  maxGradeLevel?: number | null;
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
 * A ramtid: the hours one stage of the school may be taught in.
 *
 * NOT anonymised, and there is nothing to anonymise — a frame names a span of
 * years, which is a property of the timetable and not of any person or room.
 * The same is already true of a GRADE_LEVEL constraint, and for the same
 * reason: there is no row to point at.
 *
 * The engine reads a frame as the DOMAIN of the lesson's start variable rather
 * than as forbidden intervals, so the hours a frame closes never become
 * variables at all. Sending the complement as UNAVAILABLE constraints would
 * give the same schedule and a bigger model.
 */
export interface AnonymousFrameTime {
  minGradeLevel: number;
  maxGradeLevel: number;
  /** ISO weekday 1-7, or null for every teaching day. */
  dayOfWeek: DayOfWeek | null;
  /** HH:MM:SS */
  startTime: string;
  /** HH:MM:SS */
  endTime: string;
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
  /**
   * Seats in the dining hall. Omitted when the school has no limit worth
   * modelling, and the engine then places lunch exactly as it did before.
   */
  diningSeats?: number;
  maxLessonsPerDayPerGroup?: number;
}

export interface AiEngineScheduleRequest {
  /** Correlation id so the AI engine can include it in its response. */
  requestId: string;
  academicYearId: string;
  requirements: AnonymousRequirement[];
  rooms: AnonymousRoom[];
  constraints: AnonymousConstraint[];
  /** Ramtider. Empty means every stage may use the whole configured day. */
  frameTimes: AnonymousFrameTime[];
  /** Locked master lessons the solver must plan around (never re-placed). */
  fixedLessons: AnonymousFixedLesson[];
  /** Every group the week concerns, with its dining-hall headcount. */
  groups: AnonymousGroup[];
  /** Previous unlocked placements, for minimal-disruption re-optimization. */
  previousLessons: AnonymousPreviousLesson[];
  /**
   * Pairs of (anonymous) group ids that share at least one student — the home
   * class vs. teaching-group relation (7A vs Ma71, or Ma71 vs Sv73). Lessons
   * for a conflicting pair must never overlap: every shared student would be
   * double-booked. Pairwise is exactly the right granularity for the hard
   * constraint, and it keeps STUDENT data out of the engine entirely.
   */
  groupConflicts: [string, string][];
  weights?: ObjectiveWeights | null;
  rules?: ScheduleRules | null;
  roomPreferences: AnonymousRoomPreference[];
}

export type ConflictCategory =
  | 'REQUIREMENT_DEMAND'
  | 'TEACHER_OVERLAP'
  | 'ROOM_OVERLAP'
  | 'GROUP_OVERLAP'
  | 'ROOM_CAPACITY'
  | 'AVAILABILITY'
  | 'DINING_CAPACITY'
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
  /**
   * INFEASIBLE means the engine *proved* no timetable exists (and only then is
   * `conflicts` populated). TIMEOUT means the solver ran out of time without
   * finding one — nothing was proven and the same request may succeed with a
   * longer engine budget. Both yield an empty `lessons` array.
   */
  status: 'FEASIBLE' | 'INFEASIBLE' | 'OPTIMAL' | 'TIMEOUT';
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
