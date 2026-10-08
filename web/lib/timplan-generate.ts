// "Skapa timplansposter" — the dialog's pure part: the lesson length it
// suggests, what a typed length or lesson count may be, the response's shape,
// and a preview row after the admin's edit. The PROPOSAL is the gateway's
// (src/timplan/generate-requirements.ts); nothing here proposes a row, it
// only recomputes lessons × length against the target the gateway sent for
// a row the admin changed, so the surplus beside it is the one the apply
// will create.

import { isMixed, lengthPartsOf, lessonCountOf, weeklyMinutesOf } from "@/lib/lesson-lengths";

/** The length the dialog falls back to when the year has no posts yet. */
export const DEFAULT_LESSON_MINUTES = 60;
export const MIN_LESSON_MINUTES = 15;
export const MAX_LESSON_MINUTES = 240;
/** The solver's grid (src/common/solver-grid.ts SLOT_MINUTES). */
export const LESSON_GRID_MINUTES = 5;
export const MAX_LESSONS_PER_WEEK = 40;

/**
 * The lesson length the dialog suggests: the one the year's posts use most,
 * else 60. The schema has no school default (the plan decided against adding
 * one), and the length a school already writes its posts in is a better guess
 * than any constant. A tie goes to the shorter length — more, shorter lessons
 * overshoot a target by less.
 *
 * Each post is ONE vote, as it always was. A split post (1 × 80 + 1 × 40)
 * shares its vote among its lengths by their lessons — half to 80, half to
 * 40 — rather than giving the whole of it to its longest, which is what
 * minutesPerLesson alone would have said. A uniform post votes exactly as
 * before, so a school that never splits gets the suggestion it always got.
 */
export function suggestLessonLength(
  requirements: readonly { lessonsPerWeek?: number; minutesPerLesson: number; lessonLengths?: readonly number[] }[],
): number {
  const counts = new Map<number, number>();
  for (const row of requirements) {
    const parts = row.lessonLengths && row.lessonLengths.length > 0 && row.lessonsPerWeek !== undefined
      ? lengthPartsOf({ lessonsPerWeek: row.lessonsPerWeek, minutesPerLesson: row.minutesPerLesson, lessonLengths: row.lessonLengths })
      : [{ count: 1, minutes: row.minutesPerLesson }];
    const lessons = parts.reduce((sum, part) => sum + part.count, 0);
    for (const part of parts) {
      if (lessonLengthProblem(String(part.minutes)) !== null) continue;
      counts.set(part.minutes, (counts.get(part.minutes) ?? 0) + part.count / lessons);
    }
  }
  let best: number | null = null;
  let bestCount = 0;
  for (const [minutes, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== null && minutes < best)) {
      best = minutes;
      bestCount = count;
    }
  }
  return best ?? DEFAULT_LESSON_MINUTES;
}

export type LessonLengthProblem = "integer" | "range" | "grid";

/** Why a typed lesson length cannot be sent, or null when it can. */
export function lessonLengthProblem(text: string): LessonLengthProblem | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return "integer";
  const value = Number(trimmed);
  if (value < MIN_LESSON_MINUTES || value > MAX_LESSON_MINUTES) return "range";
  if (value % LESSON_GRID_MINUTES !== 0) return "grid";
  return null;
}

/** A typed lessons-per-week, 1..40, or null. */
export function parseLessons(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= 1 && value <= MAX_LESSONS_PER_WEEK ? value : null;
}

/** Mirror of ProposedRow (src/timplan/generate-requirements.ts). */
export interface GenerateProposedRow {
  studentGroupId: string;
  groupName: string;
  subjectId: string;
  subjectName: string;
  gradeLevel: number;
  targetMinutesPerWeek: number;
  /** The lessons a week; on a split row, the list's length. */
  lessonsPerWeek: number;
  /** The length; on a split row, the longest. */
  minutesPerLesson: number;
  /**
   * Only on a split row (remainder SPLIT): one length per lesson, longest
   * first — 175 at 60 is [60, 60, 55].
   */
  lessonLengths?: number[];
  plannedMinutesPerWeek: number;
  surplusMinutesPerWeek: number;
  overridden: boolean;
  capped: boolean;
  /** The created requirement; absent in a preview. */
  requirementId?: string;
}

/** Mirror of SkippedRow. */
export interface GenerateSkippedRow {
  studentGroupId: string;
  groupName: string;
  subjectId: string;
  subjectName: string;
  gradeLevel: number;
  /** EXISTS: the class has the pair. ALTERNATIVE: språkval, or the SV_SVA subject the class does not get. */
  reason: "EXISTS" | "ALTERNATIVE";
  alternativeCode: string | null;
  /** ALTERNATIVE in SV_SVA: the subject of the line the class has or gets. */
  alternativeTo: string | null;
}

/** Mirror of GenerateRequirementsResponse (src/timplan/timplan-requirements.service.ts). */
export interface GenerateRequirementsResponse {
  localTimplanId: string;
  planName: string;
  planStatus: "DRAFT" | "DECIDED";
  academicYearId: string;
  gradeLevels: number[];
  minutesPerLesson: number;
  /** Echoed only when the request stated it; an omitted one is ROUND_UP. */
  remainder?: Remainder;
  dryRun: boolean;
  created: number;
  rows: GenerateProposedRow[];
  skipped: GenerateSkippedRow[];
}

export interface GenerateOverride {
  studentGroupId: string;
  subjectId: string;
  lessonsPerWeek: number;
  minutesPerLesson: number;
}

/**
 * What the minutes that do not fill a whole lesson become: SPLIT meets the
 * target with up to two lengths (175 at 60 is 2 × 60 + 1 × 55), ROUND_UP adds
 * a whole lesson (3 × 60, 5 over). The gateway reads an omitted field as
 * ROUND_UP; the dialog always states it.
 */
export type Remainder = "SPLIT" | "ROUND_UP";

export interface GenerateBody {
  academicYearId: string;
  minutesPerLesson: number;
  remainder?: Remainder;
  dryRun: boolean;
  overrides?: GenerateOverride[];
}

/** One preview row's fields as the admin typed them. */
export interface RowEdit {
  lessons: string;
  minutes: string;
}

/**
 * Pairs skipped because the class already has them — not the språkval and
 * SvA pairs skipped as ALTERNATIVE, which were never going to be created.
 */
export const existingCount = (answer: Pick<GenerateRequirementsResponse, "skipped">): number =>
  answer.skipped.filter((row) => row.reason === "EXISTS").length;

export const rowKey = (row: { studentGroupId: string; subjectId: string }): string =>
  `${row.studentGroupId}:${row.subjectId}`;

export interface EditedRow {
  /** Null when the typed figure is not one the gateway takes. */
  lessons: number | null;
  minutes: number | null;
  planned: number | null;
  /** planned − target; negative is under the plan. */
  surplus: number | null;
  changed: boolean;
}

/**
 * A preview row after the admin's edit: the same arithmetic the gateway's
 * proposal uses (lessons × length against the target), so the surplus beside
 * an edited row is the one the apply will create.
 *
 * An unedited split row is worth its lessons' minutes (weeklyMinutesOf). An
 * edit is always uniform — "Gör enhetlig" is the only edit a split row
 * offers, and the override is lessons × minutes — so ANY edit of a split row
 * is a change, even one whose count and length equal the row's count and
 * longest: without it, 2 × 60 + 1 × 55 made uniform at 3 × 60 would be sent
 * as no override at all, and the apply would create the split.
 */
export function editedRow(row: GenerateProposedRow, edit: RowEdit | undefined): EditedRow {
  const lessons = edit ? parseLessons(edit.lessons) : lessonCountOf(row);
  const minutes = edit
    ? lessonLengthProblem(edit.minutes) === null
      ? Number(edit.minutes.trim())
      : null
    : row.minutesPerLesson;
  const planned =
    lessons !== null && minutes !== null ? (edit ? lessons * minutes : weeklyMinutesOf(row)) : null;
  return {
    lessons,
    minutes,
    planned,
    surplus: planned === null ? null : planned - row.targetMinutesPerWeek,
    changed:
      edit !== undefined &&
      (isMixed(row) ||
        edit.lessons.trim() !== String(row.lessonsPerWeek) ||
        edit.minutes.trim() !== String(row.minutesPerLesson)),
  };
}

/**
 * The overrides an apply sends: one per row the admin changed, and only
 * those — an unchanged row is the gateway's own proposal. Null while any
 * edited row holds a figure the gateway would refuse; the dialog says which.
 */
export function overridesFrom(
  rows: readonly GenerateProposedRow[],
  edits: ReadonlyMap<string, RowEdit>,
): GenerateOverride[] | null {
  const overrides: GenerateOverride[] = [];
  for (const row of rows) {
    const edited = editedRow(row, edits.get(rowKey(row)));
    if (edited.lessons === null || edited.minutes === null) return null;
    if (!edited.changed) continue;
    overrides.push({
      studentGroupId: row.studentGroupId,
      subjectId: row.subjectId,
      lessonsPerWeek: edited.lessons,
      minutesPerLesson: edited.minutes,
    });
  }
  return overrides;
}

/**
 * "Gör enhetlig" on a split row: the uniform post at the chosen length that
 * the round-up rule would have proposed — ceil(target / length) lessons,
 * at most 40. The admin sees it in the row's own fields and may change it.
 */
export function uniformEdit(row: Pick<GenerateProposedRow, "targetMinutesPerWeek">, length: number): RowEdit {
  const lessons = Math.min(MAX_LESSONS_PER_WEEK, Math.max(1, Math.ceil(row.targetMinutesPerWeek / length)));
  return { lessons: String(lessons), minutes: String(length) };
}
