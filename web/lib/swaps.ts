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
  /** MAKE_ROOM (E5a, Gör plats): what had to move for a lesson to stand at a time. */
  kind: "SWAP" | "CHAIN" | "MAKE_ROOM";
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
  /** MAKE_ROOM: the level of each lesson that moves, by lesson id: 0 is the picked one, 1 what stood in its way, and so on. */
  levels?: Record<string, number>;
  /** MAKE_ROOM: the deepest level. */
  depth?: number;
  /**
   * MAKE_ROOM for a lesson that stands nowhere (a brick, a lesson on the tray): where it is laid once the moves have made room. It is not
   * among `moves`, which are the lessons that stand and have to go.
   */
  lay?: {
    lessonId: string | null;
    subjectName: string;
    groupName: string;
    teacherId: string | null;
    coTeacherId: string | null;
    roomId: string | null;
    slot: SwapSlot;
  };
}

export interface SwapSuggestion {
  lessonId: string;
  academicYearId: string;
  unit: { lessonIds: string[]; links: ParallelLink[] };
  selectedLocked: boolean;
  proposals: SwapProposal[];
  immovable?: "PARKED" | "NOT_PLACED" | "PLACED" | "EXEMPT";
  /** Gör plats: what the asked time holds, and why nothing could be offered when that is known beforehand. */
  makeRoom?: {
    target: SwapSlot;
    blockers: Array<{ lessonIds: string[]; subjectName: string; groupName: string; isLocked: boolean }>;
    stuck?: "CLOSED" | "LOCKED_IN_THE_WAY" | "TOO_MANY";
    depth: number;
    landingsCut: boolean;
  };
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

/** Byt plats: the judge's reason a lesson cannot stand where the other of a swap of two stands. */
export interface SwapPairRefusal {
  lessonId: string;
  reason: string;
  params: Record<string, string | number>;
  text: string;
}

/** Byt plats: two marked lessons that each take the other's start. */
export interface SwapPair {
  academicYearId: string;
  ok: boolean;
  proposal?: SwapProposal;
  refusals: SwapPairRefusal[];
  /** No swap to judge: a lesson on the tray or written from a förläggning, lessons that move as one, or stand at one start. */
  immovable?: "PARKED" | "PLACED" | "NOT_PLACED" | "SAME_UNIT" | "SAME_PLACE";
  immovableLessonId?: string;
}

export interface SwapApplyResult {
  propagatedLessons: number;
  removedCalendarLessons: number;
  versionId: string;
  undo: SwapMove[];
  /** Låset vid en flytt (E4): the swap locked the lessons it moved that were not locked; the undo takes the lock off again. */
  lockedByMove?: true;
  lockedLessonIds?: string[];
  /**
   * Undantag med flit (E1b): a moved lesson that stood against a rule of the board on purpose lost the exemption, which is for the time it was given
   * for. `rules` are the names, comma-joined. Ångra moves the lesson back and does not bring the exemption back.
   */
  exemptionsEnded?: Array<{ lessonId: string; rules: string }>;
  /**
   * Att lägga in the same transaction (E5a, g514 L-7): the lesson a `lay` of the request made, or the parked lesson it moved back. The gateway's
   * `apply` answers it only for a request that carried a `lay`, which the web does not send yet (a brick is laid by `POST /board-tray/lay`).
   */
  laid?: unknown;
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

/**
 * The moves as the apply route takes them: clocks, not minutes. `alsoPicked` names the other lesson of a Byt plats (the person's own choice,
 * which may be locked); `forBrick` says the moves make room for a lesson that stands nowhere, so that no lesson of them is the picked one.
 */
export const applyBody = (
  lessonId: string | null,
  moves: readonly SwapMove[],
  versionName?: string,
  also: { alsoPicked?: readonly string[]; forBrick?: boolean } = {},
) => ({
  ...(lessonId !== null ? { lessonId } : {}),
  moves: moves.map((move) => ({ lessonId: move.lessonId, from: slotBody(move.from), to: slotBody(move.to) })),
  ...(versionName ? { versionName } : {}),
  ...(also.alsoPicked && also.alsoPicked.length > 0 ? { alsoPicked: [...also.alsoPicked] } : {}),
  ...(also.forBrick ? { forBrick: true } : {}),
});

/** What Gör plats asks: a lesson (or a brick, which is no lesson yet) at a day and clock. */
export interface MakeRoomAsk {
  lessonId?: string;
  brick?: Record<string, unknown>;
  limit?: number;
  makeRoom?: { dayOfWeek: number; startTime: string; depth?: number };
}

export function useSwaps() {
  const queryClient = useQueryClient();

  /*
   * A mutation, not a query, although nothing is written: the answer is about
   * the timetable as it stands when the schemaläggare asks, and as a query it
   * would be cached under a key and offered again after the timetable moved.
   */
  const suggest = useMutation({
    mutationFn: (body: MakeRoomAsk) => api.post<SwapSuggestion>("/api/v1/swaps/suggest", body),
  });

  /*
   * Byt plats: two marked lessons, each to take the other's start. Also a mutation and for the same reason: the answer is about the timetable
   * as it stands when the schemaläggare asks.
   */
  const pair = useMutation({
    mutationFn: (body: { lessonId: string; otherLessonId: string }) => api.post<SwapPair>("/api/v1/swaps/pair", body),
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

  return { suggest, pair, apply };
}
