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
  /** The kinds that grew since the dry run a delete confirmed: nothing deleted, `consequences` the new counts. */
  consequencesGrew?: string[];
}

/**
 * GroupRemovalConsequences in src/resources/student-groups.service.ts: every
 * key to a group in the catalogue, counted (src/common/removal-inventory.ts).
 */
export interface GroupRemovalConsequences {
  halves: number;
  homePupils: number;
  successors: number;
  memberships: number;
  requirements: number;
  masterLessons: number;
  sharedLessons: number;
  calendarLessons: number;
  attendanceMarks: number;
  lessonLogs: number;
  availabilityConstraints: number;
  lunchSittings: number;
  calendarBreaks: number;
  timplanCredits: number;
  publicLinks: number;
  enrolments: number;
  mentorDuties: number;
  fromSource: number;
}

/**
 * StudentRemovalConsequences in src/users/users.service.ts: the kinds named,
 * the rest an administrator reads in otherRows and otherLinks. The pupils'
 * own accounts, which no administrator reads, are not counted.
 */
export interface StudentRemovalConsequences {
  memberships: number;
  enrolments: number;
  guardianLinks: number;
  absenceReports: number;
  leaveRequests: number;
  attendanceMarks: number;
  lessonParticipations: number;
  teachingTimeStatements: number;
  otherRows: number;
  otherLinks: number;
  logins: number;
  fromSource: number;
}

/** A delete: `dryRun` required (src/common/bulk.ts), and the real one carries its dry run's counts back. */
export interface BulkDeleteBody {
  ids: string[];
  dryRun: boolean;
  expected?: object;
}

export interface BulkUpdateBody<Changes> {
  ids: string[];
  changes: Changes;
  dryRun: boolean;
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
