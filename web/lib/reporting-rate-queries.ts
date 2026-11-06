"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type {
  MyReportingRate,
  ReportingPeriod,
  ReportingRateView,
  ReportingSettings,
  ReportingSettingsChange,
} from "@/lib/reporting-rate";

// ---------------------------------------------------------------------------
// Rapporteringsgrad: the school's figures per teacher, the switches that start
// the reminders and the weekly note, and the teacher's own open lessons,
// through the gateway (/api/v1/reporting-rate). Not PostgREST: the gateway
// records each read of other people's rows in the läslogg, and the teacher's
// open lessons are a function that answers only for the signed-in teacher.
//
// A module of its own, not lib/queries.ts: that one is shared by 37 routes and
// sits on the chunker's merge edge, so a hook added to it is a cost on all of
// them.
//
// Who may read what is the database's say, not this module's: the school's
// figures and the settings are the administrators' (the settings are written
// under Drift), /mine is the teacher's own.
// ---------------------------------------------------------------------------

const ROOT = ["reportingRate"] as const;
export const REPORTING_RATE_KEYS = {
  all: ROOT,
  /** The school's figures per teacher, for a period around an anchor day (null: the school's today). */
  school: (period: ReportingPeriod, anchor: string | null) => [...ROOT, "school", period, anchor] as const,
  settings: [...ROOT, "settings"] as const,
  /** The teacher's own: open lessons and the grade of the week, the month and the läsår. */
  mine: [...ROOT, "mine"] as const,
};

const BASE = "/api/v1/reporting-rate";

/**
 * The school's reporting rate per teacher in the period around `anchor`, or
 * around the school's today when there is none. Moving to another period
 * keeps the previous figures on screen (placeholder), dimmed by the table,
 * instead of a blank between two weeks.
 */
export function useReportingRate(period: ReportingPeriod, anchor: string | null) {
  return useQuery({
    queryKey: REPORTING_RATE_KEYS.school(period, anchor),
    retry: false,
    placeholderData: keepPreviousData,
    queryFn: () => api.get<ReportingRateView>(`${BASE}?period=${period}${anchor ? `&anchor=${anchor}` : ""}`),
  });
}

/** The two switches and the limit in days. */
export function useReportingSettings() {
  return useQuery({
    queryKey: REPORTING_RATE_KEYS.settings,
    retry: false,
    queryFn: () => api.get<ReportingSettings>(`${BASE}/settings`),
  });
}

export function useReportingActions() {
  const queryClient = useQueryClient();
  const updateSettings = useMutation({
    mutationFn: (change: ReportingSettingsChange) => api.put<ReportingSettings>(`${BASE}/settings`, change),
    // The answer is the whole set: the switches show what was saved.
    onSuccess: (saved) => queryClient.setQueryData(REPORTING_RATE_KEYS.settings, saved),
    // A refused save says the set on screen may be stale.
    onError: () => void queryClient.invalidateQueries({ queryKey: REPORTING_RATE_KEYS.settings }),
  });
  return { updateSettings };
}

/** The teacher's own open lessons and grades. */
export function useMyReportingRate() {
  return useQuery({
    queryKey: REPORTING_RATE_KEYS.mine,
    retry: false,
    queryFn: () => api.get<MyReportingRate>(`${BASE}/mine`),
  });
}
