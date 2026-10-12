"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { PurgedBefore, RetentionDataType } from "@/lib/retention-types";

/*
 * "Gallrat före <datum>" for the reports (GET /api/v1/retention/purged-before,
 * any role): per kind, the date before which the school's gallring has taken
 * everything. Its own module and its own key, so a report that shows the
 * line does not pull the dataskydd page's hooks, and lib/queries.ts (in every
 * route's bundle) stays as it is.
 */

export const PURGED_BEFORE_KEY = ["retentionPurgedBefore"] as const;

/** The purge date of each kind that has one. A failed read shows no line: the report stays as it was. */
export function usePurgedBefore() {
  const query = useQuery({
    queryKey: PURGED_BEFORE_KEY,
    queryFn: () => api.get<PurgedBefore[]>("/api/v1/retention/purged-before"),
    // A night's run moves it at most once a day.
    staleTime: 10 * 60_000,
    retry: false,
  });
  const of = (kind: RetentionDataType): string | null =>
    query.data?.find((row) => row.dataType === kind)?.purgedBefore ?? null;
  return { ...query, of };
}
