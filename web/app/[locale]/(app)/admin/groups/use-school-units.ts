"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { SchoolUnit } from "@/lib/school-units";

/**
 * The school's skolenheter, through the gateway: the table has no arm for a
 * PostgREST session (migration 20261031090000), so no direct read reaches it.
 * The gateway answers them in their order (compareUnits).
 *
 * Here and not in lib/queries: that module is in every app route's graph,
 * and the rule it would have pulled in cost each route 0.4 KB (bundle gate,
 * 2026-10-15) for a card one page shows.
 */
export const SCHOOL_UNITS_KEY = ["school-units"];

export function useSchoolUnits() {
  return useQuery({
    queryKey: SCHOOL_UNITS_KEY,
    queryFn: () => api.get<SchoolUnit[]>("/api/v1/school-units"),
  });
}
