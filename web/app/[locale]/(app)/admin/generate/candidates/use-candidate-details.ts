"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { OriginMaster } from "@/lib/candidates/lessons";
import type {
  CandidateApplyResult,
  CandidateCheck,
  CandidateLesson,
  PublishMode,
} from "@/lib/candidates/types";
import { createClient } from "@/utils/supabase/client";
import { CANDIDATES_KEY, CANDIDATES_OVERVIEW_KEY } from "../use-schedule-candidates";

/*
 * The compare page's reads and writes, beside it for the reason
 * ../use-schedule-candidates.ts gives: nothing outside /admin/generate/
 * candidates calls these, and lib/queries.ts is on every route's bill.
 */

const CHECK_KEY = [...CANDIDATES_KEY, "check"] as const;
const LESSONS_KEY = [...CANDIDATES_KEY, "lessons"] as const;

/**
 * GET candidates/runs/:runId/check: the batch against today's basis, and the
 * publication mode the apply must name. One basis rebuild on the server per
 * call and throttled to ten a minute, so it is read once per run and kept
 * (staleTime Infinity); the apply and a refresh ask again by invalidating it.
 */
export function useCandidateCheck(runId: string | null) {
  return useQuery({
    queryKey: [...CHECK_KEY, runId],
    enabled: runId !== null,
    staleTime: Infinity,
    retry: false,
    queryFn: () => api.get<CandidateCheck>(`/api/v1/optimization/candidates/runs/${runId}/check`),
  });
}

export interface CandidateLessonsState {
  /** The lessons of every candidate read so far, by candidate id. */
  byId: ReadonlyMap<string, CandidateLesson[]>;
  /** Candidates whose read failed with nothing in hand. */
  failed: ReadonlySet<string>;
}

/** Nothing read yet: one value, so a page deriving weeks from it is not handed a new map each render. */
const NOTHING_READ: CandidateLessonsState = { byId: new Map(), failed: new Set() };

const lessonsOf = (id: string) => api.get<CandidateLesson[]>(`/api/v1/optimization/candidates/${id}/lessons`);

/**
 * GET candidates/:id/lessons for each candidate. A stored candidate never
 * changes — a refresh makes new ones — so the batch is read once.
 *
 * ONE query reading them all, not useQueries: react-query is in the chunk
 * every route shares, and the first page to call useQueries makes Turbopack
 * re-slice its shared internals there, +0,2 KB on every signed-in route —
 * measured on this route's first build, /admin/requirements 189,9 → 190,1
 * of 190 (and see use-year-activation.ts, lib/year-timplan-queries.ts). Each
 * read still stands alone: it is tried twice, the app's retry: 1, and one
 * that fails both times costs that candidate its figures, not the batch.
 *
 * The answer is one map, rebuilt only when the batch's reads are: every
 * week, every håltimme figure and the moved list are derived from it, and a
 * new map each render would have them all computed again.
 */
export function useCandidateLessons(candidateIds: readonly string[]): CandidateLessonsState {
  const key = candidateIds.join(",");
  const { data } = useQuery({
    queryKey: [...LESSONS_KEY, key],
    enabled: key !== "",
    staleTime: Infinity,
    queryFn: async (): Promise<CandidateLessonsState> => {
      const ids = key.split(",");
      const results = await Promise.allSettled(ids.map((id) => lessonsOf(id).catch(() => lessonsOf(id))));
      const byId = new Map<string, CandidateLesson[]>();
      const failed = new Set<string>();
      results.forEach((result, index) => {
        if (result.status === "fulfilled") byId.set(ids[index]!, result.value);
        else failed.add(ids[index]!);
      });
      return { byId, failed };
    },
  });
  return data ?? NOTHING_READ;
}

/** PostgREST answers at most this many rows; the read pages past it. */
const PAGE_SIZE = 1000;

/**
 * The year's grundschema with who owns each lesson (isGenerated), which the
 * grid's own read (useMasterLessons) does not select: a candidate's week is
 * the preserved lessons plus the candidate's, and only this column says
 * which lessons are preserved.
 *
 * Keyed under "masterLessons", so every write that refreshes the grid —
 * Generera, a version restore, an apply here — refreshes this too.
 */
export function useOriginMasters(academicYearId: string | null) {
  return useQuery({
    queryKey: ["masterLessons", academicYearId, "origin"],
    enabled: academicYearId !== null,
    queryFn: async (): Promise<OriginMaster[]> => {
      const supabase = createClient();
      type Row = Omit<OriginMaster, "extraGroupIds" | "studentIds"> & {
        extraGroups: Array<{ studentGroupId: string }>;
        participants: Array<{ studentId: string }>;
      };
      const rows: Row[] = [];
      // Ordered by a unique column last, so no row moves between pages.
      for (let page = 0; page < 50; page++) {
        const from = page * PAGE_SIZE;
        const { data, error } = await supabase
          .from("MasterLessons")
          .select(
            "id, academicYearId, subjectId, studentGroupId, teacherId, coTeacherId, roomId, dayOfWeek, startTime, endTime, isLocked, isParked, isGenerated, recurrence, startDate, endDate, extraGroups:MasterLessonGroups(studentGroupId), participants:MasterLessonStudents(studentId)",
          )
          .eq("academicYearId", academicYearId!)
          .order("dayOfWeek")
          .order("startTime")
          .order("id")
          .range(from, from + PAGE_SIZE - 1);
        if (error) throw new Error(error.message);
        const batch = (data ?? []) as unknown as Row[];
        rows.push(...batch);
        if (batch.length < PAGE_SIZE) break;
      }
      return rows.map(({ extraGroups, participants, ...lesson }) => ({
        ...lesson,
        extraGroupIds: (extraGroups ?? []).map((entry) => entry.studentGroupId),
        studentIds: (participants ?? []).map((entry) => entry.studentId),
      }));
    },
  });
}

/**
 * POST candidates/:id/apply. Whatever the outcome everything the write can
 * have touched is read again: the grid and this page's draft, the meals, the
 * versions (a safety version was saved), the calendar in DIRECT, and the
 * batch and its check — a refused apply means somebody else wrote, and the
 * page should show that too.
 */
export function useApplyCandidate() {
  const queryClient = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: ({ candidateId, expectedMode }: { candidateId: string; expectedMode: PublishMode }) =>
      api.post<CandidateApplyResult>(`/api/v1/optimization/candidates/${candidateId}/apply`, { expectedMode }),
    onSettled: () => {
      for (const queryKey of [
        ["masterLessons"],
        ["lunch-sittings"],
        ["scheduleVersions"],
        ["calendarLessons"],
        ["teacherLessons"],
        CANDIDATES_OVERVIEW_KEY,
        CHECK_KEY,
      ]) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
  });
}

/**
 * DELETE candidates?academicYearId=: the year's finished runs go, an active
 * one is asked to stop (CANCELLING) and stops at its next step.
 */
export function useDiscardCandidates() {
  const queryClient = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: (academicYearId: string) =>
      api.delete<void>(`/api/v1/optimization/candidates?academicYearId=${encodeURIComponent(academicYearId)}`),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: CANDIDATES_OVERVIEW_KEY });
    },
  });
}
