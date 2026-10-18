import type { MasterLesson } from "@/lib/types";
import type { CandidateLesson } from "./types";

/*
 * The weeks a comparison is made of, as MasterLesson rows: the current
 * grundschema, and each candidate's grundschema as it would stand the moment
 * after it was applied. Both are fed to the same readers — lib/gaps.ts for
 * håltimmar, the week sheet, the moved list — so a candidate is measured by
 * exactly the rules the draft is.
 *
 * Pure and light: no conflict engine here, so the page may import it
 * statically and leave the heavy readers to its lazy modules.
 */

/** A draft lesson with who owns it: the one column regeneration decides by. */
export interface OriginMaster extends MasterLesson {
  /**
   * True only for lessons the optimizer produced. Absent reads as false, the
   * column's own default: a lesson nobody said was generated is handmade, and
   * a handmade lesson is never replaced.
   */
  isGenerated?: boolean;
}

/**
 * Whether regeneration keeps this lesson — the gateway's
 * PRESERVED_FROM_REGENERATION, read on the browser's rows: handmade, locked,
 * attended by extra classes, or by named pupils. Applying a candidate deletes
 * every other lesson of the year and keeps these, exactly as Generera does.
 */
export function isPreserved(lesson: OriginMaster): boolean {
  return (
    lesson.isGenerated !== true ||
    lesson.isLocked ||
    lesson.extraGroupIds.length > 0 ||
    lesson.studentIds.length > 0
  );
}

/**
 * The grundschema as it stands: every lesson on the grid. A parked lesson
 * occupies nothing — it is on the tray, its day and time only a memory of
 * where it was — so it is left out here as the timetable page leaves it out
 * (and as /admin/gaps does not, which is that page's bug and not a rule).
 */
export function currentWeek(draft: readonly OriginMaster[]): MasterLesson[] {
  return draft.filter((lesson) => !lesson.isParked);
}

/**
 * The lessons an apply would replace: the draft's non-preserved rows, parked
 * or not. What the moved figures are counted against, as the gateway counts
 * `movedOf`.
 */
export function replacedLessons(draft: readonly OriginMaster[]): OriginMaster[] {
  return draft.filter((lesson) => !isPreserved(lesson));
}

/** "HH:MM" of "HH:MM" or "HH:MM:SS": the draft's rows carry seconds, the candidate's do not. */
export function clockOf(time: string): string {
  return time.slice(0, 5);
}

/**
 * The year's grundschema after an apply: the preserved lessons that are on
 * the grid, and the candidate's. A preserved lesson that is parked stays
 * parked, so it occupies nothing here either.
 *
 * A candidate lesson has no id of its own — the apply creates the rows — so
 * it is given one that names no saved lesson, unique within the week.
 */
export function candidateWeek(
  draft: readonly OriginMaster[],
  lessons: readonly CandidateLesson[],
  academicYearId = "",
): MasterLesson[] {
  const kept = draft.filter((lesson) => isPreserved(lesson) && !lesson.isParked);
  const placed = lessons.map(
    (lesson, index): MasterLesson => ({
      id: `candidate-lesson-${index}`,
      academicYearId,
      subjectId: lesson.subjectId,
      studentGroupId: lesson.studentGroupId,
      teacherId: lesson.teacherId,
      coTeacherId: lesson.coTeacherId,
      roomId: lesson.roomId,
      dayOfWeek: lesson.dayOfWeek,
      startTime: clockOf(lesson.startTime),
      endTime: clockOf(lesson.endTime),
      isLocked: false,
      isParked: false,
      recurrence: lesson.recurrence,
      startDate: lesson.startDate,
      endDate: lesson.endDate,
      // A generated lesson never carries either: a lesson that did would be
      // preserved, and the engine would never have been asked to place it.
      extraGroupIds: [],
      studentIds: [],
    }),
  );
  return [...kept, ...placed];
}
