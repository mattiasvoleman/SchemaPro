"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { STAFFING_KEYS } from "@/lib/staffing-keys";
import type { StaffingRolloverPreview, StaffingRolloverResult } from "@/lib/types";

/*
 * Tjänster och uppdrag carried into a läsår that was rolled without them
 * (POST /academic-years/:id/staffing-rollover[/preview], staffing Fas 5).
 * `:id` is the TARGET; the gateway takes the source from its predecessorId,
 * so the page never names a year to copy from.
 *
 * Beside the page, not in lib/staffing-queries.ts: only the carry dialog
 * calls these, and that module is imported by the drawer, the requirements
 * page and /teacher/tjanst too.
 */

/** The gateway's code for a carry whose preview moved: nothing was written. */
export const STAFFING_ROLLOVER_STALE = "STAFFING_ROLLOVER_PREVIEW_STALE";

/** The preview's own key: per target year, and refetched after a stale 409. */
export const STAFFING_CARRY_PREVIEW_KEY = ["staffingCarryPreview"] as const;

/**
 * The dry run, fetched while the dialog is open. Never retried: a 409 (no
 * predecessor) is the answer, and a POST that writes nothing is still not a
 * thing to repeat on its own.
 */
export function useStaffingCarryPreview(targetYearId: string | null) {
  return useQuery({
    queryKey: [...STAFFING_CARRY_PREVIEW_KEY, targetYearId],
    enabled: targetYearId !== null,
    retry: false,
    staleTime: 0,
    queryFn: () =>
      api.post<StaffingRolloverPreview>(`/api/v1/academic-years/${targetYearId}/staffing-rollover/preview`),
  });
}

/**
 * The carry, with the preview's hash. The gateway plans again in its own
 * transaction and answers 409 STAFFING_ROLLOVER_PREVIEW_STALE, writing
 * nothing, if a post or an uppdrag moved since; either way everything the
 * carry writes or could have written is refetched — the posts, the uppdrag,
 * their slots (constraints), the load, the suggestions, and the preview.
 */
export function useExecuteStaffingCarry(targetYearId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (planHash: string) =>
      api.post<StaffingRolloverResult>(`/api/v1/academic-years/${targetYearId}/staffing-rollover`, { planHash }),
    onSettled: () => {
      for (const queryKey of [
        STAFFING_KEYS.employments,
        STAFFING_KEYS.duties,
        STAFFING_KEYS.load,
        STAFFING_KEYS.suggestions,
        ["constraints"],
        STAFFING_CARRY_PREVIEW_KEY,
      ]) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
  });
}
