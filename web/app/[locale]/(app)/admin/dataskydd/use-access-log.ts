"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { sortByPersonName } from "@/lib/sorting";
import type { Person, UserRole } from "@/lib/types";

/*
 * "Vem har läst om en person?" (src/access-log): the read log's entries that
 * name one person, for the school's administrator. Every answer is itself a
 * read about the person, and the gateway records it (ACCESS_LOG), so the
 * question is asked when the administrator presses the button, never as a
 * field is typed into.
 */

export const ACCESS_KINDS = [
  "PEOPLE",
  "ROSTER",
  "ATTENDANCE",
  "ABSENCE_REPORTS",
  "LEAVE_REQUESTS",
  "LEAVE_REASON_AS_MENTOR",
  "GUARDIANS",
  "EMPLOYMENT",
  "STAFF_ABSENCES",
  "ACCESS_LOG",
  "SCHEDULE",
  "TEACHING_TIME",
] as const;
export type AccessKind = (typeof ACCESS_KINDS)[number];
/** CALENDAR: a guardian's calendar feed of their child (Kalenderprenumeration). */
export type AccessChannel = "WEB" | "APP" | "INTEGRATION" | "OTHER" | "CALENDAR";

export interface AccessLogEntry {
  id: string;
  /** ISO instant. */
  at: string;
  kind: AccessKind;
  channel: AccessChannel;
  reader:
    | { type: "PERSON"; id: string | null; name: string | null; role: UserRole | null }
    | { type: "KEY"; id: string | null; name: string | null };
  /** How many other people the same read named. */
  others: number;
}

export interface AccessLogAnswer {
  person: { id: string; firstName: string; lastName: string; role: UserRole };
  timezone: string;
  from: string | null;
  to: string | null;
  entries: AccessLogEntry[];
  truncated: boolean;
}

/**
 * What the administrator asked: one person, optionally between two school
 * days, and which press of the button asked it. Every press is a question of
 * its own, so the same person and period asked again is fetched again rather
 * than answered from the cache (and the export carries the fresh answer).
 */
export interface AccessLogQuery {
  personId: string;
  from: string;
  to: string;
  press: number;
}

export function accessLogPath(query: AccessLogQuery): string {
  const params = new URLSearchParams({ personId: query.personId });
  if (query.from) params.set("from", query.from);
  if (query.to) params.set("to", query.to);
  return `/api/v1/access-log?${params.toString()}`;
}

/** The answer to the question asked last; nothing is asked until there is one. */
export function useAccessLog(query: AccessLogQuery | null) {
  return useQuery({
    queryKey: ["accessLog", query?.personId ?? null, query?.from ?? "", query?.to ?? "", query?.press ?? 0],
    enabled: query !== null,
    // Nothing on this page asks without the button: no refetch on its own.
    // A press is a new key (above), so it always asks.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: () => api.get<AccessLogAnswer>(accessLogPath(query!)),
  });
}

/**
 * The people to choose from: the school's register, under usePeople's key
 * and in its order, so the two share one cached answer. A hook of its own
 * rather than lib/queries.ts's, which this page would pull whole into its
 * bundle for one export.
 */
export function useSchoolPeople() {
  return useQuery({
    queryKey: ["people"],
    queryFn: async () => sortByPersonName(await api.get<Person[]>("/api/v1/users")),
  });
}
