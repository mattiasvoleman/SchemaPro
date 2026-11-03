"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

/*
 * Massåtgärder's two calls per list, as the gateway answers them
 * (src/common/bulk.ts): POST <base>/bulk-delete and POST <base>/bulk-update,
 * each all or nothing, each answering 200 with the report. Here rather than in
 * lib/queries.ts, which every admin route shares whole: these ride in the
 * dialogs' chunk, fetched on the first click.
 */

/** One row the call would not write, with the single-row route's reason. */
export interface BulkRefusal {
  id: string;
  code: string | null;
  message: string;
  params?: Record<string, string | number>;
}

/** What a bulk call did, or on a dry run would do. */
export interface BulkResult<Consequences = Record<string, number>> {
  /** True when every row was written; false writes nothing. */
  applied: boolean;
  dryRun: boolean;
  done: string[];
  refused: BulkRefusal[];
  consequences?: Consequences;
}

/** GroupRemovalConsequences in src/resources/student-groups.service.ts. */
export interface GroupRemovalConsequences {
  halves: number;
  homePupils: number;
  memberships: number;
  requirements: number;
  masterLessons: number;
  sharedLessons: number;
  calendarLessons: number;
  attendanceMarks: number;
  enrolments: number;
  mentorDuties: number;
  fromSource: number;
}

/** StudentRemovalConsequences in src/users/users.service.ts. */
export interface StudentRemovalConsequences {
  memberships: number;
  enrolments: number;
  guardianLinks: number;
  absenceReports: number;
  leaveRequests: number;
  attendanceMarks: number;
  logins: number;
  fromSource: number;
}

export interface BulkDeleteBody {
  ids: string[];
  dryRun?: boolean;
}

export interface BulkUpdateBody<Changes> {
  ids: string[];
  changes: Changes;
  dryRun?: boolean;
}

/**
 * The two calls of one list. A call that wrote makes `invalidate` stale; a
 * dry run or a refused call wrote nothing and leaves every cache alone.
 */
export function useBulkActions<Changes, Consequences>(base: string, invalidate: readonly (readonly string[])[]) {
  const queryClient = useQueryClient();
  const afterWrite = (result: BulkResult<unknown>) => {
    if (!result.applied) return;
    for (const key of invalidate) void queryClient.invalidateQueries({ queryKey: [...key] });
  };
  const remove = useMutation({
    mutationFn: (body: BulkDeleteBody) => api.post<BulkResult<Consequences>>(`${base}/bulk-delete`, body),
    onSuccess: afterWrite,
  });
  const update = useMutation({
    mutationFn: (body: BulkUpdateBody<Changes>) => api.post<BulkResult<never>>(`${base}/bulk-update`, body),
    onSuccess: afterWrite,
  });
  return { remove, update };
}
