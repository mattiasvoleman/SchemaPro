"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isActiveRun } from "@/lib/candidates/labels";
import type { CandidatesOverview, StartCandidatesRequest } from "@/lib/candidates/types";

/*
 * Schemaförslag's two hooks the generate page needs: the year's runs, and
 * starting one. Beside the page, never in lib/queries.ts: that module is in
 * every route's chunk graph, and /admin/requirements has tens of bytes of
 * its budget left. The compare page's own hooks (the check, a candidate's
 * lessons, the apply) are in candidates/use-candidate-details.ts, so this
 * route carries only what it renders.
 */

/** Every query of this feature starts with it; the apply refreshes what it names. */
export const CANDIDATES_KEY = ["scheduleCandidates"] as const;
export const CANDIDATES_OVERVIEW_KEY = [...CANDIDATES_KEY, "overview"] as const;

/** How often an active run is asked about: the generate job's own rhythm. */
export const CANDIDATES_POLL_MS = 2000;

/**
 * GET candidates?academicYearId=: the newest run and the newest finished
 * batch. Polled while the newest run is active, and only then — a run whose
 * lease has passed already comes back as FAILED (the gateway reads it so),
 * so a lost task does not keep a page polling for ever.
 */
export function useScheduleCandidates(academicYearId: string | null) {
  return useQuery({
    queryKey: [...CANDIDATES_OVERVIEW_KEY, academicYearId],
    enabled: academicYearId !== null,
    queryFn: () =>
      api.get<CandidatesOverview>(
        `/api/v1/optimization/candidates?academicYearId=${encodeURIComponent(academicYearId!)}`,
      ),
    refetchInterval: (query) =>
      isActiveRun(query.state.data?.latest?.run.status) ? CANDIDATES_POLL_MS : false,
  });
}

/**
 * POST candidates: a new run, or "Uppdatera förslagen" (refreshOf). Never
 * retried: a 409 is an answer, and the route is throttled to three a minute.
 */
export function useStartCandidates() {
  const queryClient = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: (body: StartCandidatesRequest) =>
      api.post<{ runId: string }>("/api/v1/optimization/candidates", body),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: CANDIDATES_OVERVIEW_KEY });
    },
  });
}
