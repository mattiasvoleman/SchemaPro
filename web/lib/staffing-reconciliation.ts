/**
 * GET /staffing/delivered's answer as the browser reads it (staffing Fas 3):
 * planerat, schemalagt och genomfört per lärare över ett datumintervall.
 *
 * A MIRROR of the types in src/staffing/staffing-reconciliation.ts and
 * StaffingReconciliationResponse in src/staffing/staffing-load.service.ts —
 * types only, plus the few sums the report tab prints. The gateway computes
 * every figure, in one RLS transaction over P3's one definition of held time;
 * nothing here recomputes one. Ids only come back: the page names people.
 */

import type { LoadModel } from "@/lib/teacher-load";

export type StaffingNoticeCode =
  | "STAFFING_NOTHING_PUBLISHED"
  | "STAFFING_RANGE_CLAMPED"
  | "STAFFING_RANGE_INCLUDES_FUTURE"
  | "STAFFING_RANGE_BEFORE_PUBLISHED"
  | "STAFFING_RANGE_AFTER_PUBLISHED"
  | "STAFFING_RANGE_HAS_GAPS"
  | "STAFFING_RANGE_PARTIAL_WEEKS"
  | "STAFFING_LEAD_BESIDE_SUBSTITUTE";

export const STAFFING_NOTICE_CODES: readonly StaffingNoticeCode[] = [
  "STAFFING_NOTHING_PUBLISHED",
  "STAFFING_RANGE_CLAMPED",
  "STAFFING_RANGE_INCLUDES_FUTURE",
  "STAFFING_RANGE_BEFORE_PUBLISHED",
  "STAFFING_RANGE_AFTER_PUBLISHED",
  "STAFFING_RANGE_HAS_GAPS",
  "STAFFING_RANGE_PARTIAL_WEEKS",
  "STAFFING_LEAD_BESIDE_SUBSTITUTE",
];

export interface StaffingNotice {
  code: StaffingNoticeCode;
  params: Record<string, string | number>;
}

/** The lost buckets, by cause. P3's names (timplanCoverage.delivered.cause.*). */
export const LOST_CAUSES = [
  "cancelledTeacherUnavailable",
  "cancelledRoomUnavailable",
  "cancelledManual",
  "cancelledUnknown",
  "otherStatus",
] as const;
export type LostCause = (typeof LOST_CAUSES)[number];
/**
 * `cancelledEvent` — a bulk avbokning's lessons (prao, friluftsdag) — is
 * OPTIONAL, as the gateway sends it: present only above 0, so a school that
 * never cancels in bulk reads the same rows as before Publicering.
 */
export type LostMinutes = Record<LostCause, number> & { cancelledEvent?: number };

export interface ReconciliationLine {
  subjectId: string;
  studentGroupId: string;
  /** The extra groups the line's lessons were also for (samläsning). */
  extraGroupIds: string[];
  planned: number;
  scheduled: number;
  delivered: number;
  substituteMinutes: number;
  lostMinutes: number;
}

export interface TeacherReconciliation {
  userId: string;
  planned: number;
  scheduled: number;
  delivered: number;
  substituteMinutes: number;
  coveredByOthersMinutes: number;
  aheadMinutes: number;
  lost: LostMinutes;
  lostMinutes: number;
  deliveredLessons: number;
  /** Admin only; null for a teacher's own read. */
  displacedLessons: number | null;
  lines: ReconciliationLine[];
}

export interface GroupLoss extends LostMinutes {
  studentGroupId: string;
  subjectId: string;
  teacherless: number;
  lessons: number;
}

export interface StaffingReconciliationResponse {
  academicYearId: string;
  year: { startDate: string; endDate: string };
  asOf: string;
  asOfDate: string;
  from: string;
  to: string;
  /** The window planned and scheduled are measured over; null when it is empty. */
  comparison: { from: string; to: string } | null;
  loadModel: LoadModel;
  published: { from: string; through: string } | null;
  teachers: TeacherReconciliation[];
  groupLosses: GroupLoss[];
  totals: {
    planned: number;
    scheduled: number;
    delivered: number;
    substituteMinutes: number;
    coveredByOthersMinutes: number;
    lostMinutes: number;
    aheadMinutes: number;
  } | null;
  notices: StaffingNotice[];
}

/**
 * Minutes as hours with one decimal in the reader's decimal mark: 1 290 →
 * "21,5" in Swedish, "21.5" in English. No grouping, an ASCII minus.
 */
export function hoursText(minutes: number, locale = "sv"): string {
  const hours = Math.round((minutes / 60) * 10) / 10;
  if (Number.isInteger(hours)) return String(hours);
  return new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false })
    .format(Math.abs(hours))
    .replace(/^/, hours < 0 ? "-" : "");
}

/** The sum of a group loss's minutes, every cause and the teacherless. */
export function groupLossMinutes(loss: GroupLoss): number {
  return LOST_CAUSES.reduce((sum, cause) => sum + loss[cause], loss.teacherless + (loss.cancelledEvent ?? 0));
}
