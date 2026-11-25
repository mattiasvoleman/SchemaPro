import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { LessonRecurrence, MasterLesson } from "@/lib/types";

/*
 * THE LÄSANDE FRÅGAN, ASKED WHILE JUSTERA LEKTION IS FILLED IN (E1).
 *
 * POST /api/v1/master-lessons/judge (src/calendar/lesson-judge.ts) answers whether a tänkt drag would be let through, said the way a
 * save says no, and writes nothing. It is the judge of the PATCH the dialog's Spara sends, "låt stå" included, so what it says before the
 * press is what the press would say. The answer is told to the reader beside the fields, and Spara stays allowed all the same: the
 * save is the server's, and a question that is slow or does not come must not stand in the way of it.
 *
 * Only what the dialog's fields moved is sent (a field left as the lesson has it is not a change of it), and nothing is asked until
 * something has moved. Read by the dialog alone, so it is in the dialogs' chunk and not in the page's first load.
 */

/** What the judge answers for one lesson: the reasons, each with the params its sentence is written from (common.codes.MASTER_LESSON_REFUSED). */
export interface MoveRefusal {
  reason: string;
  params: Record<string, string | number>;
  /** The gateway's own Swedish sentence, for the reader whose catalogue has not got the reason's. */
  text: string;
}

export interface MoveJudgement {
  lessonId: string;
  ok: boolean;
  /** The lesson is a förläggning's: it is changed on the timplan, and no drag of it stands. */
  placed?: true;
  refusals: MoveRefusal[];
}

export interface LessonJudgement {
  ok: boolean;
  moves: MoveJudgement[];
}

/** One lesson's tänkta drag, the way the PATCH says it. */
export interface JudgeMove {
  lessonId: string;
  dayOfWeek?: number;
  startTime?: string;
  endTime?: string;
  roomId?: string | null;
  teacherId?: string | null;
  recurrence?: LessonRecurrence;
  startDate?: string | null;
  endDate?: string | null;
}

/** The dialog's fields, as it holds them (components/schedule/lesson-edit-dialog.tsx LessonEditDraft). */
export interface JudgedDraft {
  dayOfWeek: string;
  startTime: string;
  endTime: string;
  roomId: string;
  teacherId: string;
  recurrence: LessonRecurrence;
  startDate: string;
  endDate: string;
}

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * What the fields have moved, or null when nothing is to be asked: the lesson stands as it is, or the clock is not one the gateway would
 * read (an emptied time input, a start that is not before its end), which the dialog's own Spara has no answer for either.
 */
export function moveOf(lesson: MasterLesson, draft: JudgedDraft, none: string): JudgeMove | null {
  if (!CLOCK.test(draft.startTime) || !CLOCK.test(draft.endTime) || draft.startTime >= draft.endTime) return null;
  const move: JudgeMove = { lessonId: lesson.id };
  let moved = false;
  const set = <K extends keyof JudgeMove>(key: K, value: JudgeMove[K], stands: unknown) => {
    if (value === stands) return;
    move[key] = value;
    moved = true;
  };
  set("dayOfWeek", Number(draft.dayOfWeek), lesson.dayOfWeek);
  set("startTime", draft.startTime, lesson.startTime.slice(0, 5));
  set("endTime", draft.endTime, lesson.endTime.slice(0, 5));
  set("roomId", draft.roomId === none ? null : draft.roomId, lesson.roomId);
  set("teacherId", draft.teacherId === none ? null : draft.teacherId, lesson.teacherId);
  set("recurrence", draft.recurrence, lesson.recurrence);
  set("startDate", draft.startDate === "" ? null : draft.startDate, lesson.startDate);
  set("endDate", draft.endDate === "" ? null : draft.endDate, lesson.endDate);
  return moved ? move : null;
}

/** How long the fields stand still before they are asked about. */
export const JUDGE_DELAY_MS = 300;

/**
 * Nothing moved (`idle`), the question on its way (`checking`), the judge's answer (`done`) or no answer (`failed`: the network, a 5xx, a
 * lesson that is gone: the save is still the judge).
 */
export type JudgementView =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "done"; judgement: MoveJudgement }
  | { status: "failed" };

export function useLessonJudgement(
  lesson: MasterLesson | null | undefined,
  draft: JudgedDraft,
  none: string,
  delayMs: number = JUDGE_DELAY_MS,
): JudgementView {
  const move = lesson ? moveOf(lesson, draft, none) : null;
  const key = move === null ? null : JSON.stringify(move);
  const [answer, setAnswer] = useState<{ key: string; judgement: MoveJudgement | null } | null>(null);

  useEffect(() => {
    if (move === null || key === null) {
      setAnswer(null);
      return;
    }
    const asking = new AbortController();
    const timer = setTimeout(() => {
      api.post<LessonJudgement>("/api/v1/master-lessons/judge", { moves: [move] }, asking.signal).then(
        (judged) => {
          if (!asking.signal.aborted) setAnswer({ key, judgement: judged.moves[0] ?? null });
        },
        () => {
          if (!asking.signal.aborted) setAnswer({ key, judgement: null });
        },
      );
    }, delayMs);
    return () => {
      clearTimeout(timer);
      asking.abort();
    };
    // The question is the key: a re-render with the same fields asks nothing again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, delayMs]);

  if (key === null) return { status: "idle" };
  if (answer === null || answer.key !== key) return { status: "checking" };
  return answer.judgement === null ? { status: "failed" } : { status: "done", judgement: answer.judgement };
}
