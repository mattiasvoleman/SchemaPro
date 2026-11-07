"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import type { FreeQuery, FreeView, SchoolDaySettings, SchoolDayView, TeacherView } from "@/lib/school-day";

// ---------------------------------------------------------------------------
// Skolans dag: the day and the week of the whole school, the search for what
// is free, and the school's decision about what a teacher has of it, through
// the gateway (/api/v1/school-day). Not PostgREST: who is free is made of
// absences, uppdrag and rastvakt that a teacher cannot read, and the gateway
// leaves a person with a protected identity out of what a teacher is told.
//
// A module of its own, not lib/queries.ts: that one is shared by 37 routes and
// sits on the chunker's merge edge, so a hook added to it is a cost on all of
// them.
// ---------------------------------------------------------------------------

const ROOT = ["schoolDay"] as const;
export const SCHOOL_DAY_KEYS = {
  all: ROOT,
  /** The grids of a range of days (a day is from == to). */
  grid: (from: string, to: string) => [...ROOT, "grid", from, to] as const,
  /** Who and what is free over an interval of a date. */
  free: (query: FreeQuery) => [...ROOT, "free", query.date, query.from, query.to] as const,
  settings: [...ROOT, "settings"] as const,
};

const BASE = "/api/v1/school-day";

/** How often a page left open (a screen on the wall) asks again: the lessons change under the morning. */
export const REFRESH_MS = 60_000;

/**
 * A teacher's page asks less often: the answer is built per request in the API (up to 2 MB for a week in a large
 * school) and every teacher the school lets in has the page open, behind one address and one rate limit.
 */
export const TEACHER_REFRESH_MS = 300_000;

/**
 * The code the gateway answers a teacher with while the school has chosen
 * nothing for teachers (NONE): a state of the page, said calmly, and no error.
 */
export const NOT_OPEN = "SCHOOL_DAY_NOT_OPEN";

export function isNotOpen(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403 && error.code === NOT_OPEN;
}

/**
 * The gateway limits each login's reads of the grids and of the search (SCHOOL_DAY_RATE_LIMITED, 429): a state of
 * the page, said calmly with a wait, and no breakage. The status says it whatever sent it (the global guard's
 * ceiling per address has no code).
 */
export function isRateLimited(error: unknown): boolean {
  return error instanceof ApiError && error.status === 429;
}

/** The grids of [from, to]. Moving to another range keeps the last one on screen, dimmed by the page, instead of a blank. */
export function useSchoolDay(from: string, to: string) {
  return useQuery({
    queryKey: SCHOOL_DAY_KEYS.grid(from, to),
    retry: false,
    placeholderData: keepPreviousData,
    // Once an answer says the reader is not an administrator the page asks at the slower pace; until then, at the first.
    refetchInterval: (query) => (query.state.data?.access?.admin === false ? TEACHER_REFRESH_MS : REFRESH_MS),
    queryFn: () => api.get<SchoolDayView>(`${BASE}?from=${from}&to=${to}`),
  });
}

/** Who and what is free; asked only for an interval the finder has submitted (null: nothing yet). */
export function useSchoolDayFree(query: FreeQuery | null) {
  return useQuery({
    queryKey: query ? SCHOOL_DAY_KEYS.free(query) : [...ROOT, "free", "none"],
    enabled: query !== null,
    retry: false,
    queryFn: () => api.get<FreeView>(`${BASE}/free?date=${query!.date}&from=${query!.from}&to=${query!.to}`),
  });
}

/** What a teacher has of the page. Every member of staff may ask: a teacher to know whether to draw it. */
export function useSchoolDaySettings() {
  return useQuery({
    queryKey: SCHOOL_DAY_KEYS.settings,
    retry: false,
    queryFn: () => api.get<SchoolDaySettings>(`${BASE}/settings`),
  });
}

export function useSchoolDayActions() {
  const queryClient = useQueryClient();
  const updateSettings = useMutation({
    mutationFn: (teacherView: TeacherView) => api.put<SchoolDaySettings>(`${BASE}/settings`, { teacherView }),
    // The answer is the whole decision: the card shows what was saved.
    onSuccess: (saved) => queryClient.setQueryData(SCHOOL_DAY_KEYS.settings, saved),
    // A refused save says what is on screen may be stale.
    onError: () => void queryClient.invalidateQueries({ queryKey: SCHOOL_DAY_KEYS.settings }),
  });
  return { updateSettings };
}
