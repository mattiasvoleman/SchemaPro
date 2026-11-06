"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { CRISIS_KEYS } from "@/lib/crisis-keys";
import type {
  AlarmDetail,
  AlarmSummary,
  CrisisMode,
  CrisisSettings,
  MarkInput,
  MarkResult,
  ProtocolView,
  StartAlarmInput,
} from "@/lib/crisis-types";
import { isOpen } from "@/lib/crisis-view";

/*
 * Krisläge, the school's side (src/crisis/crisis.controller.ts,
 * CrisisAdminController): the settings, starting and ending an alarm, the live
 * view, the protocol, and the administration's own marks for a group nobody
 * answers for. Beside lib/queries.ts rather than in it, for the bundle.
 *
 * NOTHING HERE RETRIES A WRITE. A start that fails is the administrator's to
 * press again: 409 CRISIS_ALARM_OPEN means "one is already going, here it is",
 * and 403 CRISIS_NOT_YOURS "your profile may not". A mark that fails is shown
 * and pressed again; it carries its own id, so pressing twice stores one.
 *
 * The live view reads every five seconds while an alarm is open as well as on
 * the `crisis_updated` event (lib/use-crisis-realtime.ts): a socket that never
 * connects costs freshness, not correctness.
 */

export const OPEN_POLL_MS = 5_000;
const IDLE_POLL_MS = 30_000;

export function useCrisisSettings() {
  return useQuery({
    queryKey: CRISIS_KEYS.settings,
    retry: false,
    queryFn: () => api.get<CrisisSettings>("/api/v1/crisis/settings"),
  });
}

export function useSaveCrisisSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CrisisSettings) => api.put<CrisisSettings>("/api/v1/crisis/settings", input),
    onSuccess: (saved) => queryClient.setQueryData(CRISIS_KEYS.settings, saved),
  });
}

/** How many of the newest alarms the page looks through to find the ones that are open (at most one per mode is). */
const RECENT = 5;

/** The newest alarms; the open ones are among them. Polls faster while one is open. */
export function useRecentAlarms() {
  return useQuery({
    queryKey: CRISIS_KEYS.recent,
    retry: false,
    refetchInterval: (query) => (query.state.data?.some(isOpen) ? OPEN_POLL_MS : IDLE_POLL_MS),
    queryFn: () => api.get<AlarmSummary[]>(`/api/v1/crisis/alarms?limit=${RECENT}`),
  });
}

/** The protocol's list: real alarms and exercises are kept apart. */
export function useAlarmList(mode: CrisisMode) {
  return useQuery({
    queryKey: CRISIS_KEYS.list(mode),
    retry: false,
    queryFn: () => api.get<AlarmSummary[]>(`/api/v1/crisis/alarms?mode=${mode}&limit=50`),
  });
}

/** One alarm for the live view; read every five seconds while it is open. */
export function useAlarmDetail(id: string | null) {
  return useQuery({
    queryKey: CRISIS_KEYS.detail(id ?? ""),
    enabled: id !== null,
    retry: false,
    refetchInterval: (query) => (query.state.data && isOpen(query.state.data.alarm) ? OPEN_POLL_MS : false),
    queryFn: () => api.get<AlarmDetail>(`/api/v1/crisis/alarms/${id}`),
  });
}

/** The protocol of one alarm: its groups and the timeline of every mark. */
export function useProtocol(id: string | null) {
  return useQuery({
    queryKey: CRISIS_KEYS.protocol(id ?? ""),
    enabled: id !== null,
    retry: false,
    queryFn: () => api.get<ProtocolView>(`/api/v1/crisis/alarms/${id}/protocol`),
  });
}

export function useCrisisActions() {
  const queryClient = useQueryClient();
  const changed = () => void queryClient.invalidateQueries({ queryKey: CRISIS_KEYS.all });
  const start = useMutation({
    mutationFn: (input: StartAlarmInput) => api.post<AlarmDetail>("/api/v1/crisis/alarms", input),
    onSuccess: (started) => {
      // The live view opens on the answer; the rest follows the refetch.
      queryClient.setQueryData(CRISIS_KEYS.detail(started.alarm.id), started);
    },
    onSettled: changed,
  });
  const end = useMutation({
    mutationFn: (input: { id: string; note?: string }) =>
      api.post<AlarmDetail>(`/api/v1/crisis/alarms/${input.id}/end`, input.note ? { note: input.note } : {}),
    onSuccess: (ended) => queryClient.setQueryData(CRISIS_KEYS.detail(ended.alarm.id), ended),
    onSettled: changed,
  });
  const mark = useMutation({
    mutationFn: (input: { id: string; marks: MarkInput[] }) =>
      api.post<MarkResult>(`/api/v1/crisis/alarms/${input.id}/marks`, { marks: input.marks }),
    onSettled: changed,
  });
  return { start, end, mark };
}
