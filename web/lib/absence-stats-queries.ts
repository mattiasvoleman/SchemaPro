"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import {
  periodQuery,
  type ClassesView,
  type ClassPupilsView,
  type ClassStatsView,
  type Period,
  type PupilStatsView,
  type SchoolStatsView,
} from "@/lib/absence-stats";

// ---------------------------------------------------------------------------
// Frånvarostatistik över tid, through the gateway (/api/v1/absence-stats). Not
// PostgREST: every door is a function of the database that reads the caller's
// identity, and the gateway records each read that names a pupil in the
// läslogg.
//
// A module of its own, not lib/queries.ts: that one is shared by 37 routes and
// sits on the chunker's merge edge, so a hook added to it is a cost on all of
// them.
//
// Who reads what is the database's say: the school's months are the
// administrators' (the huvudman's läsare included), the classes and their
// months and patterns also a mentor's own, and the pupils' list and card an
// administrator's or a mentor's own mentees, never the huvudman's läsare.
//
// A PUPIL IS NOT KEPT. What is read about a pupil leaves the cache the moment
// the list or the card is closed (gcTime 0) and is asked again on the next
// open; nothing about a pupil is written to localStorage or sessionStorage
// anywhere in the web.
// ---------------------------------------------------------------------------

const ROOT = ["absenceStats"] as const;
const periodKey = (period: Period | null) => [period?.from ?? null, period?.to ?? null] as const;

export const ABSENCE_STATS_KEYS = {
  all: ROOT,
  school: [...ROOT, "school"] as const,
  classes: (period: Period | null) => [...ROOT, "classes", ...periodKey(period)] as const,
  classView: (classId: string, period: Period | null) => [...ROOT, "class", classId, ...periodKey(period)] as const,
  classPupils: (classId: string, period: Period | null) => [...ROOT, "class-pupils", classId, ...periodKey(period)] as const,
  pupil: (studentId: string, period: Period | null) => [...ROOT, "pupil", studentId, ...periodKey(period)] as const,
};

const BASE = "/api/v1/absence-stats";

/** The whole school month by month. Administrators only: a mentor's page never asks. */
export function useSchoolStats() {
  return useQuery({
    queryKey: ABSENCE_STATS_KEYS.school,
    retry: false,
    queryFn: () => api.get<SchoolStatsView>(`${BASE}/school`),
  });
}

/**
 * The classes with their sum over a period (the läsår so far for none): the
 * administrator's all, the mentor's own. Moving to another period keeps the
 * previous figures on screen (placeholder), dimmed, instead of a blank.
 */
export function useClassesStats(period: Period | null) {
  return useQuery({
    queryKey: ABSENCE_STATS_KEYS.classes(period),
    retry: false,
    placeholderData: keepPreviousData,
    queryFn: () => api.get<ClassesView>(`${BASE}/classes${periodQuery(period)}`),
  });
}

/** A class and its predecessors month by month, and its patterns over the period. Sums: nobody is named. */
export function useClassStats(classId: string | null, period: Period | null) {
  return useQuery({
    queryKey: ABSENCE_STATS_KEYS.classView(classId ?? "", period),
    enabled: classId !== null,
    retry: false,
    queryFn: () => api.get<ClassStatsView>(`${BASE}/classes/${classId}${periodQuery(period)}`),
  });
}

/** The pupils of a class with their sums. `enabled` is false for the huvudman's läsare, who is refused. */
export function useClassPupils(classId: string | null, period: Period | null, enabled: boolean) {
  return useQuery({
    queryKey: ABSENCE_STATS_KEYS.classPupils(classId ?? "", period),
    enabled: enabled && classId !== null,
    retry: false,
    gcTime: 0,
    staleTime: 0,
    queryFn: () => api.get<ClassPupilsView>(`${BASE}/classes/${classId}/pupils${periodQuery(period)}`),
  });
}

/** One pupil over three läsår, with the class beside. */
export function usePupilStats(studentId: string | null, period: Period | null) {
  return useQuery({
    queryKey: ABSENCE_STATS_KEYS.pupil(studentId ?? "", period),
    enabled: studentId !== null,
    retry: false,
    gcTime: 0,
    staleTime: 0,
    queryFn: () => api.get<PupilStatsView>(`${BASE}/pupils/${studentId}${periodQuery(period)}`),
  });
}
