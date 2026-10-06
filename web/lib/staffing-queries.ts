"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { STAFFING_KEYS } from "@/lib/staffing-keys";
import type {
  EmploymentBody,
  PolicyBody,
  QualificationItemBody,
} from "@/lib/staffing-forms";
import type { TeacherLoadReport, UnstaffedRequirement } from "@/lib/teacher-load";
import type { StaffingPolicy, TeacherEmployment, TeacherQualification } from "@/lib/types";

// ---------------------------------------------------------------------------
// Tjänstefördelning (src/staffing)
//
// A module of its own, not a section of lib/queries.ts, for the bundle. Every
// client page imports lib/queries.ts, so whatever sits in it lands in every
// route's chunk graph: these eight hooks there put 0.3KB gzipped on the
// guardian dashboard and the timetable, two pages that never call them, and
// pushed both past budgets they sat on to the decimal (measured 2026-10-06:
// 170.2 -> 169.9KB and 190.3 -> 190.0KB own JS when the hooks left). Here they
// are paid for by the three admin pages and the three cards that read them,
// in chunks only those routes reference. The query keys
// are shared through lib/staffing-keys.ts, because useImportCsv over there has
// to invalidate them without importing this file.
//
// Read through the API rather than Supabase, all of it. Three reasons, one per
// table: the policy GET is SCHOOL_ADMIN-only on the gateway and its validation
// (reglerad inside årsarbetstiden) lives on the endpoint that writes it; the
// employments are HR data with a teacher_own RLS arm, and the gateway already
// cuts a TEACHER's list down to their own row, so one door is enough; and the
// load report is COMPUTED, in one RLS transaction over five tables, which is
// not a thing PostgREST can answer. The qualifications could be read from
// Supabase (staff_select), but a page that already holds the API client for
// the other three gains nothing from a second door for the fourth.
// ---------------------------------------------------------------------------

export function useStaffingPolicy() {
  return useQuery({
    queryKey: STAFFING_KEYS.policy,
    queryFn: async () =>
      (await api.get<StaffingPolicy | null>("/api/v1/staffing-policy")) ?? null,
  });
}

/**
 * PUT replaces the row whole, so the body carries every field the card shows
 * and the report is refetched: a changed riktmärke moves every teacher's
 * status, and a matrix left on the old numbers would be the page lying
 * about the thing the admin just changed.
 */
export function useSaveStaffingPolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: PolicyBody) => api.put<StaffingPolicy>("/api/v1/staffing-policy", body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: STAFFING_KEYS.policy });
      void queryClient.invalidateQueries({ queryKey: STAFFING_KEYS.load });
    },
  });
}

export function useTeacherEmployments(academicYearId: string | null) {
  return useQuery({
    queryKey: [...STAFFING_KEYS.employments, academicYearId],
    enabled: academicYearId !== null,
    queryFn: () =>
      api.get<TeacherEmployment[]>(
        `/api/v1/teacher-employments?academicYearId=${encodeURIComponent(academicYearId!)}`,
      ),
  });
}

/**
 * A post is written and taken away by TEACHER and YEAR, never by row id — the
 * gateway offers no collection to post into, like teacher-work-rules. The
 * teacher sits in the path and the year in the query string; the body is the
 * DTO's six fields and nothing else, because the ValidationPipe runs with
 * forbidNonWhitelisted and a stray userId is a 400 with nothing wrong in it.
 */
export function useTeacherEmploymentActions() {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: STAFFING_KEYS.employments });
    void queryClient.invalidateQueries({ queryKey: STAFFING_KEYS.load });
  };
  const save = useMutation({
    mutationFn: ({
      userId,
      academicYearId,
      ...body
    }: { userId: string; academicYearId: string } & EmploymentBody) =>
      api.put<TeacherEmployment>(
        `/api/v1/teacher-employments/${userId}?academicYearId=${encodeURIComponent(academicYearId)}`,
        body,
      ),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: ({ userId, academicYearId }: { userId: string; academicYearId: string }) =>
      api.delete(
        `/api/v1/teacher-employments/${userId}?academicYearId=${encodeURIComponent(academicYearId)}`,
      ),
    onSuccess: invalidate,
  });
  return { save, remove };
}

/** The school's qualifications, or one teacher's when a userId is given. */
export function useTeacherQualifications(userId?: string | null) {
  return useQuery({
    queryKey: [...STAFFING_KEYS.qualifications, userId ?? "all"],
    queryFn: () =>
      api.get<TeacherQualification[]>(
        userId
          ? `/api/v1/teacher-qualifications?userId=${encodeURIComponent(userId)}`
          : "/api/v1/teacher-qualifications",
      ),
  });
}

/**
 * Replaces the teacher's whole list — the pattern of PUT /student-groups/:id/
 * members. Every cache under the prefix is refetched, the school-wide one the
 * requirements dialog reads as well as the one teacher's.
 */
export function useReplaceTeacherQualifications() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, items }: { userId: string; items: QualificationItemBody[] }) =>
      api.put<TeacherQualification[]>(`/api/v1/teacher-qualifications/${userId}`, { items }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: STAFFING_KEYS.qualifications });
      void queryClient.invalidateQueries({ queryKey: STAFFING_KEYS.load });
    },
  });
}

export interface TeacherLoadReportResponse extends TeacherLoadReport {
  academicYearId: string;
  horizon: "planned";
  year: { startDate: string; endDate: string };
}

/**
 * The report for one läsår, computed by the gateway. Only the planned horizon
 * exists in Fas 1, so no parameter for it: the day a second one is added, the
 * key below gains it and nothing cached under the old shape survives.
 */
export function useStaffingLoad(academicYearId: string | null) {
  return useQuery({
    queryKey: [...STAFFING_KEYS.load, academicYearId],
    enabled: academicYearId !== null,
    queryFn: () =>
      api.get<TeacherLoadReportResponse>(
        `/api/v1/staffing/load?academicYearId=${encodeURIComponent(academicYearId!)}&horizon=planned`,
      ),
  });
}

export function useUnstaffedRequirements(academicYearId: string | null) {
  return useQuery({
    queryKey: [...STAFFING_KEYS.unstaffed, academicYearId],
    enabled: academicYearId !== null,
    queryFn: () =>
      api.get<UnstaffedRequirement[]>(
        `/api/v1/staffing/unstaffed?academicYearId=${encodeURIComponent(academicYearId!)}`,
      ),
  });
}
