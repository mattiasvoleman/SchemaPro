"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { AFTER_PUBLISH, PUBLICATION_KEYS } from "@/lib/publication-keys";
import type {
  DraftState,
  ModeSwitchResult,
  PublicationOutcome,
  PublicationPreview,
  PublicationSettings,
  PublicationSettingsInput,
  PublicationTimeline,
  PublishInput,
  PublishMode,
  RefillOutcome,
} from "@/lib/publication-types";

/*
 * Publicering's reads and writes (src/publication/publications.controller.ts),
 * all through the gateway and all admin-only.
 *
 * Beside lib/queries.ts rather than in it, for the bundle: that module is in
 * every route's chunk graph, and these hooks belong to /admin/publishing and
 * to the timetable's review dialog, which the timetable fetches lazily. Only
 * useQuery and useMutation are used: react-query is in the chunk every route
 * shares, and a hook of its own the app does not use yet (useQueries, say)
 * would put its code on every route's bill.
 *
 * The preview is a POST that writes nothing — it materialises the window
 * inside a transaction it rolls back — so it is a QUERY here, keyed by the
 * window: cached while the dialog is open, never retried (a 409 is an answer),
 * and not refetched on focus, since the gateway allows ten a minute.
 */

export function usePublicationSettings(enabled = true) {
  return useQuery({
    queryKey: PUBLICATION_KEYS.settings,
    enabled,
    retry: false,
    queryFn: () => api.get<PublicationSettings>("/api/v1/publication-settings"),
  });
}

export function useUpdatePublicationSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: PublicationSettingsInput) =>
      api.put<PublicationSettings>("/api/v1/publication-settings", input),
    onSuccess: (settings) => {
      queryClient.setQueryData(PUBLICATION_KEYS.settings, settings);
      // A gate's mode decides the preview's severities.
      void queryClient.invalidateQueries({ queryKey: PUBLICATION_KEYS.preview });
    },
  });
}

export function usePublicationTimeline(academicYearId: string | null) {
  return useQuery({
    queryKey: [...PUBLICATION_KEYS.timeline, academicYearId],
    enabled: academicYearId !== null,
    retry: false,
    queryFn: () =>
      api.get<PublicationTimeline>(`/api/v1/publications?academicYearId=${academicYearId}`),
  });
}

/**
 * The draft against what is published. `revision` is the caller's word that
 * the grundschema changed (the timetable passes when its lessons were last
 * read), so the count follows the edits without a refetch per render.
 */
export function useDraftState(academicYearId: string | null, enabled: boolean, revision = 0) {
  return useQuery({
    queryKey: [...PUBLICATION_KEYS.state, academicYearId, revision],
    enabled: enabled && academicYearId !== null,
    retry: false,
    placeholderData: (previous) => previous,
    queryFn: () =>
      api.get<DraftState>(`/api/v1/publications/state?academicYearId=${academicYearId}`),
  });
}

export interface PublicationWindow {
  academicYearId: string;
  validFrom: string;
  validTo: string;
}

export function usePublicationPreview(window: PublicationWindow | null) {
  return useQuery({
    queryKey: [...PUBLICATION_KEYS.preview, window?.academicYearId, window?.validFrom, window?.validTo],
    enabled: window !== null,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 0,
    queryFn: () => api.post<PublicationPreview>("/api/v1/publications/preview", window),
  });
}

export function usePublishTimetable() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: PublishInput) => api.post<PublicationOutcome>("/api/v1/publications", input),
    onSettled: () => {
      // Settled, not success: a 409 PUBLISH_STALE means the preview behind
      // the dialog is out of date, and it is fetched again either way.
      for (const queryKey of AFTER_PUBLISH) void queryClient.invalidateQueries({ queryKey });
    },
  });
}

export function useSwitchPublishMode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (publishMode: PublishMode) =>
      api.post<ModeSwitchResult>("/api/v1/publication-settings/mode", { publishMode }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: PUBLICATION_KEYS.settings });
      void queryClient.invalidateQueries({ queryKey: PUBLICATION_KEYS.timeline });
      void queryClient.invalidateQueries({ queryKey: PUBLICATION_KEYS.state });
    },
  });
}

export function useDiscardDraft() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (academicYearId: string) =>
      api.post<{ restored: number; removed: number; safetyVersionId: string }>(
        "/api/v1/publications/discard",
        { academicYearId },
      ),
    onSuccess: () => {
      // The grundschema is the published one again, and a version was saved.
      for (const queryKey of [...AFTER_PUBLISH, ["masterLessons"], ["scheduleVersions"]]) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
  });
}

export function useRefillPublication() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: PublishInput) => api.post<RefillOutcome>("/api/v1/publications/refill", input),
    onSettled: () => {
      for (const queryKey of AFTER_PUBLISH) void queryClient.invalidateQueries({ queryKey });
    },
  });
}
