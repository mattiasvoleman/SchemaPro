"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { STAFFING_KEYS } from "@/lib/staffing-keys";
import type { DutyBody } from "@/lib/duty-forms";
import type {
  EmploymentBody,
  PolicyBody,
  QualificationItemBody,
} from "@/lib/staffing-forms";
import type { TeacherLoadReport, UnstaffedRequirement } from "@/lib/teacher-load";
import type {
  StaffingPolicy,
  StaffingWarning,
  TeacherDuty,
  TeacherEmployment,
  TeacherQualification,
  TeacherSuggestions,
  TeachingRequirement,
} from "@/lib/types";

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
      // A changed tolerance moves every candidate's wouldExceed.
      void queryClient.invalidateQueries({ queryKey: STAFFING_KEYS.suggestions });
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
    void queryClient.invalidateQueries({ queryKey: STAFFING_KEYS.history });
    void queryClient.invalidateQueries({ queryKey: STAFFING_KEYS.load });
    // A target moves every kvar and wouldExceed in a cached ranking.
    void queryClient.invalidateQueries({ queryKey: STAFFING_KEYS.suggestions });
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
      // A behörighet moves a candidate's badge and tier in a cached ranking.
      void queryClient.invalidateQueries({ queryKey: STAFFING_KEYS.suggestions });
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

// ---------------------------------------------------------------------------
// Fas 2: the matrix as a workspace
// ---------------------------------------------------------------------------

/**
 * Who could take one timplanspost, ranked by the gateway (behörighet for the
 * group's grades, already teaches the group, room left after the row). Only
 * fetched when a row's "Föreslå lärare" is opened: the ranking reads the
 * whole year's load, and a page of forty unstaffed rows must not ask forty
 * times on load.
 */
export function useSuggestTeachers(requirementId: string | null) {
  return useQuery({
    queryKey: [...STAFFING_KEYS.suggestions, requirementId],
    enabled: requirementId !== null,
    queryFn: () =>
      api.get<TeacherSuggestions>(
        `/api/v1/staffing/suggest-teachers?requirementId=${encodeURIComponent(requirementId!)}`,
      ),
  });
}

/** A saved timplanspost, with what the policy's WARN mode had to say about it. */
export type StaffedRequirement = TeachingRequirement & { warnings: StaffingWarning[] };

/**
 * Sets (or clears) a timplanspost's lead teacher — the workspace's one write.
 *
 * PATCH /teaching-requirements/:id with `teacherId` alone, so nothing else on
 * the row is touched; the gateway runs the policy's two checks inside the
 * write's own transaction. WARN comes back as `warnings` on the saved row,
 * REFUSE as a 409 ApiError whose `code` and `params` name the refusal —
 * the caller renders both through the engine catalogue.
 *
 * Every reader of the row is refreshed: the timplan's own matrix (the
 * ["requirements"] prefix lives in lib/queries.ts), the load report and the
 * unstaffed list, and every cached suggestion, because taking a row changes
 * the remaining minutes of the teacher who took it.
 */
export function useAssignTeacher() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ requirementId, teacherId }: { requirementId: string; teacherId: string | null }) =>
      api.patch<StaffedRequirement>(`/api/v1/teaching-requirements/${requirementId}`, { teacherId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["requirements"] });
      void queryClient.invalidateQueries({ queryKey: STAFFING_KEYS.load });
      void queryClient.invalidateQueries({ queryKey: STAFFING_KEYS.unstaffed });
      void queryClient.invalidateQueries({ queryKey: STAFFING_KEYS.suggestions });
    },
  });
}

/**
 * A teacher's uppdrag for one läsår. The gateway answers a TEACHER with their
 * own only (and 403s a colleague's id), so the same hook serves the drawer,
 * the people page and the teacher's own view.
 */
export function useTeacherDuties(academicYearId: string | null, userId?: string | null) {
  return useQuery({
    queryKey: [...STAFFING_KEYS.duties, academicYearId, userId ?? "all"],
    enabled: academicYearId !== null,
    queryFn: () =>
      api.get<TeacherDuty[]>(
        `/api/v1/teacher-duties?academicYearId=${encodeURIComponent(academicYearId!)}${
          userId ? `&userId=${encodeURIComponent(userId)}` : ""
        }`,
      ),
  });
}

/**
 * Write, change and remove an uppdrag. A blocked slot travels in the same
 * body and the gateway writes its UNAVAILABLE constraint in the same
 * transaction, so the constraints list is refreshed with the duties — the
 * tillgänglighet page would otherwise show the old slot until reloaded.
 */
export function useTeacherDutyActions() {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: STAFFING_KEYS.duties });
    void queryClient.invalidateQueries({ queryKey: STAFFING_KEYS.history });
    void queryClient.invalidateQueries({ queryKey: STAFFING_KEYS.load });
    void queryClient.invalidateQueries({ queryKey: STAFFING_KEYS.suggestions });
    void queryClient.invalidateQueries({ queryKey: ["constraints"] });
  };
  const create = useMutation({
    mutationFn: (body: { userId: string; academicYearId: string } & DutyBody) =>
      api.post<TeacherDuty>("/api/v1/teacher-duties", body),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string } & DutyBody) =>
      api.patch<TeacherDuty>(`/api/v1/teacher-duties/${id}`, body),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/teacher-duties/${id}`),
    onSuccess: invalidate,
  });
  return { create, update, remove };
}
