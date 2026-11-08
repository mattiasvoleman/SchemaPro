"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { pageSchool, schoolHeaders } from "@/lib/school-choice";
import { createClient } from "@/utils/supabase/client";
import type { MealCountsView, MealSettings, MealSettingsChange } from "@/lib/meal-counts";

// ---------------------------------------------------------------------------
// Måltidskollen: the portions of each lunch sitting, the school's cut-off and
// the kitchen's letter, through the gateway (/api/v1/meal-counts). Not
// PostgREST: the count is one function in the database (app.meal_counts_for_me)
// that the gateway asks, so the page, the file and the letter cannot give
// three answers.
//
// A module of its own, not lib/queries.ts: that one is shared by 37 routes and
// sits on the chunker's merge edge, so a hook added to it is a cost on all of
// them.
// ---------------------------------------------------------------------------

const ROOT = ["mealCounts"] as const;
export const MEAL_KEYS = {
  all: ROOT,
  /** `days` days from `from` (null: the school's today). */
  counts: (from: string | null, days: number) => [...ROOT, "counts", from, days] as const,
  settings: [...ROOT, "settings"] as const,
};

const BASE = "/api/v1/meal-counts";

/** The query string for `days` days from `from`, or from the school's own today when there is none. */
export const rangeQuery = (from: string | null, days: number): string => `days=${days}${from ? `&from=${from}` : ""}`;

/**
 * `days` days of portions from `from`, or from the school's today (which the gateway knows; the
 * browser's clock may not be the school's). Moving to another range keeps the previous figures on
 * screen, dimmed by the table, instead of a blank between two days.
 */
export function useMealCounts(from: string | null, days: number, enabled = true) {
  return useQuery({
    queryKey: MEAL_KEYS.counts(from, days),
    enabled,
    retry: false,
    placeholderData: keepPreviousData,
    queryFn: () => api.get<MealCountsView>(`${BASE}?${rangeQuery(from, days)}`),
  });
}

/** The cut-off, the kitchen's address and the switch, and the day of the last letter. */
export function useMealSettings() {
  return useQuery({
    queryKey: MEAL_KEYS.settings,
    retry: false,
    queryFn: () => api.get<MealSettings>(`${BASE}/settings`),
  });
}

export function useMealActions() {
  const queryClient = useQueryClient();
  const updateSettings = useMutation({
    mutationFn: (change: MealSettingsChange) => api.put<MealSettings>(`${BASE}/settings`, change),
    // The answer is the whole set; the cut-off changes what the counts take off, so they are read again.
    onSuccess: (saved) => {
      queryClient.setQueryData(MEAL_KEYS.settings, saved);
      void queryClient.invalidateQueries({ queryKey: [...ROOT, "counts"] });
    },
    // A refused save says the set on screen may be stale.
    onError: () => void queryClient.invalidateQueries({ queryKey: MEAL_KEYS.settings }),
  });
  return { updateSettings };
}

/**
 * The file for Excel, saved by the browser: windows-1252, `;` (the gateway writes it so; this hands over
 * the bytes unread). It sends what the client sends, the session's token and the school the page is for.
 */
export async function downloadMealCsv(from: string | null, days: number, filename: string): Promise<void> {
  const base = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/+$/, "");
  if (!base) throw new ApiError(0, "NEXT_PUBLIC_API_BASE_URL is not configured.");
  const {
    data: { session },
  } = await createClient().auth.getSession();
  if (!session) throw new ApiError(401, "Not authenticated.");
  const response = await fetch(`${base}${BASE}/csv?${rangeQuery(from, days)}`, {
    headers: { Authorization: `Bearer ${session.access_token}`, ...schoolHeaders(pageSchool()) },
  });
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    let code: string | undefined;
    try {
      const problem = (await response.json()) as { detail?: string; message?: string; code?: unknown };
      detail = problem.detail ?? problem.message ?? detail;
      if (typeof problem.code === "string") code = problem.code;
    } catch {
      // A body that is not JSON: keep the status.
    }
    throw new ApiError(response.status, detail, code);
  }
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
