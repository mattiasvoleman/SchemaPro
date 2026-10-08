"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { ScheduledCoverage, ScheduledVerdict } from "@/lib/timplan-scheduled";
import { TIMPLAN_COVERAGE_KEYS } from "@/lib/year-timplan-keys";

/** Mirror of ScheduledCoverageResponse in src/timplan/timplan-coverage.service.ts. */
export interface ScheduledCoverageResponse extends Omit<ScheduledCoverage, "verdicts"> {
  academicYearId: string;
  layer: "scheduled";
  verdicts: (ScheduledVerdict & { message: string })[];
}

/**
 * Layer 2 of the year's timplanstäckning, schemalagt mot planerat, as the
 * gateway computes it — read by Täckning's "Schemalagt mot planerat" tab
 * alone, so the hook lives in a file only that tab imports (the argument
 * lib/timplan-tackning-queries.ts makes for layer 1). With a group, the
 * drill-down: the same document plus every pupil of that group (an admin's
 * read; a teacher's has no pupil in it either way).
 *
 * Read afresh when the tab mounts: a lesson moved on the timetable a moment
 * ago changes the answer, and nothing there invalidates this key.
 */
export function useScheduledCoverage(academicYearId: string | null, studentGroupId: string | null = null) {
  return useQuery({
    queryKey: TIMPLAN_COVERAGE_KEYS.scheduled(academicYearId ?? "", studentGroupId),
    enabled: academicYearId !== null,
    refetchOnMount: "always",
    queryFn: () =>
      api.get<ScheduledCoverageResponse>(
        `/api/v1/timplan-coverage?academicYearId=${encodeURIComponent(academicYearId!)}&layer=scheduled` +
          (studentGroupId ? `&studentGroupId=${encodeURIComponent(studentGroupId)}` : ""),
      ),
  });
}
