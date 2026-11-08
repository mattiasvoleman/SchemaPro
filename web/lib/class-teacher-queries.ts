"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type {
  AppointmentView,
  ChangeView,
  CheckRow,
  CreateChangeBody,
  DraftRowView,
  MineView,
  OpenTimesBody,
  OpenTimeView,
  PreviewBody,
  PreviewView,
  PublishOutcome,
  UpdateChangeBody,
  WeekView,
} from "@/lib/class-teacher";

// ---------------------------------------------------------------------------
// Klasslärarens schema, through the gateway (/api/v1/class-teacher for the
// klasslärare, /api/v1/class-teachers for the administrators). Not PostgREST:
// what a lesson may be changed to is the database's frame, asked by the
// gateway, and a publication runs as the administrator the appointment names.
//
// A module of its own, not lib/queries.ts: that one is shared by 37 routes and
// sits on the chunker's merge edge, so a hook added to it is a cost on all of
// them.
//
// SEVERAL PEOPLE EDIT AT ONCE (the klasslärare, a second klasslärare of the
// same class, the schemaläggare): the week and the check are read again every
// REFRESH_MS and when the window is looked at again, so each sees the other's
// drafts. A write never overwrites silently: a draft is created against the
// lesson's `version` and changed against its `rev`, and a stale one is a 409
// the page tells (lib/class-teacher.ts problemOf).
// ---------------------------------------------------------------------------

const ROOT = ["classTeacher"] as const;
export const CLASS_TEACHER_KEYS = {
  all: ROOT,
  mine: [...ROOT, "mine"] as const,
  /** Every week of a class: the prefix a write invalidates. */
  weeks: (classId: string) => [...ROOT, "week", classId] as const,
  week: (classId: string, from: string | null) => [...ROOT, "week", classId, from ?? "this"] as const,
  check: (classId: string) => [...ROOT, "check", classId] as const,
  preview: (classId: string, body: PreviewBody) => [...ROOT, "preview", classId, body] as const,
};

const ADMIN_ROOT = ["classTeacherAdmin"] as const;
export const CLASS_TEACHER_ADMIN_KEYS = {
  all: ADMIN_ROOT,
  appointments: (yearId: string) => [...ADMIN_ROOT, "appointments", yearId] as const,
  openTimes: (yearId: string) => [...ADMIN_ROOT, "openTimes", yearId] as const,
  settings: [...ADMIN_ROOT, "settings"] as const,
  drafts: [...ADMIN_ROOT, "drafts"] as const,
};

const BASE = "/api/v1/class-teacher";
const ADMIN = "/api/v1/class-teachers";

/** How often a page left open asks again, so that two people editing the same class see each other. */
export const REFRESH_MS = 45_000;

// ---------------------------------------------------------------------------
// The klasslärare
// ---------------------------------------------------------------------------

/** The classes the reader is klasslärare of, and whether the school lets them publish. */
export function useMine() {
  return useQuery({
    queryKey: CLASS_TEACHER_KEYS.mine,
    retry: false,
    queryFn: () => api.get<MineView>(`${BASE}/mine`),
  });
}

/**
 * A week of a class (`from` is any date in it; null is this week on the
 * school's clock). Moving to another week keeps the last one on screen, dimmed
 * by the page, instead of a blank.
 */
export function useWeek(classId: string | null, from: string | null) {
  return useQuery({
    queryKey: classId ? CLASS_TEACHER_KEYS.week(classId, from) : [...ROOT, "week", "none"],
    enabled: classId !== null,
    retry: false,
    placeholderData: keepPreviousData,
    refetchInterval: REFRESH_MS,
    refetchOnWindowFocus: true,
    queryFn: () => api.get<WeekView>(`${BASE}/classes/${classId}/week${from ? `?from=${from}` : ""}`),
  });
}

/**
 * Every waiting draft of the class, judged by the check the schemaläggare's
 * editor makes. Asked only while there are drafts (`enabled`): each answer
 * evaluates them all.
 */
export function useCheck(classId: string | null, enabled = true) {
  return useQuery({
    queryKey: classId ? CLASS_TEACHER_KEYS.check(classId) : [...ROOT, "check", "none"],
    enabled: classId !== null && enabled,
    retry: false,
    refetchInterval: REFRESH_MS,
    refetchOnWindowFocus: true,
    queryFn: () => api.get<CheckRow[]>(`${BASE}/classes/${classId}/check`),
  });
}

/**
 * A change tried and not written, for the conflicts to show while the
 * klasslärare edits. The CALLER debounces: it passes the body once it has stood
 * still (lib/use-debounced-value.ts), and null while the form is not sendable.
 * A query and not a mutation, so that an answer to an earlier body never lands
 * over a later one's, and the last answer stays on screen while the next
 * loads. Nothing is kept after the form closes.
 */
export function usePreview(classId: string, body: PreviewBody | null) {
  return useQuery({
    queryKey: body ? CLASS_TEACHER_KEYS.preview(classId, body) : [...ROOT, "preview", classId, "none"],
    enabled: body !== null,
    retry: false,
    gcTime: 0,
    staleTime: 0,
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => api.post<PreviewView>(`${BASE}/classes/${classId}/preview`, body, signal),
  });
}

export function useClassTeacherActions(classId: string) {
  const queryClient = useQueryClient();
  /** A write, or a refused one, says the week and the check on screen may be stale: both are read again. */
  const stale = () => {
    void queryClient.invalidateQueries({ queryKey: CLASS_TEACHER_KEYS.weeks(classId) });
    void queryClient.invalidateQueries({ queryKey: CLASS_TEACHER_KEYS.check(classId) });
  };
  const create = useMutation({
    mutationFn: (body: CreateChangeBody) => api.post<ChangeView>(`${BASE}/classes/${classId}/changes`, body),
    onSettled: stale,
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateChangeBody }) =>
      api.patch<ChangeView>(`${BASE}/classes/${classId}/changes/${id}`, body),
    onSettled: stale,
  });
  const discard = useMutation({
    mutationFn: ({ id, rev }: { id: string; rev: number }) =>
      api.delete<void>(`${BASE}/classes/${classId}/changes/${id}?rev=${rev}`),
    onSettled: stale,
  });
  /** `changeIds` absent: every draft of the class that waits. 403 CLASS_TEACHER_PUBLISH_OFF unless the school allowed it. */
  const publish = useMutation({
    mutationFn: (changeIds?: string[]) =>
      api.post<{ outcomes: PublishOutcome[] }>(`${BASE}/classes/${classId}/publish`, changeIds ? { changeIds } : {}),
    onSettled: stale,
  });
  return { create, update, discard, publish };
}

// ---------------------------------------------------------------------------
// The administrators
// ---------------------------------------------------------------------------

/** Who is klasslärare of which class in a läsår, and whether each appointment still runs. */
export function useAppointments(yearId: string | null) {
  return useQuery({
    queryKey: yearId ? CLASS_TEACHER_ADMIN_KEYS.appointments(yearId) : [...ADMIN_ROOT, "appointments", "none"],
    enabled: yearId !== null,
    retry: false,
    queryFn: () => api.get<AppointmentView[]>(`${ADMIN}/appointments?academicYearId=${yearId}`),
  });
}

/** The open spans of a läsår: every class's (studentGroupId null) and each class's own. */
export function useOpenTimes(yearId: string | null) {
  return useQuery({
    queryKey: yearId ? CLASS_TEACHER_ADMIN_KEYS.openTimes(yearId) : [...ADMIN_ROOT, "openTimes", "none"],
    enabled: yearId !== null,
    retry: false,
    queryFn: () => api.get<OpenTimeView[]>(`${ADMIN}/open-times?academicYearId=${yearId}`),
  });
}

/** Whether a klasslärare publishes their own class's drafts (off until an administrator turns it on). */
export function useClassTeacherSettings() {
  return useQuery({
    queryKey: CLASS_TEACHER_ADMIN_KEYS.settings,
    retry: false,
    queryFn: () => api.get<{ selfPublish: boolean }>(`${ADMIN}/settings`),
  });
}

/** The waiting drafts of every class, each judged as publication would judge it. */
export function useDrafts() {
  return useQuery({
    queryKey: CLASS_TEACHER_ADMIN_KEYS.drafts,
    retry: false,
    refetchInterval: REFRESH_MS,
    refetchOnWindowFocus: true,
    queryFn: () => api.get<DraftRowView[]>(`${ADMIN}/drafts`),
  });
}

export function useClassTeacherAdminActions() {
  const queryClient = useQueryClient();
  /** The drafts, and the weeks the klasslärare have open (a published draft changes their lessons). */
  const draftsChanged = () => {
    void queryClient.invalidateQueries({ queryKey: CLASS_TEACHER_ADMIN_KEYS.drafts });
    void queryClient.invalidateQueries({ queryKey: CLASS_TEACHER_KEYS.all });
  };
  /** Appoints, or takes the appointment over: the answer is the läsår's whole list. */
  const appoint = useMutation({
    mutationFn: ({ studentGroupId, userId }: { yearId: string; studentGroupId: string; userId: string }) =>
      api.post<AppointmentView[]>(`${ADMIN}/appointments`, { studentGroupId, userId }),
    onSuccess: (list, { yearId }) => queryClient.setQueryData(CLASS_TEACHER_ADMIN_KEYS.appointments(yearId), list),
    onError: (_error, { yearId }) => void queryClient.invalidateQueries({ queryKey: CLASS_TEACHER_ADMIN_KEYS.appointments(yearId) }),
  });
  const removeAppointment = useMutation({
    mutationFn: ({ id }: { yearId: string; id: string }) => api.delete<void>(`${ADMIN}/appointments/${id}`),
    onSettled: (_done, _error, { yearId }) =>
      void queryClient.invalidateQueries({ queryKey: CLASS_TEACHER_ADMIN_KEYS.appointments(yearId) }),
  });
  /** Replaces the spans of one scope; the answer is the läsår's whole list. */
  const setOpenTimes = useMutation({
    mutationFn: (body: OpenTimesBody) => api.put<OpenTimeView[]>(`${ADMIN}/open-times`, body),
    onSuccess: (list, body) => queryClient.setQueryData(CLASS_TEACHER_ADMIN_KEYS.openTimes(body.academicYearId), list),
    onError: (_error, body) =>
      void queryClient.invalidateQueries({ queryKey: CLASS_TEACHER_ADMIN_KEYS.openTimes(body.academicYearId) }),
  });
  const updateSettings = useMutation({
    mutationFn: (selfPublish: boolean) => api.put<{ selfPublish: boolean }>(`${ADMIN}/settings`, { selfPublish }),
    // The answer is the whole setting: the switch shows what was saved.
    onSuccess: (saved) => queryClient.setQueryData(CLASS_TEACHER_ADMIN_KEYS.settings, saved),
    // A refused save says the setting on screen may be stale.
    onError: () => void queryClient.invalidateQueries({ queryKey: CLASS_TEACHER_ADMIN_KEYS.settings }),
  });
  const discardDraft = useMutation({
    mutationFn: (id: string) => api.delete<void>(`${ADMIN}/drafts/${id}`),
    onSettled: draftsChanged,
  });
  /** Publishes a class's waiting drafts, or the ones named, as the administrator who asks. */
  const publishClass = useMutation({
    mutationFn: ({ classId, changeIds }: { classId: string; changeIds?: string[] }) =>
      api.post<{ outcomes: PublishOutcome[] }>(`${ADMIN}/classes/${classId}/publish`, changeIds ? { changeIds } : {}),
    onSettled: draftsChanged,
  });
  return { appoint, removeAppointment, setOpenTimes, updateSettings, discardDraft, publishClass };
}
