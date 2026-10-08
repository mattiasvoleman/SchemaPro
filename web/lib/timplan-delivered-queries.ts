"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { DeliveredCoverageResponse } from "@/lib/timplan-delivered";
import { TIMPLAN_COVERAGE_KEYS } from "@/lib/year-timplan-keys";

/**
 * Layer 3 of the year's timplanstäckning, genomfört mot schemalagt — read by
 * Täckning's "Genomfört mot schemalagt" tab alone, in a file of its own for
 * the reason lib/timplan-tackning-queries.ts gives.
 *
 * Without a group, the overview: line totals per group and subject (R20).
 * With one, the drill-down for that group alone — its lines with the lost
 * minutes by cause, the credits and the projection's parts, and (an admin's
 * read) every pupil of it. The tab keeps the overview and asks for the
 * drill-down beside it; the drill-down does not repeat the other groups.
 *
 * Read afresh when the tab mounts: lessons are held, cancelled and credited
 * between two visits, and the answer is "as of now".
 */
export function useDeliveredCoverage(academicYearId: string | null, studentGroupId: string | null = null) {
  return useQuery({
    queryKey: TIMPLAN_COVERAGE_KEYS.delivered(academicYearId ?? "", studentGroupId),
    enabled: academicYearId !== null,
    refetchOnMount: "always",
    queryFn: () =>
      api.get<DeliveredCoverageResponse>(
        `/api/v1/timplan-coverage?academicYearId=${encodeURIComponent(academicYearId!)}&layer=delivered` +
          (studentGroupId ? `&studentGroupId=${encodeURIComponent(studentGroupId)}` : ""),
      ),
  });
}
