"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { AFTER_ACTIVATION, YEAR_KEYS } from "@/lib/year-keys";
import type { AcademicYear, ActivationPreview, ActivationResult } from "@/lib/types";

/*
 * Aktivering of a läsår (POST /academic-years/:id/activation[/preview]).
 *
 * Beside the page rather than in lib/queries.ts, for the bundle: see
 * lib/year-keys.ts. Everything goes through the gateway — the plan is
 * computed over every year, group and pupil of the school in one RLS
 * transaction, which PostgREST cannot answer, and the execute moves pupils by
 * id under locks.
 *
 * The preview is a POST that writes nothing, so it is a QUERY here: cached by
 * year, refetched when the dialog mounts (react-query's default for a stale
 * key), and never retried — a 404 or a 409 is an answer, not a hiccup.
 */

const previewOf = (yearId: string) =>
  api.post<ActivationPreview>(`/api/v1/academic-years/${yearId}/activation/preview`);

export function useActivationPreview(yearId: string | null) {
  return useQuery({
    queryKey: [...YEAR_KEYS.activationPreview, yearId],
    enabled: yearId !== null,
    retry: false,
    queryFn: () => previewOf(yearId!),
  });
}

/**
 * The pending moves of every year that has some to show: an inactive year
 * rolled from another. The list on /admin/years says "34 elever flyttar hit
 * vid aktiveringen" from these, before anyone opens the dialog. A school has
 * a handful of years and at most one or two of these.
 *
 * ONE query fetching them all, not useQueries: react-query is in the chunk
 * every route shares, and Turbopack keeps a shared module whole, so the first
 * page to call useQueries puts its ~0.2KB gzipped on every route's bill —
 * measured 2026-10-07, /admin/timetable 189.5 → 189.7 of 190. Under the same
 * prefix, so an activation's invalidation reaches it.
 */
export function usePendingActivations(years: readonly AcademicYear[] | undefined) {
  const ids = (years ?? [])
    .filter((year) => !year.isActive && year.predecessorId !== null)
    .map((year) => year.id);
  const { data } = useQuery({
    queryKey: [...YEAR_KEYS.activationPreview, "pending", ids],
    enabled: ids.length > 0,
    retry: false,
    queryFn: async () => {
      const previews = await Promise.all(
        // One refusal (a year RLS hides, say) costs that year its line, not the list.
        ids.map((id) => previewOf(id).catch(() => null)),
      );
      return new Map(
        previews.flatMap((preview, index) => (preview ? [[ids[index]!, preview] as const] : [])),
      );
    },
  });
  return data ?? EMPTY;
}

const EMPTY: ReadonlyMap<string, ActivationPreview> = new Map();

/**
 * Hands the active flag over and moves the planned pupils, by the preview's
 * hash. Everything a pupil's class is read from is refetched: the people
 * list, the groups and their members, and the rosters attendance builds.
 */
export function useActivateYear() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ yearId, planHash }: { yearId: string; planHash: string }) =>
      api.post<ActivationResult>(`/api/v1/academic-years/${yearId}/activation`, { planHash }),
    onSettled: () => {
      // Settled, not success: a stale 409 means the preview behind the
      // dialog is wrong, and it should be fetched again either way.
      for (const queryKey of AFTER_ACTIVATION) void queryClient.invalidateQueries({ queryKey });
    },
  });
}

/** DELETE /academic-years/:id — the undo of a rollover, before activation. */
export function useDeleteYear() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (yearId: string) => api.delete(`/api/v1/academic-years/${yearId}`),
    onSuccess: () => {
      // The year's groups, rows and lov go with it (ON DELETE CASCADE).
      for (const queryKey of [
        YEAR_KEYS.years,
        YEAR_KEYS.groups,
        YEAR_KEYS.memberships,
        YEAR_KEYS.requirements,
        YEAR_KEYS.breaks,
        YEAR_KEYS.constraints,
        YEAR_KEYS.activationPreview,
      ]) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
  });
}
