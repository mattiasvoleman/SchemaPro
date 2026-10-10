"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { createClient } from "@/utils/supabase/client";
import { AFTER_COVER_WRITE, COVER_KEYS } from "@/lib/cover-keys";
import type {
  Absence,
  AbsenceInput,
  AbsencePatch,
  AbsenceReason,
  Board,
  BulkInput,
  Candidates,
  CounterRow,
  CoverSettings,
  DayProposal,
  DecisionInput,
  Hours,
  PoolWindow,
  PoolWindowInput,
} from "@/lib/cover-types";
import type { StaffingWarning } from "@/lib/types";

/*
 * The cover board's reads and writes (src/cover/cover.controller.ts): the
 * absence register, the school's reasons and settings, the board and its
 * decisions, the candidates and the day proposal, the counter, the hours and
 * the pool.
 *
 * Beside lib/queries.ts rather than in it, for the bundle (see
 * lib/publication-queries.ts): that module is in every route's chunk graph,
 * and these hooks belong to /admin/cover, /admin/teacher-absence, the
 * reports' lazy tab and /teacher/franvaro. Only useQuery and useMutation are
 * used, which every route already carries.
 *
 * Everything goes through the gateway, which runs it as the caller under RLS
 * — an absence's reason reaches only the admin and the absent teacher — except
 * the one read a pool member makes of their own membership row, which RLS
 * (substitute_pool_members_own_select) answers directly.
 *
 * NOTHING HERE RETRIES A WRITE OR A 409: a refusal is an answer (COVER_STALE
 * means "read the board again", ABSENCE_HAS_DECISIONS asks a question), and
 * the pages render it.
 */

function useInvalidate() {
  const queryClient = useQueryClient();
  return (keys: readonly (readonly string[])[] = AFTER_COVER_WRITE) => {
    for (const queryKey of keys) void queryClient.invalidateQueries({ queryKey });
  };
}

// ---------------------------------------------------------------------------
// The register
// ---------------------------------------------------------------------------

export interface AbsenceQuery {
  includeEnded?: boolean;
  /** YYYY-MM-DD: only absences still running on or after this day. */
  from?: string;
  userId?: string;
}

export function useAbsences(query: AbsenceQuery = {}, enabled = true) {
  const params = new URLSearchParams();
  if (query.includeEnded) params.set("includeEnded", "true");
  if (query.from) params.set("from", query.from);
  if (query.userId) params.set("userId", query.userId);
  const search = params.toString();
  return useQuery({
    queryKey: [...COVER_KEYS.absences, search],
    enabled,
    retry: false,
    queryFn: () => api.get<Absence[]>(`/api/v1/teacher-absences${search ? `?${search}` : ""}`),
  });
}

export function useAbsenceActions() {
  const invalidate = useInvalidate();
  const create = useMutation({
    mutationFn: (input: AbsenceInput) => api.post<Absence>("/api/v1/teacher-absences", input),
    onSuccess: () => invalidate(),
  });
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: AbsencePatch }) =>
      api.patch<Absence>(`/api/v1/teacher-absences/${id}`, patch),
    onSuccess: () => invalidate(),
  });
  const end = useMutation({
    mutationFn: ({ id, at, undoDecisions }: { id: string; at: string; undoDecisions?: boolean }) =>
      api.post<Absence>(`/api/v1/teacher-absences/${id}/end`, {
        at,
        ...(undoDecisions ? { undoDecisions: true } : {}),
      }),
    onSuccess: () => invalidate(),
  });
  const withdraw = useMutation({
    mutationFn: ({ id, undoDecisions }: { id: string; undoDecisions?: boolean }) =>
      api.post<Absence>(`/api/v1/teacher-absences/${id}/withdraw`, undoDecisions ? { undoDecisions: true } : {}),
    onSuccess: () => invalidate(),
  });
  return { create, update, end, withdraw };
}

// ---------------------------------------------------------------------------
// The school's reasons and settings
// ---------------------------------------------------------------------------

export function useAbsenceReasons(enabled = true) {
  return useQuery({
    queryKey: COVER_KEYS.reasons,
    enabled,
    retry: false,
    staleTime: 60_000,
    queryFn: () => api.get<AbsenceReason[]>("/api/v1/teacher-absence-reasons"),
  });
}

export function useReasonActions() {
  const invalidate = useInvalidate();
  const after = () => invalidate([COVER_KEYS.reasons]);
  const create = useMutation({
    mutationFn: (label: string) => api.post<AbsenceReason>("/api/v1/teacher-absence-reasons", { label }),
    onSuccess: after,
  });
  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string; label?: string; archived?: boolean; sortOrder?: number }) =>
      api.patch<AbsenceReason>(`/api/v1/teacher-absence-reasons/${id}`, body),
    onSuccess: after,
  });
  return { create, update };
}

export function useCoverSettings(enabled = true) {
  return useQuery({
    queryKey: COVER_KEYS.settings,
    enabled,
    retry: false,
    queryFn: () => api.get<CoverSettings>("/api/v1/cover/settings"),
  });
}

export function useUpdateCoverSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: CoverSettings) => api.put<CoverSettings>("/api/v1/cover/settings", settings),
    onSuccess: (settings) => {
      queryClient.setQueryData(COVER_KEYS.settings, settings);
      // The pool preference moves every candidate's score; self-report seeds the reasons.
      void queryClient.invalidateQueries({ queryKey: COVER_KEYS.candidates });
      void queryClient.invalidateQueries({ queryKey: COVER_KEYS.reasons });
    },
  });
}

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

export function useCoverBoard(from: string, to: string) {
  return useQuery({
    queryKey: [...COVER_KEYS.board, from, to],
    retry: false,
    // A second admin's decision arrives by realtime; this is the fallback
    // when the socket is down.
    refetchInterval: 120_000,
    queryFn: () => api.get<Board>(`/api/v1/cover/board?from=${from}&to=${to}`),
  });
}

export function useCoverActions() {
  const invalidate = useInvalidate();
  const decide = useMutation({
    mutationFn: ({ lessonId, ...body }: DecisionInput) =>
      api.post<{ lessonId: string; absenceId: string; warnings?: StaffingWarning[] }>(
        `/api/v1/cover/lessons/${lessonId}/decision`,
        body,
      ),
    onSettled: () => invalidate(),
  });
  const undo = useMutation({
    mutationFn: ({ lessonId, absenceId }: { lessonId: string; absenceId: string }) =>
      api.delete<{ lessonId: string; absenceId: string }>(
        `/api/v1/cover/lessons/${lessonId}/decision?absenceId=${absenceId}`,
      ),
    onSettled: () => invalidate(),
  });
  const bulk = useMutation({
    mutationFn: (input: BulkInput) => api.post<{ done: number }>("/api/v1/cover/bulk", input),
    onSettled: () => invalidate(),
  });
  return { decide, undo, bulk };
}

export function useCoverCandidates(lessonId: string | null) {
  return useQuery({
    queryKey: [...COVER_KEYS.candidates, lessonId],
    enabled: lessonId !== null,
    retry: false,
    queryFn: () => api.get<Candidates>(`/api/v1/cover/lessons/${lessonId}/candidates`),
  });
}

/**
 * "Fördela dagen": a proposal is a POST that writes nothing, asked for on a
 * click (it reads the whole school's day), so it is a mutation here; apply
 * sends the proposal's basis back and is refused as COVER_PROPOSAL_STALE when
 * the day moved in between.
 */
export function useDayProposal() {
  return useMutation({
    mutationFn: ({ date, excludeUserIds }: { date: string; excludeUserIds?: string[] }) =>
      api.post<DayProposal>(`/api/v1/cover/days/${date}/proposal`, excludeUserIds?.length ? { excludeUserIds } : {}),
  });
}

export function useApplyProposal() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({
      date,
      basis,
      items,
    }: {
      date: string;
      basis: string;
      items: { lessonId: string; absenceId: string; userId: string }[];
    }) => api.post<{ applied: number }>(`/api/v1/cover/days/${date}/apply`, { basis, items }),
    onSettled: () => invalidate(),
  });
}

// ---------------------------------------------------------------------------
// The counter and the hours
// ---------------------------------------------------------------------------

export function useCoverCounter(date: string) {
  return useQuery({
    queryKey: [...COVER_KEYS.counter, date],
    retry: false,
    queryFn: () => api.get<{ date: string; rows: CounterRow[] }>(`/api/v1/cover/counter?date=${date}`),
  });
}

export function useCoverHours(from: string, to: string, enabled = true) {
  return useQuery({
    queryKey: [...COVER_KEYS.hours, from, to],
    enabled,
    retry: false,
    queryFn: () => api.get<Hours>(`/api/v1/cover/hours?from=${from}&to=${to}`),
  });
}

// ---------------------------------------------------------------------------
// The pool
// ---------------------------------------------------------------------------

export function usePool(enabled = true) {
  return useQuery({
    queryKey: COVER_KEYS.pool,
    enabled,
    retry: false,
    queryFn: () => api.get<{ userId: string; createdAt: string }[]>("/api/v1/cover/pool"),
  });
}

export function usePoolActions() {
  const invalidate = useInvalidate();
  const after = () => invalidate([COVER_KEYS.pool, COVER_KEYS.candidates, COVER_KEYS.counter]);
  const add = useMutation({
    mutationFn: (userId: string) => api.post<{ userId: string }>("/api/v1/cover/pool", { userId }),
    onSuccess: after,
  });
  const remove = useMutation({
    mutationFn: (userId: string) => api.delete<void>(`/api/v1/cover/pool/${userId}`),
    onSuccess: after,
  });
  return { add, remove };
}

/** A pool member's own row: whether "Min tillgänglighet" is theirs to keep. */
export function usePoolMembership(userId: string) {
  return useQuery({
    queryKey: [...COVER_KEYS.poolMembership, userId],
    retry: false,
    queryFn: async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("SubstitutePoolMembers")
        .select("userId")
        .eq("userId", userId)
        .limit(1);
      if (error) throw new Error(error.message);
      return (data ?? []).length > 0;
    },
  });
}

/** An admin reads everybody's windows (or one member's); a teacher only their own. */
export function useAvailability(userId?: string, enabled = true) {
  return useQuery({
    queryKey: [...COVER_KEYS.availability, userId ?? "all"],
    enabled,
    retry: false,
    queryFn: () => api.get<PoolWindow[]>(`/api/v1/cover/availability${userId ? `?userId=${userId}` : ""}`),
  });
}

export function useAvailabilityActions() {
  const invalidate = useInvalidate();
  const after = () => invalidate([COVER_KEYS.availability, COVER_KEYS.candidates]);
  const add = useMutation({
    mutationFn: (input: PoolWindowInput) => api.post<PoolWindow>("/api/v1/cover/availability", input),
    onSuccess: after,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete<void>(`/api/v1/cover/availability/${id}`),
    onSuccess: after,
  });
  return { add, remove };
}
