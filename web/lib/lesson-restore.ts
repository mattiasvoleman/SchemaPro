import type { CreateMasterLessonInput } from "@/lib/queries";
import type { MasterLesson } from "@/lib/types";

/**
 * "HH:MM:SS" down to the "HH:MM" the create API speaks.
 *
 * The same one line the page uses, and deliberately no cleverer. These rows
 * come from PostgREST, which renders a `time` column as "HH:MM:SS" — a branch
 * for the 1970-timestamp shape that the NestJS API produces would be dead code
 * here and a second, differing definition of one conversion.
 */
function toHHMM(time: string): string {
  return time.slice(0, 5);
}

/**
 * Everything a delete has to remember to be undoable.
 *
 * ONE function because there were two lists, and the shorter one was wrong.
 * `undoableDelete` carried fourteen fields under a comment explaining that
 * without them undo turns an odd-week lesson into a weekly one; `bulkDelete`
 * carried nine, so a bulk undo also dropped `extraGroupIds` and `studentIds` —
 * silently, and on exactly the lessons most likely to have them.
 *
 * `coTeacherId` is deliberately absent and cannot be added here alone: neither
 * CreateMasterLessonInput nor the server's create DTO accepts it, so a co-taught
 * lesson loses its second teacher on undo through either path. That is fixed
 * where the field is missing, not by adding a property nothing reads.
 */
export function restorableInput(lesson: MasterLesson): CreateMasterLessonInput {
  return {
    academicYearId: lesson.academicYearId,
    subjectId: lesson.subjectId,
    studentGroupId: lesson.studentGroupId,
    teacherId: lesson.teacherId,
    coTeacherId: lesson.coTeacherId,
    roomId: lesson.roomId,
    dayOfWeek: lesson.dayOfWeek,
    startTime: toHHMM(lesson.startTime),
    endTime: toHHMM(lesson.endTime),
    isLocked: lesson.isLocked,
    recurrence: lesson.recurrence,
    startDate: lesson.startDate,
    endDate: lesson.endDate,
    extraGroupIds: lesson.extraGroupIds,
    studentIds: lesson.studentIds,
  };
}
