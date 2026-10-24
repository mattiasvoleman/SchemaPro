"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type {
  ClassBook,
  HandedOverLesson,
  LessonLogEntry,
  LessonLogLesson,
  LessonLogText,
  SubstituteNoteText,
} from "@/lib/lesson-log";

/**
 * Lektionslogg's reads and writes, all through the gateway (src/lesson-log):
 * the tables are the API's role's alone, so PostgREST reads none of them.
 *
 * A module of its own, imported only by the pages that show a log — the
 * lesson page, the klassbok, /teacher/franvaro — and the lazy list on
 * /student: a hook in lib/queries.ts would put it into every route that
 * imports that one, and the core-tier routes sit within a few KB of 170.
 */

export const LESSON_LOG_KEYS = {
  all: ["lessonLog"] as const,
  lesson: (lessonId: string) => ["lessonLog", "lesson", lessonId] as const,
  range: (from: string, to: string) => ["lessonLog", "range", from, to] as const,
  handedOver: (from: string, to: string) => ["lessonLog", "handedOver", from, to] as const,
  classBook: (groupId: string, from: string, to: string) => ["lessonLog", "classBook", groupId, from, to] as const,
};

/** One lesson for its page: the log, the note when the caller may read it, and what the caller may change. */
export function useLessonLogLesson(lessonId: string) {
  return useQuery({
    queryKey: LESSON_LOG_KEYS.lesson(lessonId),
    queryFn: () => api.get<LessonLogLesson>(`/api/v1/lesson-logs/lessons/${lessonId}`),
    // A 403 or 404 is an answer, not a hiccup to retry.
    retry: false,
    // Read when the page opens, after a save and on "Läs in igen", never
    // behind the teacher's back: the forms are keyed on the version they
    // read, and a refetch on focus that found a colleague's newer version
    // would reset a form mid-sentence. A save meets that version as a 409.
    refetchOnWindowFocus: false,
  });
}

/** The lessons the teacher handed over for an absence, with whether a note is left. */
export function useHandedOverLessons(from: string, to: string) {
  return useQuery({
    queryKey: LESSON_LOG_KEYS.handedOver(from, to),
    staleTime: 60 * 1000,
    queryFn: async () =>
      (
        await api.get<{ lessons: HandedOverLesson[] }>(
          `/api/v1/lesson-logs/handed-over?${new URLSearchParams({ from, to }).toString()}`,
        )
      ).lessons,
  });
}

/** The caller's own lessons' logs over a range: a pupil's, or a teacher's with their notes. */
export function useLessonLogEntries(from: string, to: string, enabled = true) {
  return useQuery({
    queryKey: LESSON_LOG_KEYS.range(from, to),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 60 * 1000,
    queryFn: async () =>
      (await api.get<{ entries: LessonLogEntry[] }>(`/api/v1/lesson-logs?${new URLSearchParams({ from, to }).toString()}`))
        .entries,
  });
}

/** The klassbok of a class over a period; off until a class is chosen. */
export function useClassBook(groupId: string | null, from: string, to: string, enabled = true) {
  return useQuery({
    queryKey: LESSON_LOG_KEYS.classBook(groupId ?? "", from, to),
    enabled: enabled && groupId !== null,
    placeholderData: keepPreviousData,
    retry: false,
    queryFn: () =>
      api.get<ClassBook>(`/api/v1/lesson-logs/class-book?${new URLSearchParams({ groupId: groupId!, from, to }).toString()}`),
  });
}

/** Saves the whole log against the one the form read (`basis`); both fields empty removes it. */
export function useSaveLessonLog(lessonId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { topic: string | null; homework: string | null; basis: string | null }) =>
      api.put<{ log: LessonLogText | null }>(`/api/v1/lesson-logs/lessons/${lessonId}`, input),
    onSuccess: ({ log }) => {
      client.setQueryData<LessonLogLesson>(LESSON_LOG_KEYS.lesson(lessonId), (current) => (current ? { ...current, log } : current));
      // The week's lists and every klassbok that may show it.
      void client.invalidateQueries({ queryKey: ["lessonLog", "range"] });
      void client.invalidateQueries({ queryKey: ["lessonLog", "classBook"] });
    },
  });
}

/** Saves the note to the substitute against the one the form read; empty removes it. */
export function useSaveSubstituteNote(lessonId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { body: string | null; basis: string | null }) =>
      api.put<{ note: SubstituteNoteText | null }>(`/api/v1/lesson-logs/lessons/${lessonId}/substitute-note`, input),
    onSuccess: ({ note }) => {
      client.setQueryData<LessonLogLesson>(LESSON_LOG_KEYS.lesson(lessonId), (current) => (current ? { ...current, note } : current));
      void client.invalidateQueries({ queryKey: ["lessonLog", "range"] });
      void client.invalidateQueries({ queryKey: ["lessonLog", "handedOver"] });
    },
  });
}

/**
 * Removes a log from the klassbok: the administrator who writes drift
 * clearing what should not stand. The same PUT with both fields empty.
 */
export function useRemoveLessonLog() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (lessonId: string) =>
      api.put<{ log: LessonLogText | null }>(`/api/v1/lesson-logs/lessons/${lessonId}`, { topic: null, homework: null }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: LESSON_LOG_KEYS.all });
    },
  });
}
