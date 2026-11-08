import { toNioarig, type GradeNumbering } from '../common/grade-numbering';
import type { SchoolPartView } from './analysis.types';

/*
 * Skoldelar: which part of the school an årskurs belongs to.
 *
 * A skoldel's span is stated in the nine-year numbering for good (like a
 * skolenhet's, SchoolUnits.gradeFrom/gradeTo), so a class of a tioårig läsår is
 * read through toNioarig before it is looked up: åk 8 of a ten-year läsår is
 * åk 7 of the nine-year numbering and falls where 7 falls. Two skoldelar of a
 * school never share an årskurs (SchoolParts_no_shared_grade, the database's
 * exclusion); overlapOf is the same comparison made first, so that the refusal
 * can name the other skoldel.
 *
 * PURE.
 */

export const SCHOOL_PART_NAME_MAX = 100;
export const SCHOOL_PART_ACCOUNT_MAX = 30;

/** C0 and C1 controls and DEL: the database refuses [[:cntrl:]], the C0 ones at least. */
export const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

export type SpanLike = Pick<SchoolPartView, 'gradeFrom' | 'gradeTo'>;

/** Do two spans share an årskurs? */
export function spansShareGrade(a: SpanLike, b: SpanLike): boolean {
  return a.gradeFrom <= b.gradeTo && b.gradeFrom <= a.gradeTo;
}

/** The skoldel already holding an årskurs of `span`, other than `exceptId`; null when none does. */
export function overlapOf(
  parts: readonly SchoolPartView[],
  span: SpanLike,
  exceptId?: string,
): SchoolPartView | null {
  return parts.find((part) => part.id !== exceptId && spansShareGrade(part, span)) ?? null;
}

/**
 * The skoldel a class of `gradeLevel` (in the läsår's numbering) falls in, or
 * null when no skoldel holds it or the class has no årskurs. The lookup is
 * made in the nine-year numbering.
 */
export function partOfGrade(
  parts: readonly SchoolPartView[],
  gradeLevel: number | null,
  numbering: GradeNumbering,
): SchoolPartView | null {
  const grade = toNioarig(gradeLevel, numbering);
  if (grade === null) return null;
  return parts.find((part) => part.gradeFrom <= grade && grade <= part.gradeTo) ?? null;
}

/** "F–3", "4–6", "9": a span as a person writes it (0 is förskoleklass). */
export function spanLabel(span: SpanLike): string {
  const grade = (value: number): string => (value === 0 ? 'F' : String(value));
  return span.gradeFrom === span.gradeTo ? grade(span.gradeFrom) : `${grade(span.gradeFrom)}–${grade(span.gradeTo)}`;
}

/** The skoldelar in årskurs order, then by name (Swedish order is the caller's). */
export function byGrade(a: SchoolPartView, b: SchoolPartView): number {
  return a.gradeFrom - b.gradeFrom || a.gradeTo - b.gradeTo || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
