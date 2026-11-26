import type { LessonRecurrence, MasterLesson } from "@/lib/types";
import type { ExemptRule } from "@/lib/exemptions";

export const NONE = "__none__";

/** Normalizes DB time values ("HH:MM:SS") to input-friendly "HH:MM". */
export function toHHMM(time: string): string {
  return time.slice(0, 5);
}

export function minutesToHHMM(minutes: number): string {
  const h = String(Math.floor(minutes / 60)).padStart(2, "0");
  const m = String(minutes % 60).padStart(2, "0");
  return `${h}:${m}`;
}

/** The editable fields of a lesson, as a gateway-ready patch. */
export interface LessonSnapshot {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  roomId: string | null;
  teacherId: string | null;
  isLocked: boolean;
  isParked: boolean;
  recurrence: LessonRecurrence;
  startDate: string | null;
  endDate: string | null;
  /** Undantag med flit: said only on a lesson that has one, so an undo of a move from an exempt time puts the exemption back with it. */
  exempt?: ExemptRule[];
}

export function snapshotOf(lesson: MasterLesson): LessonSnapshot {
  return {
    dayOfWeek: lesson.dayOfWeek,
    startTime: toHHMM(lesson.startTime),
    endTime: toHHMM(lesson.endTime),
    roomId: lesson.roomId,
    teacherId: lesson.teacherId,
    isLocked: lesson.isLocked,
    isParked: lesson.isParked,
    recurrence: lesson.recurrence,
    startDate: lesson.startDate,
    endDate: lesson.endDate,
    ...(lesson.exemptFrom && lesson.exemptFrom.length > 0 ? { exempt: lesson.exemptFrom } : {}),
  };
}


export type GroupBy = "none" | "teacher" | "room" | "group";
