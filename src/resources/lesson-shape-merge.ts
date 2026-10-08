import { BadRequestException } from '@nestjs/common';
import {
  MAX_DISTINCT_LENGTHS,
  canonicalShape,
  isMixed,
  type CanonicalShape,
  type LessonShape,
} from '../common/lesson-lengths';

/*
 * One timplanspost write's lesson shape: a PATCH (or a create, or an imported
 * row) laid over the row it lands on, resolved to the canonical form the
 * TeachingRequirements_lesson_lengths_are_canonical CHECK admits.
 *
 * ONE MERGE, CALLED BY EVERY WRITER THAT CAN TOUCH THE SHAPE: the
 * timplanspost's POST and PATCH (teaching-requirements.service.ts) and the
 * requirements import, per row (import.service.ts). Each hands the RESOLVED
 * shape on to the staffing judge (enforceRequirementWrite /
 * RequirementImportChecks) and writes what `write` says, so the judge and the
 * write can never disagree about whether a row is split.
 *
 * THE RULES, in the order they are tried:
 *
 *  - lessonLengths sent and not empty: the list is the row. Scalars sent beside
 *    it must agree with what the list says (its count and its longest), or the
 *    write is LESSON_LENGTHS_MISMATCH — two answers to one question, and
 *    neither may silently win. A list of one length is a uniform row.
 *  - lessonLengths sent as []: the row is uniform, at the sent scalars where
 *    given and the stored ones where not. So {80,40} PATCHed with [] alone is
 *    2 × 80: an explicit "make it uniform" keeps the count and the length that
 *    binds, which is what the scalars already said.
 *  - no list, stored row split: scalars that equal the stored count and longest
 *    KEEP the split. That is an old client re-saving the row to change its
 *    teacher, and an old CSV re-imported: neither knows the list exists, and
 *    neither asked to drop it. Scalars that differ make the row uniform as
 *    they say — an old client that typed "3 × 60" stated a uniform row, and
 *    that is what the old form showed it.
 *  - no list, stored row uniform: as before the column existed.
 *
 * WHAT IS WRITTEN keeps the SQL of a school that never splits exactly as it
 * was: a write carries `lessonLengths` only when a list was sent or when it
 * turns a split row uniform, and carries no scalar a split row already has.
 */

/** A write's three length fields, as the DTOs carry them. */
export interface LessonShapePatch {
  lessonsPerWeek?: number;
  minutesPerLesson?: number;
  lessonLengths?: readonly number[] | null;
}

export interface ResolvedLessonShape {
  /** The row's shape after the write. */
  shape: CanonicalShape;
  /** The length fields to put in the UPDATE (or INSERT) data, and only those. */
  write: Partial<CanonicalShape>;
}

export const LESSON_LENGTHS_MISMATCH = 'LESSON_LENGTHS_MISMATCH';
export const LESSON_LENGTHS_TOO_MANY_KINDS = 'LESSON_LENGTHS_TOO_MANY_KINDS';

export type LessonShapeProblem =
  | { code: typeof LESSON_LENGTHS_MISMATCH; message: string }
  | { code: typeof LESSON_LENGTHS_TOO_MANY_KINDS; message: string };

/** A create's defaults, the columns' own. */
export const CREATE_DEFAULT_SHAPE: CanonicalShape = {
  lessonsPerWeek: 1,
  minutesPerLesson: 60,
  lessonLengths: [],
};

/** Whether a write names any of the three length fields. */
export function touchesLessonShape(patch: LessonShapePatch): boolean {
  return (
    patch.lessonsPerWeek !== undefined ||
    patch.minutesPerLesson !== undefined ||
    (patch.lessonLengths ?? undefined) !== undefined
  );
}

const stored = (row: LessonShape): CanonicalShape => ({
  lessonsPerWeek: row.lessonsPerWeek,
  minutesPerLesson: row.minutesPerLesson,
  lessonLengths: isMixed(row) ? [...(row.lessonLengths ?? [])] : [],
});

/**
 * The write laid over the stored row, or the problem with it. `before` is the
 * stored row (CREATE_DEFAULT_SHAPE for a create).
 */
export function resolveLessonShape(
  before: LessonShape,
  patch: LessonShapePatch,
): ResolvedLessonShape | LessonShapeProblem {
  const current = stored(before);
  // Null is the DTO's to refuse; a caller that reaches here another way gets
  // it read as omitted, like the scalars' `??` below.
  const list = patch.lessonLengths ?? undefined;

  if (list !== undefined && list.length > 0) {
    if (new Set(list).size > MAX_DISTINCT_LENGTHS) {
      return {
        code: LESSON_LENGTHS_TOO_MANY_KINDS,
        message: 'lessonLengths: högst tre olika lektionslängder i en timplanspost.',
      };
    }
    const shape = canonicalShape(list);
    const saidLessons = patch.lessonsPerWeek ?? shape.lessonsPerWeek;
    const saidMinutes = patch.minutesPerLesson ?? shape.minutesPerLesson;
    if (saidLessons !== shape.lessonsPerWeek || saidMinutes !== shape.minutesPerLesson) {
      return {
        code: LESSON_LENGTHS_MISMATCH,
        message:
          `lessonLengths: ${shape.lessonsPerWeek} lektioner med längsta ${shape.minutesPerLesson} minuter, ` +
          `men lessonsPerWeek och minutesPerLesson säger ${saidLessons} × ${saidMinutes}. ` +
          'Skicka bara lessonLengths, eller värden som stämmer med den.',
      };
    }
    return { shape, write: { ...shape } };
  }

  const uniform: CanonicalShape = {
    lessonsPerWeek: patch.lessonsPerWeek ?? current.lessonsPerWeek,
    minutesPerLesson: patch.minutesPerLesson ?? current.minutesPerLesson,
    lessonLengths: [],
  };

  if (list !== undefined) {
    // [] sent: uniform, stated in full so the CHECK sees one consistent row.
    return { shape: uniform, write: { ...uniform } };
  }

  if (current.lessonLengths.length > 0) {
    const unchanged =
      uniform.lessonsPerWeek === current.lessonsPerWeek &&
      uniform.minutesPerLesson === current.minutesPerLesson;
    // Equal scalars keep the split and write nothing; different ones state a
    // uniform row, and the list is cleared in the same statement.
    return unchanged ? { shape: current, write: {} } : { shape: uniform, write: { ...uniform } };
  }

  // A uniform row stays uniform, and the write is the scalars that were sent.
  return {
    shape: uniform,
    write: {
      ...(patch.lessonsPerWeek !== undefined ? { lessonsPerWeek: patch.lessonsPerWeek } : {}),
      ...(patch.minutesPerLesson !== undefined ? { minutesPerLesson: patch.minutesPerLesson } : {}),
    },
  };
}

export function isLessonShapeProblem(
  value: ResolvedLessonShape | LessonShapeProblem,
): value is LessonShapeProblem {
  return 'code' in value;
}

/** resolveLessonShape for the HTTP writers: a problem is a coded 400. */
export function mergeLessonShape(before: LessonShape, patch: LessonShapePatch): ResolvedLessonShape {
  const resolved = resolveLessonShape(before, patch);
  if (isLessonShapeProblem(resolved)) {
    throw new BadRequestException({ message: resolved.message, code: resolved.code });
  }
  return resolved;
}
