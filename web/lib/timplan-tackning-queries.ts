"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { TimplanCoverageResponse } from "@/lib/timplan-tackning";
import { TIMPLAN_COVERAGE_KEYS } from "@/lib/year-timplan-keys";

/**
 * Layer 1 of the year's timplanstäckning, as the gateway computes it — read
 * by /admin/timplan/tackning alone, so the hook lives in a file only that
 * route imports (the argument lib/timplan-queries.ts makes about
 * lib/queries.ts).
 *
 * Read afresh every time the page mounts: a requirement saved on
 * Timplansposter a moment ago changes the answer, and nothing on that page
 * invalidates this key (doing so would put this file in its bundle).
 */
export function useTimplanCoverage(academicYearId: string | null) {
  return useQuery({
    queryKey: TIMPLAN_COVERAGE_KEYS.year(academicYearId ?? ""),
    enabled: academicYearId !== null,
    refetchOnMount: "always",
    queryFn: () =>
      api.get<TimplanCoverageResponse>(
        `/api/v1/timplan-coverage?academicYearId=${encodeURIComponent(academicYearId!)}&layer=planned`,
      ),
  });
}
