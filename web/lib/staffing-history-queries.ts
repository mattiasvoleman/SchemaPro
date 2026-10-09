"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { STAFFING_KEYS } from "@/lib/staffing-keys";

/** One field a version changed. Values are as the database row held them. */
export interface HistoryChange {
  field: string;
  before: unknown;
  after: unknown;
}

/**
 * One version of a teacher's tjänst. Mirror of TeacherHistoryEntry in
 * src/staffing/teacher-employments.service.ts.
 */
export interface HistoryEntry {
  id: string;
  /** 1, 2, 3 … per teacher and läsår — what a protokoll cites as "Version 7". */
  version: number;
  entity: "EMPLOYMENT" | "DUTY";
  entityId: string;
  action: "CREATE" | "UPDATE" | "DELETE";
  /** Who wrote it; null for the seed, a migration or the database owner. */
  actorId: string | null;
  createdAt: string;
  changes: HistoryChange[];
}

export interface HistoryResponse {
  /** Newest first. */
  entries: HistoryEntry[];
  /** More than the gateway's 200: the oldest are left out. */
  truncated: boolean;
}

/**
 * A teacher's tjänst for one läsår, version by version (staffing Fas 3,
 * TeacherEmploymentLogs). The admin may ask for anyone; a TEACHER for
 * themselves, and the gateway answers a colleague's id with 403 before it
 * reads anything — this hook never needs to filter.
 *
 * A file of its own, for the bundle argument lib/staffing-queries.ts makes:
 * the drawer, which is lazy, and the two uppdragsbeskrivning pages read it;
 * Min tjänst and the matrix page do not, and should not carry it.
 *
 * Under STAFFING_KEYS.history: every writer of a post or an uppdrag in the
 * web — the employment and duty actions, the CSV import, the carry from last
 * year — invalidates that prefix, because each of them has just added a
 * version. Fetched only while `enabled`: the drawer's card opens collapsed,
 * and a history nobody unfolded is a read nobody needed.
 */
export function useEmploymentHistory(
  userId: string | null,
  academicYearId: string | null,
  enabled = true,
) {
  return useQuery({
    queryKey: [...STAFFING_KEYS.history, userId, academicYearId],
    enabled: enabled && userId !== null && academicYearId !== null,
    queryFn: () =>
      api.get<HistoryResponse>(
        `/api/v1/teacher-employments/${encodeURIComponent(userId!)}/history?academicYearId=${encodeURIComponent(academicYearId!)}`,
      ),
  });
}
