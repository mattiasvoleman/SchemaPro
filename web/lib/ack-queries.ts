"use client";

import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { api } from "@/lib/api";
import {
  withConfirmedPages,
  type AckConfirmed,
  type AckCreated,
  type AckDetail,
  type AckListItem,
  type AckMine,
  type AckPage,
  type AckPupilChoice,
  type AckReminderStopped,
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
// request, and stopping its reminder: the author's or an administrator's), and
// /mine and a confirmation are the guardian's.
//
// The two lists are pages, newest first: the first has no `after`, and each
// answer names the id to ask the next after (`next`; null for the last). The
// page size is the gateway's (50), so no `limit` is sent.
//
// The pages are kept in the query's own cache under `{ pages, pageParams }`, the
// shape useInfiniteQuery uses, but read by a plain useQuery and a "next page"
// of our own: useInfiniteQuery is a cost on every route's shared react-query
// chunk (measured 42 bytes gzipped on /admin/requirements, which has 80 to
// spare; see use-ss12000-sync.ts). A read again of the list (a refresh, a refused
// confirmation) starts over at the newest page.
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

/** The route of one page: the first has no cursor. */
const pageOf = (path: string, after: string | undefined) => (after ? `${path}?after=${encodeURIComponent(after)}` : path);

type Pages<T> = InfiniteData<AckPage<T>, string | undefined>;

/**
 * A list read a page at a time: the first page is the query, and `fetchNextPage` asks for the one after
 * the last page held and adds it to the cache. A page that fails leaves the pages held where they are and
 * says so (`isFetchNextPageError`). The answer of `fetchNextPage` is the pages held afterwards, as
 * useInfiniteQuery's is, so a caller can look at what arrived.
 */
function usePagedList<T>(key: readonly unknown[], path: string) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: key,
    retry: false,
    queryFn: async (): Promise<Pages<T>> => ({ pages: [await api.get<AckPage<T>>(pageOf(path, undefined))], pageParams: [undefined] }),
  });
  const [fetching, setFetching] = useState(false);
  const [failed, setFailed] = useState(false);
  const after = query.data?.pages[query.data.pages.length - 1]?.next ?? undefined;

  const fetchNextPage = useCallback(async (): Promise<{ data: Pages<T> | undefined }> => {
    if (after === undefined || fetching) return { data: queryClient.getQueryData<Pages<T>>(key) };
    setFetching(true);
    setFailed(false);
    try {
      const page = await api.get<AckPage<T>>(pageOf(path, after));
      // Only when the list still ends where it did: a read again in between started it over.
      queryClient.setQueryData<Pages<T>>(key, (data) =>
        data && data.pages[data.pages.length - 1]?.next === after
          ? { pages: [...data.pages, page], pageParams: [...data.pageParams, after] }
          : data,
      );
    } catch {
      setFailed(true);
    } finally {
      setFetching(false);
    }
    return { data: queryClient.getQueryData<Pages<T>>(key) };
  }, [after, fetching, key, path, queryClient]);

  return {
    data: query.data,
    isLoading: query.isLoading,
    isSuccess: query.isSuccess,
    isError: query.isError,
    error: query.error,
    hasNextPage: after !== undefined,
    fetchNextPage,
    isFetchingNextPage: fetching,
    isFetchNextPageError: failed,
  };
}

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

/** The requests the reader may see, a page at a time, newest first, with counts and no names. */
export function useAckList() {
  return usePagedList<AckListItem>(ACK_KEYS.list, BASE);
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

/** The guardian's own requests, a page at a time, newest first, with their own confirmation. */
export function useAckMine() {
  return usePagedList<AckMine>(ACK_KEYS.mine, `${BASE}/mine`);
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
    // The gateway answers the time of the first confirmation, also to a second tap: write it into the pages
    // loaded, since the request may be on any of them.
    onSuccess: (done, id) =>
      queryClient.setQueryData<InfiniteData<AckPage<AckMine>, string | undefined>>(ACK_KEYS.mine, (data) =>
        data ? withConfirmedPages(data, id, done.ackedAt) : data,
      ),
    // 404 and 409 say the list on screen is stale: the request is no longer the guardian's.
    onError: () => void queryClient.invalidateQueries({ queryKey: ACK_KEYS.mine }),
  });
  const stopReminder = useMutation({
    mutationFn: (id: string) => api.post<AckReminderStopped>(`${BASE}/${id}/stop-reminder`),
    // The answer says only where the reminder ended up (STOPPED, or what it had already come to), and a 403 or a
    // 404 says the page on screen is stale: either way the list's cell and the request's line are read again,
    // not guessed.
    onSettled: (_stopped, _error, id) => {
      void queryClient.invalidateQueries({ queryKey: ACK_KEYS.list });
      void queryClient.invalidateQueries({ queryKey: ACK_KEYS.detail(id) });
    },
  });
  return { updateSettings, create, confirm, stopReminder };
}
