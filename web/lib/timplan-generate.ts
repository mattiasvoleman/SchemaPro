// "Skapa timplansposter" — the dialog's pure part: the lesson length it
// suggests, what a typed length or lesson count may be, the response's shape,
// and a preview row after the admin's edit. The PROPOSAL is the gateway's
// (src/timplan/generate-requirements.ts); nothing here proposes a row, it
// only recomputes lessons × length against the target the gateway sent for
// a row the admin changed, so the surplus beside it is the one the apply
// will create.

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
 */
export function suggestLessonLength(requirements: readonly { minutesPerLesson: number }[]): number {
  const counts = new Map<number, number>();
  for (const row of requirements) {
    if (lessonLengthProblem(String(row.minutesPerLesson)) !== null) continue;
    counts.set(row.minutesPerLesson, (counts.get(row.minutesPerLesson) ?? 0) + 1);
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
  lessonsPerWeek: number;
  minutesPerLesson: number;
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
  reason: "EXISTS";
}

/** Mirror of GenerateRequirementsResponse (src/timplan/timplan-requirements.service.ts). */
export interface GenerateRequirementsResponse {
  localTimplanId: string;
  planName: string;
  planStatus: "DRAFT" | "DECIDED";
  academicYearId: string;
  gradeLevels: number[];
  minutesPerLesson: number;
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

export interface GenerateBody {
  academicYearId: string;
  minutesPerLesson: number;
  dryRun: boolean;
  overrides?: GenerateOverride[];
}

/** One preview row's fields as the admin typed them. */
export interface RowEdit {
  lessons: string;
  minutes: string;
}

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
 */
export function editedRow(row: GenerateProposedRow, edit: RowEdit | undefined): EditedRow {
  const lessons = edit ? parseLessons(edit.lessons) : row.lessonsPerWeek;
  const minutes = edit
    ? lessonLengthProblem(edit.minutes) === null
      ? Number(edit.minutes.trim())
      : null
    : row.minutesPerLesson;
  const planned = lessons !== null && minutes !== null ? lessons * minutes : null;
  return {
    lessons,
    minutes,
    planned,
    surplus: planned === null ? null : planned - row.targetMinutesPerWeek,
    changed:
      edit !== undefined &&
      (edit.lessons.trim() !== String(row.lessonsPerWeek) ||
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
