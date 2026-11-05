"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { AFTER_CANCELLATION } from "@/lib/publication-keys";
import type {
  ActivityChanged,
  ActivityCreated,
  ActivityInput,
  ActivityPreview,
  ActivityReapplied,
  ActivityRemovePreview,
  ActivitySelection,
  ScheduleActivity,
} from "@/lib/schedule-activity-types";

/*
 * Schemabrytande aktivitet (src/publication/schedule-activities.controller.ts),
 * beside the one page that uses it (lib/year-keys.ts says why).
 *
 * The preview is a MUTATION, as the avbokning's is: it belongs to a form, it is
 * asked for with a button, and its digest goes back with the create or the
 * change. A preview fetched again behind the admin's back would carry a digest
 * for a plan they never read. The removal's preview is a query, keyed by the
 * activity: its dialog asks for it as it opens.
 *
 * The key is kept here and not in lib/publication-keys.ts: that file is read by
 * the publishing and avbokning pages, and a constant added to it is one more
 * byte in each of their routes.
 */

const ACTIVITY_KEY = ["scheduleActivities"] as const;

export function useScheduleActivities(academicYearId: string | null) {
  return useQuery({
    queryKey: [...ACTIVITY_KEY, academicYearId],
    enabled: academicYearId !== null,
    retry: false,
    queryFn: () =>
      api.get<ScheduleActivity[]>(`/api/v1/schedule-activities?academicYearId=${encodeURIComponent(academicYearId!)}`),
  });
}

/** `activityId` null previews a new activity; an id previews the change of that one. */
export function useActivityPreview() {
  return useMutation({
    mutationFn: ({ activityId, selection }: { activityId: string | null; selection: ActivitySelection }) =>
      api.post<ActivityPreview>(
        activityId ? `/api/v1/schedule-activities/${activityId}/preview` : "/api/v1/schedule-activities/preview",
        selection,
      ),
  });
}

/**
 * What a write makes stale: the calendar (lessons cancelled, replacement
 * lessons written), the avbokning the activity owns, the credits it wrote, and
 * the list itself.
 */
function useAfterActivity() {
  const queryClient = useQueryClient();
  return () => {
    for (const queryKey of [...AFTER_CANCELLATION, ACTIVITY_KEY]) void queryClient.invalidateQueries({ queryKey });
  };
}

export function useCreateActivity() {
  const after = useAfterActivity();
  return useMutation({
    mutationFn: (input: ActivityInput) => api.post<ActivityCreated>("/api/v1/schedule-activities", input),
    onSettled: after,
  });
}

export function useChangeActivity() {
  const after = useAfterActivity();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ActivityInput }) =>
      api.patch<ActivityChanged>(`/api/v1/schedule-activities/${id}`, input),
    onSettled: after,
  });
}

/** Cancels the ordinary lessons that have come into the activity's days since; `added` says how many. */
export function useReapplyActivity() {
  const after = useAfterActivity();
  return useMutation({
    mutationFn: (id: string) => api.post<ActivityReapplied>(`/api/v1/schedule-activities/${id}/reapply`),
    onSettled: after,
  });
}

export function useRemovePreview(activityId: string | null) {
  return useQuery({
    queryKey: [...ACTIVITY_KEY, "remove", activityId],
    enabled: activityId !== null,
    retry: false,
    staleTime: 0,
    queryFn: () => api.post<ActivityRemovePreview>(`/api/v1/schedule-activities/${activityId}/remove/preview`),
  });
}

export function useRemoveActivity() {
  const after = useAfterActivity();
  return useMutation({
    mutationFn: (id: string) => api.post<ActivityRemovePreview>(`/api/v1/schedule-activities/${id}/remove`),
    onSettled: after,
  });
}
