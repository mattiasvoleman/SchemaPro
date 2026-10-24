import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { LessonShare } from "@/lib/lesson-shares";

/*
 * Delade lektioner, read: the year's shares by timplanspost, from the gateway
 * (GET /teaching-requirements/shares). The table has no PostgREST grant — it
 * is read through the API only, as every table since 20261124090000 — so the
 * rows themselves still come from Supabase (useRequirements) and their shares
 * beside them from here.
 *
 * A module of its own, not lib/queries.ts, for the bundle: every client page
 * imports that one, and only the Timplansposter and Tjänstefördelning pages
 * read shares.
 */

/** The prefix react-query invalidates on: every write to a post or its shares. */
export const REQUIREMENT_SHARES_KEY = ["requirementShares"] as const;

/** One share as the gateway answers it. */
export interface RequirementShare extends LessonShare {
  requirementId: string;
}

export function useRequirementShares(academicYearId: string | null) {
  return useQuery({
    queryKey: [...REQUIREMENT_SHARES_KEY, academicYearId],
    enabled: academicYearId !== null,
    queryFn: () =>
      api.get<RequirementShare[]>(
        `/api/v1/teaching-requirements/shares?academicYearId=${encodeURIComponent(academicYearId!)}`,
      ),
  });
}

/** The shares by post, longest first as the gateway answers them. */
export function sharesByRequirement(rows: readonly RequirementShare[] | undefined): Map<string, LessonShare[]> {
  const byPost = new Map<string, LessonShare[]>();
  for (const { requirementId, ...share } of rows ?? []) {
    const list = byPost.get(requirementId);
    if (list) list.push(share);
    else byPost.set(requirementId, [share]);
  }
  return byPost;
}
