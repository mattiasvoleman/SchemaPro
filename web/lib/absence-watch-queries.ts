"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type {
  AbsenceWatchBasis,
  AbsenceWatchFindings,
  AbsenceWatchGroup,
  AbsenceWatchKind,
  AbsenceWatchLimit,
  AbsenceWatchOverview,
  AbsenceWatchSettingsChange,
} from "@/lib/absence-watch";

// ---------------------------------------------------------------------------
// Frånvarobevakning: the switch, the limits and the findings, through the
// gateway (/api/v1/absence-watch). Not PostgREST: every read arm of the
// findings is the API's role's alone, and the gateway records each read in
// the läslogg.
//
// A module of its own, not lib/queries.ts: that one is shared by 37 routes and
// sits on the chunker's merge edge, so a hook added to it is a cost on all of
// them.
//
// Who may read what is the database's say, not this module's: the overview and
// every write are the administrators' (Drift), the findings are read by an
// administrator (all), a mentor (the MENTOR limits of their own class) and a
// guardian (the GUARDIAN limits of their own child). An empty list is normal.
// ---------------------------------------------------------------------------

const ROOT = ["absenceWatch"] as const;
export const ABSENCE_WATCH_KEYS = {
  overview: [...ROOT, "overview"] as const,
  findings: [...ROOT, "findings"] as const,
};

const BASE = "/api/v1/absence-watch";

/** The switch, the cadences and the limits. */
export function useAbsenceWatchOverview() {
  return useQuery({
    queryKey: ABSENCE_WATCH_KEYS.overview,
    retry: false,
    queryFn: () => api.get<AbsenceWatchOverview>(BASE),
  });
}

/**
 * The pupils over a limit, the reader's own: with `recent`, also those who
 * came back under it in the last 60 days. Reading again after a toggle keeps
 * the list on screen (placeholder), dimmed by the table, instead of a blank.
 */
export function useAbsenceWatchFindings(recent: boolean) {
  return useQuery({
    queryKey: [...ABSENCE_WATCH_KEYS.findings, recent],
    retry: false,
    placeholderData: keepPreviousData,
    queryFn: () => api.get<AbsenceWatchFindings>(`${BASE}/findings${recent ? "?recent=1" : ""}`),
  });
}

/** What POST /limits takes: the group, kind and basis, and the figures of the kind. */
export interface AbsenceWatchLimitBody {
  recipientGroup: AbsenceWatchGroup;
  kind: AbsenceWatchKind;
  basis: AbsenceWatchBasis;
  percent?: number;
  windowDays?: number;
  consecutiveDays?: number;
}

export function useAbsenceWatchActions() {
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ABSENCE_WATCH_KEYS.overview });
  };
  const updateSettings = useMutation({
    mutationFn: (change: AbsenceWatchSettingsChange) => api.put<AbsenceWatchOverview>(`${BASE}/settings`, change),
    // The answer is the whole overview: the switch shows what was saved.
    onSuccess: (saved) => queryClient.setQueryData(ABSENCE_WATCH_KEYS.overview, saved),
    onError: refresh,
  });
  const createLimit = useMutation({
    mutationFn: (body: AbsenceWatchLimitBody) => api.post<AbsenceWatchLimit>(`${BASE}/limits`, body),
    // Settled, not succeeded: a 409 says the list on screen is stale.
    onSettled: refresh,
  });
  const updateLimit = useMutation({
    mutationFn: ({ id, ...figures }: { id: string; percent?: number; windowDays?: number; consecutiveDays?: number }) =>
      api.put<AbsenceWatchLimit>(`${BASE}/limits/${id}`, figures),
    onSettled: refresh,
  });
  const deleteLimit = useMutation({
    mutationFn: (id: string) => api.delete<void>(`${BASE}/limits/${id}`),
    onSettled: () => {
      refresh();
      // Removing a limit closes its open findings in the same transaction.
      void queryClient.invalidateQueries({ queryKey: ABSENCE_WATCH_KEYS.findings });
    },
  });
  return { updateSettings, createLimit, updateLimit, deleteLimit };
}
