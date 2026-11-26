"use client";

import { clockOf } from "@/lib/possible-times";
import type { LessonEditDraft } from "@/components/schedule/lesson-edit-dialog";
import { PossibleTimesChoices } from "@/components/schedule/possible-times-choices";
import type { MasterLesson } from "@/lib/types";

/*
 * MÖJLIGA TIDER IN JUSTERA LEKTION (E3).
 *
 * The board paints where a lesson in hand can stand and lists the times (possible-layer.tsx), for a reader with a marker. A phone has
 * none: a tap opens this dialog, where day, clock and room are fields. This is the same answer as a list inside it
 * (possible-times-choices.tsx): each time a button that FILLS the fields (day, start, end, and the room when the gateway offered the
 * time in another), after which the dialog's own question says what the judge thinks of them and Spara lays the lesson. Nothing is
 * written by a button here.
 */

export function LessonPossibleTimes({
  lesson,
  draft,
  onDraftChange,
}: {
  lesson: MasterLesson;
  draft: LessonEditDraft;
  onDraftChange: (draft: LessonEditDraft) => void;
}) {
  return (
    <PossibleTimesChoices
      lessonId={lesson.id}
      chosen={(option) => draft.dayOfWeek === String(option.dayOfWeek) && draft.startTime === clockOf(option.startMinutes) && draft.endTime === clockOf(option.endMinutes)}
      onChoose={(option) => {
        // The room the gateway put the lesson in, when that is another than its own: the field says it, and the judge asks about it.
        const room = option.roomChanged ? (option.lessons.find((entry) => entry.lessonId === lesson.id)?.roomId ?? null) : null;
        onDraftChange({
          ...draft,
          dayOfWeek: String(option.dayOfWeek),
          startTime: clockOf(option.startMinutes),
          endTime: clockOf(option.endMinutes),
          ...(room !== null ? { roomId: room } : {}),
        });
      }}
    />
  );
}
