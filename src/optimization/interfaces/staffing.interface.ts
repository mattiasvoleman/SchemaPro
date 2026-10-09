/**
 * The staffing proposal's wire contract with the engine: POST /api/v1/staff.
 *
 * The mirror of optimization-engine/app/schemas/staffing.py, field for field.
 * Its pydantic models forbid extra fields, so a field one side has and the
 * other lacks is a 422 for the whole proposal: the names are pinned on both
 * sides by hand (staffing-engine-contract.spec.ts here, test_staffing.py
 * there), and a change to either list deploys with the engine, engine first.
 *
 * WHAT CROSSES: fresh v4 uuids minted per request (teachers, requirements,
 * groups, subjects, eligibility sets), integer tenths of a minute, lesson
 * minutes, grade numbers, booleans and weights. Never a name, an email, a
 * signature, an employment percentage, a qualification's kind or its dates.
 */

/** Never INFEASIBLE: keeping every row as it is always satisfies every rule. */
export type StaffSolveStatus = 'OPTIMAL' | 'FEASIBLE';

export type StaffUnstaffedReason =
  | 'NO_QUALIFIED_TEACHER'
  | 'NO_TEACHER_WITH_TARGET'
  | 'NO_CAPACITY_LEFT'
  | 'NOT_REACHED';

export const STAFF_UNSTAFFED_REASONS: readonly StaffUnstaffedReason[] = [
  'NO_QUALIFIED_TEACHER',
  'NO_TEACHER_WITH_TARGET',
  'NO_CAPACITY_LEFT',
  'NOT_REACHED',
];

/** The secondary objective's weights, 0..100 each; an absent one is the engine's default. */
export interface StaffWeights {
  balance?: number;
  classTeachers?: number;
  continuity?: number;
  keepCurrent?: number;
  unqualified?: number;
}

/** One deduplicated list of who may take a row. */
export interface StaffEligibilitySet {
  id: string;
  teacherIds: string[];
}

export interface AnonymousStaffTeacher {
  id: string;
  /** 10 × the weekly target; null with no target (no post, or no riktmärke). */
  targetTenths: number | null;
  /** 10·floor(target·(1 + tol/100)) + 4: a load at or under it is never OVER. */
  limitTenths: number | null;
  /** max(0, 10·ceil(target·(1 − tol/100)) − 5): a load at or over it is never UNDER. */
  floorTenths: number | null;
  /** Everything the proposal may not move: fixed rows, co-teaching, counted uppdrag. */
  fixedTenths: number;
}

export interface AnonymousStaffRequirement {
  id: string;
  subjectId: string;
  studentGroupId: string;
  chargeTenths: number;
  lessonMinutes: number;
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
  fixed: boolean;
  currentTeacherId: string | null;
  coTeacherId: string | null;
  eligibilitySetId: string | null;
  lastYearTeacherIds: string[];
}

export interface StaffRequest {
  requestId: string;
  respectQualifications: boolean;
  qualificationsRecorded: boolean;
  weights: StaffWeights;
  teachers: AnonymousStaffTeacher[];
  requirements: AnonymousStaffRequirement[];
  eligibilitySets: StaffEligibilitySet[];
}

export interface StaffAssignment {
  requirementId: string;
  teacherId: string;
}

export interface StaffUnstaffed {
  requirementId: string;
  reason: StaffUnstaffedReason;
}

export interface StaffConflict {
  code: string;
  params: Record<string, string | number>;
  message: string;
  requirementIds: string[];
  teacherIds: string[];
  subjectIds: string[];
}

export interface StaffTerms {
  unstaffedRows: number;
  unstaffedMinutes: number;
  deviationTenths: number;
  underBandTenths: number;
  newClassTeachers: number;
  continuityChanges: number;
  currentChanges: number;
  unqualifiedAssignments: number;
}

export interface StaffResponse {
  requestId: string;
  status: StaffSolveStatus;
  unstaffedProven: boolean;
  /** Every free row that ends staffed, kept rows keeping their lead included. */
  assignments: StaffAssignment[];
  /** Open rows only. */
  unstaffed: StaffUnstaffed[];
  conflicts: StaffConflict[];
  terms: { before: StaffTerms; after: StaffTerms };
}
