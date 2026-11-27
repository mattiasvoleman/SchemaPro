"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { calendarBody } from "@/lib/school-calendar";

/**
 * Skolans kalender: a whole calendar in one write, and the count of what it would take first
 * (POST /api/v1/school-breaks/calendar, src/resources/school-breaks.service.ts applyCalendar).
 *
 * Used by the calendar dialog on Lov & studiedagar alone, so the hooks live in a file only it imports.
 */

export interface SchoolCalendarItemResult {
  index: number;
  id: string | null;
  action: "CREATED" | "UPDATED" | "UNCHANGED";
  removedCalendarLessons: number;
}

export interface SchoolCalendarResult {
  dryRun: boolean;
  created: number;
  updated: number;
  unchanged: number;
  removedCalendarLessons: number;
  items: SchoolCalendarItemResult[];
}

export type SchoolCalendarBody = ReturnType<typeof calendarBody>;

const PATH = "/api/v1/school-breaks/calendar";

/**
 * What the rows in `body` would take out of the published calendar, nothing written. Asked again whenever the ticked
 * rows change, and never kept: a count from a minute ago says nothing about the lessons a publish has made since.
 */
export function useSchoolCalendarCount(body: SchoolCalendarBody, enabled: boolean) {
  return useQuery({
    queryKey: ["schoolCalendarCount", body],
    queryFn: () => api.post<SchoolCalendarResult>(PATH, { ...body, dryRun: true }),
    enabled,
    gcTime: 0,
    retry: false,
  });
}

/** The write. The lessons it took are the calendar's, so the same reads are asked again as after a single lov. */
export function useApplySchoolCalendar() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SchoolCalendarBody) => api.post<SchoolCalendarResult>(PATH, { ...body, dryRun: false }),
    onSuccess: () => {
      for (const key of ["schoolBreaks", "calendarLessons", "dayLessons", "teacherLessons"]) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
  });
}
