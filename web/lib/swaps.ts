// Byten och flyttar (G1): the swaps and chains of three the gateway offers a
// picked lesson, and their apply (src/swaps). Kept apart from lib/queries.ts:
// only the swap dialog, itself fetched on the first press of "Föreslå byten",
// reads these, and a timetable page that never asks should not carry them.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

export interface SwapSlot {
  dayOfWeek: number;
  /** Minutes after midnight. */
  startMinutes: number;
  endMinutes: number;
}

export interface SwapMove {
  lessonId: string;
  from: SwapSlot;
  to: SwapSlot;
}

/**
 * Why a lesson stands beside another and goes with it.
 *
 *   BLOCK       a member of the same parallel block
 *   SAME_TIMES  a block on this one's times
 *   HALF        the other half of the class (the rotation)
 *   REPLACING   a replacing group and the class lesson it replaces
 */
export type ParallelKind = "BLOCK" | "SAME_TIMES" | "HALF" | "REPLACING";

export interface ParallelLink {
  kind: ParallelKind;
  lessonId: string;
  viaLessonId: string;
}

export type SoftCode =
  | "PUPIL_GAPS"
  | "TEACHER_GAPS"
  | "DISTRIBUTION"
  | "TEACHER_DAY"
  | "MOVED_LESSONS";

export interface SoftCost {
  code: SoftCode;
  unit: "MINUTES" | "BREACHES" | "LESSONS";
  before: number;
  after: number;
  delta: number;
}

export type HardCode = "CLASH" | "FRAME" | "LUNCH" | "GRADE_RULE" | "OTHER_SCHOOL";

export interface ExternalTouch {
  kind: "SHARED_TEACHER" | "ROOM_LENT" | "ROOM_BORROWED";
  lessonId: string;
  /** Our teacher or room. */
  resourceId: string;
  schools: string[];
  dayOfWeek: number;
  startMinutes: number;
  endMinutes: number;
}

export interface SwapLessonView {
  id: string;
  subjectName: string;
  groupName: string;
  teacherId: string | null;
  coTeacherId: string | null;
  roomId: string | null;
  isLocked: boolean;
}

export interface SwapProposal {
  id: string;
  kind: "SWAP" | "CHAIN";
  moves: SwapMove[];
  parallels: Array<ParallelLink & { outcome: "FOLLOWS" }>;
  external: ExternalTouch[];
  hard: HardCode[];
  soft: SoftCost[];
  lessons: SwapLessonView[];
  /**
   * Published calendar lessons that applying it would REMOVE instead of move
   * (a lesson carried to a time that has begun), with their vikarie, lesson log
   * and homework. Undo puts the timetable's lessons back, not these.
   */
  removedCalendarLessons: number;
}

export interface SwapSuggestion {
  lessonId: string;
  academicYearId: string;
  unit: { lessonIds: string[]; links: ParallelLink[] };
  selectedLocked: boolean;
  proposals: SwapProposal[];
  immovable?: "PARKED" | "NOT_PLACED" | "PLACED";
  stats: {
    partners: number;
    candidates: number;
    judged: number;
    refused: number;
    /** The time budget or the candidate cap ended the search: there may be more proposals. */
    truncated: boolean;
    chainsCut: boolean;
    elapsedMs: number;
    phasesMs: { read: number; index: number; warm: number; search: number };
  };
}

export interface SwapApplyResult {
  propagatedLessons: number;
  removedCalendarLessons: number;
  versionId: string;
  undo: SwapMove[];
}

/** The gateway's codes for a proposal it will not apply. */
export const SWAP_STALE = "SWAP_STALE";
export const SWAP_SPLITS_PARALLEL = "SWAP_SPLITS_PARALLEL";
export const SWAP_LOCKED = "SWAP_LOCKED";

/** "HH:MM" of minutes after midnight: the clock the apply is written in. */
export function clockOf(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

const slotBody = (slot: SwapSlot) => ({
  dayOfWeek: slot.dayOfWeek,
  startTime: clockOf(slot.startMinutes),
  endTime: clockOf(slot.endMinutes),
});

/** The moves as the apply route takes them: clocks, not minutes. */
export const applyBody = (lessonId: string, moves: readonly SwapMove[], versionName?: string) => ({
  lessonId,
  moves: moves.map((move) => ({ lessonId: move.lessonId, from: slotBody(move.from), to: slotBody(move.to) })),
  ...(versionName ? { versionName } : {}),
});

export function useSwaps() {
  const queryClient = useQueryClient();

  /*
   * A mutation, not a query, although nothing is written: the answer is about
   * the timetable as it stands when the schemaläggare asks, and as a query it
   * would be cached under a key and offered again after the timetable moved.
   */
  const suggest = useMutation({
    mutationFn: (body: { lessonId: string; limit?: number }) =>
      api.post<SwapSuggestion>("/api/v1/swaps/suggest", body),
  });

  /*
   * Apply moves lessons in the template and the future calendar lessons made
   * from them, and takes a version first: every list that shows where a lesson
   * stands is out of date afterwards (as after the room optimisation).
   */
  const apply = useMutation({
    mutationFn: (body: ReturnType<typeof applyBody>) =>
      api.post<SwapApplyResult>("/api/v1/swaps/apply", body),
    onSuccess: () => {
      for (const key of [
        "masterLessons",
        "scheduleVersions",
        "calendarLessons",
        "teacherLessons",
        "dayLessons",
        "teacherAbsenceLessons",
        "lesson",
      ]) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
  });

  return { suggest, apply };
}
