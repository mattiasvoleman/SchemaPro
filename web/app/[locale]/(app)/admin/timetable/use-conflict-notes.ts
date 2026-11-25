import { useMemo } from "react";
import type { ProblemLookup } from "@/lib/api-error-text";
import type { ConflictHit } from "@/lib/conflicts";
import type { GradeSpan } from "@/lib/grade-span";
import type { AvailabilityConstraint, MasterLesson, StudentGroup, Subject } from "@/lib/types";
import { useLazyModule } from "@/lib/use-lazy-module";

/**
 * What each clashing card says, in words (the card's note): the reasons of a lesson that stands against a rule, in the sentences a
 * refused save and the krocklista are said in (lib/conflict-rows.ts), joined into one text for the card's name and its hover.
 *
 * The rows are read by a module the page does not load until there is a clash to say: a school with none fetches nothing, and a
 * school with some gets the notes a moment after the first picture, the cards being drawn as clashing at once (the ring and the
 * triangle come from the clash map, which the page has) and the words following.
 */
export function useConflictNotes(inputs: {
  conflictMap: ReadonlyMap<string, readonly ConflictHit[]>;
  lessonById: ReadonlyMap<string, MasterLesson>;
  groupById: ReadonlyMap<string, Pick<StudentGroup, "name">>;
  subjectById: ReadonlyMap<string, Pick<Subject, "name">>;
  constraints: AvailabilityConstraint[] | undefined;
  gradeSpanOf: Map<string, GradeSpan> | undefined;
  /** The sentence for a clash with a room's lock, which the gateway has no refusal for (timetable.conflictRoomLock). */
  roomLock: string;
  tCommon: ProblemLookup;
}): ReadonlyMap<string, string> | undefined {
  const { conflictMap, lessonById, groupById, subjectById, constraints, gradeSpanOf, roomLock, tCommon } = inputs;
  const rows = useLazyModule(() => import("@/lib/conflict-rows"), undefined, conflictMap.size > 0);
  return useMemo(() => {
    if (!rows || conflictMap.size === 0) return undefined;
    const notes = new Map<string, string>();
    const names = {
      group: (id: string) => groupById.get(id)?.name ?? "",
      subject: (id: string) => subjectById.get(id)?.name ?? "",
    };
    for (const { lesson, reasons } of rows.conflictRows(conflictMap, lessonById, names, { constraints: constraints ?? [], gradeSpanOf })) {
      const sentences = rows.reasonSentences(reasons, roomLock, tCommon);
      if (sentences.length > 0) notes.set(lesson.id, sentences.join(" "));
    }
    return notes;
  }, [rows, conflictMap, lessonById, groupById, subjectById, constraints, gradeSpanOf, roomLock, tCommon]);
}
