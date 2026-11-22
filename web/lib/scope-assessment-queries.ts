"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { STAFFING_KEYS } from "@/lib/staffing-keys";
import type { ScopeAssessmentShape, scopeDraftToBody } from "@/lib/scope-assessment-form";

/*
 * The rektor's assessment of a teacher's level and a registered exception (PUT and DELETE /api/v1/scope-assessments/:userId).
 *
 * A module of its own and not a hook of lib/staffing-queries.ts, for the bundle: the card that calls it sits in the teacher drawer, which
 * is click-opened React.lazy, and every route that imports staffing-queries.ts would otherwise pay for a hook only that card uses.
 *
 * The assessment is read back through the load report's `scope` block (STAFFING_KEYS.load), which is where its figures are computed:
 * a save invalidates the report, and nothing else holds a copy.
 */
export type ScopeAssessmentBody = ReturnType<typeof scopeDraftToBody>;

/** The gateway's answer to a write (ScopeAssessmentResponse): the row as stored. */
export interface ScopeAssessmentAnswer extends ScopeAssessmentShape {
  userId: string;
  academicYearId: string;
  decidedAt: string | null;
  hrHidden: boolean;
}

export function useScopeAssessmentActions() {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: STAFFING_KEYS.load });
  };
  const save = useMutation({
    mutationFn: ({ userId, academicYearId, ...body }: { userId: string; academicYearId: string } & ScopeAssessmentBody) =>
      api.put<ScopeAssessmentAnswer>(`/api/v1/scope-assessments/${userId}?academicYearId=${encodeURIComponent(academicYearId)}`, body),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: ({ userId, academicYearId }: { userId: string; academicYearId: string }) =>
      api.delete(`/api/v1/scope-assessments/${userId}?academicYearId=${encodeURIComponent(academicYearId)}`),
    onSuccess: invalidate,
  });
  return { save, remove };
}
