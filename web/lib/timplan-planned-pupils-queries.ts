"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { PlannedClassPupilsResponse } from "@/lib/timplan-tackning";
import { TIMPLAN_COVERAGE_KEYS } from "@/lib/year-timplan-keys";

/**
 * One class's pupils on the planned layer, every line — read by "Visa alla
 * elever" in Täckning → Planerat alone, and that panel is fetched with lazy()
 * the first time it is chosen, so none of this is in the route's own
 * JavaScript (the argument lib/timplan-tackning-queries.ts makes).
 *
 * Fetched per class and only while the panel is open: the overview stays the
 * small answer it was, and 600 pupils are 20-odd at a time. Read afresh when
 * the panel mounts, like the overview — a post saved a moment ago is in it.
 */
export function usePlannedClassPupils(academicYearId: string | null, studentGroupId: string | null) {
  return useQuery({
    queryKey: TIMPLAN_COVERAGE_KEYS.plannedPupils(academicYearId ?? "", studentGroupId ?? ""),
    enabled: academicYearId !== null && studentGroupId !== null,
    refetchOnMount: "always",
    queryFn: () =>
      api.get<PlannedClassPupilsResponse>(
        `/api/v1/timplan-coverage/planned/pupils?academicYearId=${encodeURIComponent(academicYearId!)}` +
          `&studentGroupId=${encodeURIComponent(studentGroupId!)}`,
      ),
  });
}
