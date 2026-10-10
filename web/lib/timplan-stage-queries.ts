"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { StagePublicationSummary, TimplanStageResponse } from "@/lib/timplan-stage-view";
import { TIMPLAN_COVERAGE_KEYS } from "@/lib/year-timplan-keys";

/**
 * The Stadium tab's reads and its two writes — read by that tab alone, which
 * Täckning loads with lazy() the first time it is chosen, so none of this is
 * in the route's own JavaScript (the argument lib/timplan-tackning-queries.ts
 * makes).
 *
 * Without a class, the overview: per home class and current stage, min /
 * median / max per cell, the verdict counts, "Timplaner per årskull" and the
 * school's publication. With one, the drill-down for that class alone. Read
 * afresh when the tab mounts: the answer is "as of today", and a lesson held
 * this morning is in it.
 */
export function useTimplanStages(academicYearId: string | null, studentGroupId: string | null = null) {
  return useQuery({
    queryKey: TIMPLAN_COVERAGE_KEYS.stage(academicYearId ?? "", studentGroupId),
    enabled: academicYearId !== null,
    refetchOnMount: "always",
    queryFn: () =>
      api.get<TimplanStageResponse>(
        `/api/v1/timplan-stages?academicYearId=${encodeURIComponent(academicYearId!)}` +
          (studentGroupId ? `&studentGroupId=${encodeURIComponent(studentGroupId)}` : ""),
      ),
  });
}

/**
 * Publishing the families' "Undervisningstid" for the active year, and
 * withdrawing it. Manual by design: the statement is a dated snapshot the
 * school chooses to show ("Uppdaterad …"), not a live figure. Either write
 * re-reads the overview, which carries the publication.
 */
export function useTimplanStatementActions(academicYearId: string) {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: TIMPLAN_COVERAGE_KEYS.stage(academicYearId, null).slice(0, 3),
    });
  };
  const publish = useMutation({
    mutationFn: () =>
      api.post<StagePublicationSummary & { rows: number }>("/api/v1/timplan-stages/statements", { academicYearId }),
    onSuccess: invalidate,
  });
  const withdraw = useMutation({
    mutationFn: () => api.delete<void>("/api/v1/timplan-stages/statements"),
    onSuccess: invalidate,
  });
  return { publish, withdraw };
}
