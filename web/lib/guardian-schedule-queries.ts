"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { FamilySchedule } from "@/lib/family-schedule";

/**
 * The family schedule's one read: a child's published week.
 *
 * A module of its own, imported ONLY by components/guardian/child-schedule.tsx,
 * which /guardian loads with lazy(). /guardian sits in the core tier at about
 * 167 of its 170KB, and a hook imported from the page — or from
 * lib/guardian-queries.ts, which the page imports — would put react-query's
 * use of it and this module into the route's own JS. Here it rides in the
 * lazy chunk with the card.
 *
 * The gateway answers under the guardian's own RLS (20261013090000): another
 * family's child is the same 404 as an unknown id, and the week is the
 * published calendar, never a draft. `week` is any day of the week asked for;
 * without it, the school's own today.
 */
export function useFamilySchedule(studentId: string | null, week: string | null) {
  return useQuery({
    queryKey: ["familySchedule", studentId ?? "", week ?? ""],
    enabled: studentId !== null,
    // Stepping a week keeps the last one on screen until the next arrives,
    // instead of collapsing the card to a spinner and back.
    placeholderData: keepPreviousData,
    staleTime: 60 * 1000,
    queryFn: () => {
      const params = new URLSearchParams({ studentId: studentId! });
      if (week) params.set("week", week);
      return api.get<FamilySchedule>(`/api/v1/family/schedule?${params.toString()}`);
    },
  });
}
