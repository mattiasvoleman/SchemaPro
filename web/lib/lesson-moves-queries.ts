"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { LessonMoves, MovablePupil, MoveCandidates, MoveResult } from "@/lib/lesson-moves";

/**
 * Elevens lektion för dagen's reads and writes, all through the gateway
 * (src/lesson-moves): the table is the API's role's alone.
 *
 * A module of its own, as lib/lesson-log-queries.ts is, imported only by the
 * pages that move a pupil or list the moves: a hook in lib/queries.ts would
 * go into every route that imports that one, and the core-tier routes sit
 * within a few KB of their limit.
 */

export const LESSON_MOVE_KEYS = {
  all: ["lessonMoves"] as const,
  lesson: (lessonId: string) => ["lessonMoves", "lesson", lessonId] as const,
  pupils: (lessonId: string) => ["lessonMoves", "pupils", lessonId] as const,
  candidates: (lessonId: string, studentId: string) => ["lessonMoves", "candidates", lessonId, studentId] as const,
};

const BASE = "/api/v1/lesson-moves";

/** The pupils this lesson lost to a parallel lesson and those it gained, for the register. */
export function useLessonMoves(lessonId: string) {
  return useQuery({
    queryKey: LESSON_MOVE_KEYS.lesson(lessonId),
    queryFn: () => api.get<LessonMoves>(`${BASE}/lessons/${lessonId}`),
    // A teacher not on the lesson meets a 403 on the register itself; no retry for an answer.
    retry: false,
  });
}

/** The pupils of the lesson the caller may move. Read when the dialog opens. */
export function useMovablePupils(lessonId: string, enabled: boolean) {
  return useQuery({
    queryKey: LESSON_MOVE_KEYS.pupils(lessonId),
    enabled,
    retry: false,
    queryFn: async () => (await api.get<{ students: MovablePupil[] }>(`${BASE}/lessons/${lessonId}/pupils`)).students,
  });
}

/** Where the pupil can go from the lesson, with the reason for each that they cannot. */
export function useMoveCandidates(lessonId: string, studentId: string | null) {
  return useQuery({
    queryKey: LESSON_MOVE_KEYS.candidates(lessonId, studentId ?? ""),
    enabled: studentId !== null,
    retry: false,
    // A candidate list is a moment's: the headcount of a lesson changes as others are moved.
    staleTime: 0,
    queryFn: () => api.get<MoveCandidates>(`${BASE}/lessons/${lessonId}/candidates?${new URLSearchParams({ studentId: studentId! }).toString()}`),
  });
}

/** What a move or Ångra changes for everyone who reads the lessons' lists, the family's week included. */
function useAfterMove() {
  const client = useQueryClient();
  return async () => {
    await Promise.all(
      [["lessonMoves"], ["lessonRoster"], ["lessonAttendance"], ["lessonReportedAbsences"], ["lessonLog"], ["familySchedule"], ["dayLessons"], ["teacherLessons"], ["calendarLessons"]].map(
        (queryKey) => client.invalidateQueries({ queryKey }),
      ),
    );
  };
}

export function useMovePupil() {
  const after = useAfterMove();
  return useMutation({
    mutationFn: (input: { studentId: string; fromLessonId: string; toLessonId: string }) => api.post<MoveResult>(BASE, input),
    onSuccess: after,
  });
}

export function useUndoMove() {
  const after = useAfterMove();
  return useMutation({
    mutationFn: (moveId: string) => api.delete<void>(`${BASE}/${moveId}`),
    onSuccess: after,
  });
}
