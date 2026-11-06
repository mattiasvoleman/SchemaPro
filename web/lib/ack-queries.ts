"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import {
  withConfirmed,
  type AckConfirmed,
  type AckCreated,
  type AckDetail,
  type AckListItem,
  type AckMine,
  type AckPupilChoice,
  type AckSettings,
  type AckSettingsChange,
} from "@/lib/ack";

// ---------------------------------------------------------------------------
// Kvittens: the school's switch, the staff's requests and the guardian's own
// list, through the gateway (/api/v1/acknowledgements). Not PostgREST: the
// gateway answers per role from the database's row security, and records the
// reads that name people (the pupils a request can be about, and a request
// opened with who confirmed it) in the läslogg.
//
// A module of its own, not lib/queries.ts: that one is shared by 37 routes and
// sits on the chunker's merge edge, so a hook added to it is a cost on all of
// them.
//
// What each reader gets is the database's say, not this module's: the settings
// and the lists are the staff's (an administrator's every request, a teacher's
// own), the writes are an administrator's (the switch) and the staff's (a
// request), and /mine and a confirmation are the guardian's.
// ---------------------------------------------------------------------------

const ROOT = ["ack"] as const;
export const ACK_KEYS = {
  all: ROOT,
  settings: [...ROOT, "settings"] as const,
  pupils: [...ROOT, "pupils"] as const,
  list: [...ROOT, "list"] as const,
  detail: (id: string) => [...ROOT, "detail", id] as const,
  mine: [...ROOT, "mine"] as const,
};

const BASE = "/api/v1/acknowledgements";

/** The school's switch and the days before the one reminder. A teacher reads it too. */
export function useAckSettings() {
  return useQuery({
    queryKey: ACK_KEYS.settings,
    retry: false,
    queryFn: () => api.get<AckSettings>(`${BASE}/settings`),
  });
}

/**
 * The pupils the reader may ask about, with how many guardians each has. Read
 * when the form is open and not before, and not kept after it: the gateway
 * records each reading in the läslogg, and a list of pupils is not something
 * to leave in the cache of a page that no longer shows it.
 */
export function useAckPupils() {
  return useQuery({
    queryKey: ACK_KEYS.pupils,
    retry: false,
    gcTime: 0,
    staleTime: 0,
    queryFn: () => api.get<AckPupilChoice[]>(`${BASE}/pupils`),
  });
}

/** The requests the reader may see, newest first, with counts and no names. */
export function useAckList() {
  return useQuery({
    queryKey: ACK_KEYS.list,
    retry: false,
    queryFn: () => api.get<AckListItem[]>(BASE),
  });
}

/** One request with who confirmed and when. Recorded in the läslogg, so read when opened and not kept. */
export function useAckDetail(id: string) {
  return useQuery({
    queryKey: ACK_KEYS.detail(id),
    retry: false,
    gcTime: 0,
    staleTime: 0,
    queryFn: () => api.get<AckDetail>(`${BASE}/${id}`),
  });
}

/** The guardian's own requests, with their own confirmation. */
export function useAckMine() {
  return useQuery({
    queryKey: ACK_KEYS.mine,
    retry: false,
    queryFn: () => api.get<AckMine[]>(`${BASE}/mine`),
  });
}

export function useAckActions() {
  const queryClient = useQueryClient();
  const updateSettings = useMutation({
    mutationFn: (change: AckSettingsChange) => api.put<AckSettings>(`${BASE}/settings`, change),
    // The answer is the whole setting: the switch shows what was saved.
    onSuccess: (saved) => queryClient.setQueryData(ACK_KEYS.settings, saved),
    // A refused save says the setting on screen may be stale.
    onError: () => void queryClient.invalidateQueries({ queryKey: ACK_KEYS.settings }),
  });
  const create = useMutation({
    mutationFn: (body: { title: string; body: string; rule: string; studentIds: string[] }) =>
      api.post<AckCreated>(BASE, body),
    // The list gains the request. A refusal says nothing about the list, but 409 ACK_DISABLED says the switch moved.
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ACK_KEYS.list }),
    onError: () => void queryClient.invalidateQueries({ queryKey: ACK_KEYS.settings }),
  });
  const confirm = useMutation({
    mutationFn: (id: string) => api.post<AckConfirmed>(`${BASE}/${id}/confirm`),
    // The gateway answers the time of the first confirmation, also to a second tap: write it into the list.
    onSuccess: (done, id) =>
      queryClient.setQueryData<AckMine[]>(ACK_KEYS.mine, (list) => (list ? withConfirmed(list, id, done.ackedAt) : list)),
    // 404 and 409 say the list on screen is stale: the request is no longer the guardian's.
    onError: () => void queryClient.invalidateQueries({ queryKey: ACK_KEYS.mine }),
  });
  return { updateSettings, create, confirm };
}
