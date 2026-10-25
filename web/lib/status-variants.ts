/**
 * Which Badge variant each domain's states take — one map per domain, one
 * meaning per colour across the app:
 *
 *   success     done, ok, approved, covered, active, applied
 *   warning     needs action: open, draft, under, a decision pending, ongoing
 *   destructive failed, over, passed, rejected, blocked
 *   secondary   neutral information: handled, upcoming, kinds
 *   outline     inactive or finished: historic, revoked, withdrawn, ended
 *
 * A draft timplan is warning (it needs a decision), not secondary; a revoked
 * key or link is outline (a finished state), not destructive. The cover family
 * and the staffing StatusBadge are named in the manual, so their colours are
 * fixed here as they were.
 *
 * Plain data with type-only imports: no runtime cost beyond the maps a page reads.
 */

import type { AbsencePhase } from "@/lib/cover-types";
import type { StatusKey as CoverStatusKey } from "@/lib/cover-view";
import type { PassStatusKey } from "@/lib/pass-view";
import type { OptimizationJob } from "@/lib/queries";
import type { LoadStatus } from "@/lib/teacher-load";
import type { LocalTimplanStatus } from "@/lib/timplan-queries";
import type { AttendanceStatus, LeaveRequestStatus, RoomBookingStatus } from "@/lib/types";
import type { YearStatus } from "@/lib/year-rollover-form";

export type StatusVariant = "success" | "warning" | "destructive" | "secondary" | "outline";

/** A lokal timplan: an utkast needs a decision; a beslutad plan is done. */
export const PLAN_STATUS_VARIANT = {
  DRAFT: "warning",
  DECIDED: "success",
} as const satisfies Record<LocalTimplanStatus, StatusVariant>;

/** A teacher's load against the target (staffing StatusBadge; the manual names these colours). */
export const LOAD_STATUS_VARIANT = {
  OVER: "destructive",
  UNDER: "warning",
  OK: "success",
  NO_TARGET: "outline",
} as const satisfies Record<LoadStatus, StatusVariant>;

/** A cover-board lesson (the manual names these colours). */
export const COVER_STATUS_VARIANT = {
  OPEN: "warning",
  COVERED: "success",
  CANCELLED: "secondary",
  HANDLED_SUPERVISED_STUDY: "secondary",
  HANDLED_CO_TEACHER: "secondary",
  PASSED: "destructive",
} as const satisfies Record<CoverStatusKey, StatusVariant>;

/** An absent rastvakt's pass on the board (Rastvakt i vardagen), in the lessons' colours. */
export const PASS_STATUS_VARIANT = {
  OPEN: "warning",
  COVERED: "success",
  NO_COVER: "secondary",
  PASSED: "destructive",
} as const satisfies Record<PassStatusKey, StatusVariant>;

/** A registered teacher absence. */
export const ABSENCE_PHASE_VARIANT = {
  PLANNED: "secondary",
  ONGOING: "warning",
  ENDED: "outline",
  WITHDRAWN: "outline",
} as const satisfies Record<AbsencePhase, StatusVariant>;

/** An optimisation job's own state, before the solver has a verdict. */
export const JOB_STATUS_VARIANT = {
  PENDING: "secondary",
  RUNNING: "secondary",
  SUCCEEDED: "success",
  FAILED: "destructive",
} as const satisfies Record<OptimizationJob["status"], StatusVariant>;

/** The solver's verdict on a finished job: no timetable came back is a warning, not a crash. */
export const SOLVER_STATUS_VARIANT = {
  OPTIMAL: "success",
  FEASIBLE: "success",
  INFEASIBLE: "warning",
  TIMEOUT: "warning",
} as const satisfies Record<NonNullable<OptimizationJob["solverStatus"]>, StatusVariant>;

/**
 * One generate-history row: a failed job first, then the solver's verdict,
 * then the job's own state — the order /admin/generate reads them in.
 */
export function solverRunVariant(job: Pick<OptimizationJob, "status" | "solverStatus">): StatusVariant {
  if (job.status === "FAILED") return JOB_STATUS_VARIANT.FAILED;
  if (job.solverStatus) return SOLVER_STATUS_VARIANT[job.solverStatus];
  return JOB_STATUS_VARIANT[job.status];
}

/** An SS12000 sync run (integrations). */
export const SYNC_RUN_VARIANT = {
  RUNNING: "secondary",
  FETCH_FAILED: "destructive",
  NO_CHANGES: "outline",
  DIFF_READY: "warning",
  APPLIED: "success",
  APPLY_FAILED: "destructive",
  DISCARDED: "outline",
  SUPERSEDED: "outline",
  SKIPPED: "outline",
} as const satisfies Record<string, StatusVariant>;
export type SyncRunStatus = keyof typeof SYNC_RUN_VARIANT;

/** A Schemavisaren link: live, not shown (its target hidden or gone), or revoked. */
export const LINK_STATE_VARIANT = {
  ACTIVE: "success",
  NOT_SHOWN: "outline",
  REVOKED: "outline",
} as const satisfies Record<string, StatusVariant>;
export type LinkState = keyof typeof LINK_STATE_VARIANT;

/** An integration API key: revoked is finished, not failed. */
export const KEY_STATE_VARIANT = {
  ACTIVE: "success",
  REVOKED: "outline",
} as const satisfies Record<string, StatusVariant>;
export type KeyState = keyof typeof KEY_STATE_VARIANT;

/** A published timetable's validity window relative to today (publishing). */
export const VALIDITY_VARIANT = {
  past: "outline",
  current: "success",
  ahead: "secondary",
} as const satisfies Record<string, StatusVariant>;
export type ValidityWhen = keyof typeof VALIDITY_VARIANT;

/** A läsår. */
export const YEAR_STATUS_VARIANT = {
  ACTIVE: "success",
  UPCOMING: "secondary",
  FINISHED: "outline",
} as const satisfies Record<YearStatus, StatusVariant>;

/** A room booking: a pending one waits for the admin's decision. */
export const BOOKING_STATUS_VARIANT = {
  PENDING: "warning",
  APPROVED: "success",
  REJECTED: "destructive",
  CANCELLED: "outline",
} as const satisfies Record<RoomBookingStatus, StatusVariant>;

/** A leave request. */
export const LEAVE_STATUS_VARIANT = {
  PENDING: "warning",
  APPROVED: "success",
  REJECTED: "destructive",
} as const satisfies Record<LeaveRequestStatus, StatusVariant>;

/** An attendance mark. EXCUSED is information, not an alarm; UNKNOWN is not yet taken. */
export const ATTENDANCE_STATUS_VARIANT = {
  PRESENT: "success",
  LATE: "warning",
  ABSENT: "destructive",
  EXCUSED: "secondary",
  UNKNOWN: "outline",
} as const satisfies Record<AttendanceStatus, StatusVariant>;

/**
 * An attendance rate (0–1), for the reports' rate column: the thresholds the
 * attendance report already uses — 0.9 and over is fine, 0.75 to under 0.9
 * needs a look, under 0.75 is a problem — and no rate at all is outline.
 */
export function attendanceRateVariant(rate: number | null): StatusVariant {
  if (rate === null) return "outline";
  if (rate >= 0.9) return "success";
  if (rate >= 0.75) return "warning";
  return "destructive";
}
