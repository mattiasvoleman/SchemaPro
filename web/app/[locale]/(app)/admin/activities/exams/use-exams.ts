"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type {
  ApplyInput,
  ApplyResult,
  CreateExamInput,
  Exam,
  ExamInput,
  ExamProposal,
  ExamRoom,
  ExamSettings,
  ExamSettingsInput,
  InvigilatorCounterRow,
} from "@/lib/exam-types";
import { AFTER_CANCELLATION } from "@/lib/publication-keys";

/*
 * Provplanering (src/exams/exams.controller.ts), beside the one page that uses
 * it (lib/year-keys.ts says why). The keys are kept here and not in
 * lib/publication-keys.ts: that file is read by other pages' routes.
 *
 * The proposal is a MUTATION, as the activity's preview is: it belongs to a
 * button, it takes up to a minute, and nothing may ask it again behind the
 * administrator's back. What it writes is the reason on each exam it could not
 * lay (Exam.lastReason), so the list is read again after it.
 */

const EXAMS_KEY = ["exams"] as const;
const SETTINGS_KEY = [...EXAMS_KEY, "settings"] as const;
const ROOMS_KEY = [...EXAMS_KEY, "rooms"] as const;

export function useExamSettings() {
  return useQuery({ queryKey: SETTINGS_KEY, retry: false, queryFn: () => api.get<ExamSettings>("/api/v1/exams/settings") });
}

export function useSaveExamSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ExamSettingsInput) => api.put<ExamSettings>("/api/v1/exams/settings", input),
    onSuccess: (saved) => queryClient.setQueryData(SETTINGS_KEY, saved),
  });
}

export function useExamRooms() {
  return useQuery({ queryKey: ROOMS_KEY, retry: false, queryFn: () => api.get<ExamRoom[]>("/api/v1/exams/rooms") });
}

/** Marks a room as a skrivsal with its seats, or changes them. The answer is the whole list. */
export function useMarkRoom() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ roomId, seats }: { roomId: string; seats: number }) =>
      api.put<ExamRoom[]>(`/api/v1/exams/rooms/${roomId}`, { seats }),
    onSuccess: (rooms) => queryClient.setQueryData(ROOMS_KEY, rooms),
  });
}

export function useUnmarkRoom() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (roomId: string) => api.delete<ExamRoom[]>(`/api/v1/exams/rooms/${roomId}`),
    onSuccess: (rooms) => queryClient.setQueryData(ROOMS_KEY, rooms),
  });
}

export function useExams(academicYearId: string) {
  return useQuery({
    queryKey: [...EXAMS_KEY, "list", academicYearId],
    retry: false,
    queryFn: () => api.get<Exam[]>(`/api/v1/exams?academicYearId=${encodeURIComponent(academicYearId)}`),
  });
}

export function useExamCounter(academicYearId: string) {
  return useQuery({
    queryKey: [...EXAMS_KEY, "counter", academicYearId],
    retry: false,
    queryFn: () =>
      api.get<InvigilatorCounterRow[]>(`/api/v1/exams/counter?academicYearId=${encodeURIComponent(academicYearId)}`),
  });
}

/** What a change to the exams makes stale: the list and, once one is laid or taken away, the counter. */
function useAfterExams() {
  const queryClient = useQueryClient();
  return (calendar: boolean) => {
    void queryClient.invalidateQueries({ queryKey: EXAMS_KEY });
    if (!calendar) return;
    // A laid exam is an activity: lessons cancelled, replacement lessons, credits, room bookings.
    for (const queryKey of [...AFTER_CANCELLATION, ["scheduleActivities"], ["roomBookings"]]) {
      void queryClient.invalidateQueries({ queryKey });
    }
  };
}

export function useCreateExam() {
  const after = useAfterExams();
  return useMutation({
    mutationFn: (input: CreateExamInput) => api.post<Exam>("/api/v1/exams", input),
    onSettled: () => after(false),
  });
}

export function useChangeExam() {
  const after = useAfterExams();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ExamInput }) => api.patch<Exam>(`/api/v1/exams/${id}`, input),
    onSettled: () => after(false),
  });
}

export function useRemoveExam() {
  const after = useAfterExams();
  return useMutation({
    mutationFn: (id: string) => api.delete<{ removed: true }>(`/api/v1/exams/${id}`),
    onSettled: () => after(false),
  });
}

/** What taking a plan away answers: the lessons that could not come back because another lesson or booking holds their room. */
export interface UnplanResult {
  removed: true;
  skippedRoomTaken?: Array<{ lessonId: string; date: string; roomId: string; by: "LESSON" | "BOOKING" }>;
  /** Lessons the schedule moved after the exam was laid, carried to their new time that week instead of put back at the old one. */
  relocated?: Array<{ lessonId: string; from: string; to: string }>;
}

/** "Ta bort planeringen": the exam goes back to not laid, its lessons come back. */
export function useUnplanExam() {
  const after = useAfterExams();
  return useMutation({
    mutationFn: (id: string) => api.post<UnplanResult>(`/api/v1/exams/${id}/unplan`),
    onSettled: () => after(true),
  });
}

/** `examIds` left out plans every exam of the year that is not laid. Nothing is laid by it. */
export function usePlanExams() {
  const after = useAfterExams();
  return useMutation({
    mutationFn: ({ academicYearId, examIds }: { academicYearId: string; examIds?: string[] }) =>
      api.post<ExamProposal>("/api/v1/exams/plan", { academicYearId, ...(examIds ? { examIds } : {}) }),
    onSettled: () => after(false),
  });
}

export function useApplyExams() {
  const after = useAfterExams();
  return useMutation({
    mutationFn: (input: ApplyInput) => api.post<ApplyResult>("/api/v1/exams/plan/apply", input),
    onSettled: () => after(true),
  });
}
