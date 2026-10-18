// The two small questions a timplan page asks of the load model without
// needing the model itself: how much of a standardvecka a requirement (or a
// dated uppdrag) is worth, and whether a behörighet covers a requirement.
// They live apart from teacher-load.ts because Turbopack keeps a shared module
// whole: /admin/requirements reached teacher-load for these two functions alone
// and carried the whole load report with them. teacher-load.ts imports and
// re-exports both, so its arithmetic is unchanged.

import { teachingWeeks, type ClosedRange, type TeachingPeriod, type YearBounds } from "@/lib/teaching-hours";
import type { GradeSpan, LoadQualification, LoadRequirement } from "@/lib/teacher-load";
import { toNioarig, type GradeNumbering } from "@/lib/grade-numbering";

/**
 * How much of a standardvecka one requirement is worth, 0..1: undated rows 1
 * (every week) or 0.5 (varannan vecka); a dated row its share of the year's
 * teaching weeks, lov subtracted from both sides. The grade reaches the lov
 * arithmetic only for a single-grade group — see the gateway's header.
 */
export function standardWeekWeight(
  requirement: TeachingPeriod & { gradeSpan?: GradeSpan | null },
  year: YearBounds,
  closures: ClosedRange[],
): number {
  if (!requirement.startDate && !requirement.endDate) {
    return (requirement.recurrence ?? "ALL_WEEKS") === "ALL_WEEKS" ? 1 : 0.5;
  }
  const gradeLevel = singleGrade(requirement.gradeSpan ?? null);
  const yearWeeks = teachingWeeks({}, year, closures, gradeLevel);
  if (yearWeeks === 0) return 0;
  return teachingWeeks(requirement, year, closures, gradeLevel) / yearWeeks;
}

export function singleGrade(span: GradeSpan | null): number | null {
  return span !== null && span.min === span.max ? span.min : null;
}

/** Whether a qualification is valid at some point of the year. */
export function qualificationValidInYear(
  qualification: Pick<LoadQualification, "validFrom" | "validTo">,
  year: YearBounds,
): boolean {
  if (qualification.validFrom && qualification.validFrom > year.endDate) return false;
  if (qualification.validTo && qualification.validTo < year.startDate) return false;
  return true;
}

/**
 * Whether one qualification covers a requirement: same subject, the whole
 * grade span inside the qualification's, and valid at some point of the year.
 * A requirement whose group has no derivable grade is covered by any
 * qualification in the subject — the span cannot be judged, and refusing it
 * would flag every memberless teaching group. A behörighet is stated in
 * NIOARIG, so a tioårig year's span is read so first (the gateway's rule).
 */
export function qualificationCovers(
  qualification: LoadQualification,
  requirement: Pick<LoadRequirement, "subjectId" | "gradeSpan">,
  year: YearBounds & { gradeNumbering?: GradeNumbering },
): boolean {
  if (qualification.subjectId !== requirement.subjectId) return false;
  if (!qualificationValidInYear(qualification, year)) return false;
  const span = requirement.gradeSpan;
  if (span === null) return true;
  // toNioarig, not lib/nioarig-span: the requirements route bundles this
  // module already (timplan-planned) and sits at its budget.
  const numbering = year.gradeNumbering ?? "NIOARIG";
  return (
    qualification.minGradeLevel <= toNioarig(span.min, numbering)! &&
    qualification.maxGradeLevel >= toNioarig(span.max, numbering)!
  );
}
