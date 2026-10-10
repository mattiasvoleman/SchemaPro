"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "@/lib/api";
import { INTEGRATION_KEYS } from "./query-keys";
import type { ConnectionTest, ScheduleInput, SecretKind, SourceInput, SourceView } from "./ss12000-types";

/*
 * The school's SS12000 source (src/integration/ss12000-sync/
 * ss12000-source.service.ts): its configuration, the write-only credentials,
 * "Testa anslutning" and the schedule. SCHOOL_ADMIN only.
 *
 * A credential goes up once and never comes back: the source answers only
 * when each was set, and this file holds no value longer than the request
 * that sends it.
 */

/** The source, or null when the school has none yet (404 SS12000_SOURCE_NOT_FOUND). */
export function useSs12000Source() {
  return useQuery({
    queryKey: INTEGRATION_KEYS.source,
    retry: false,
    queryFn: async () => {
      try {
        return await api.get<SourceView>("/api/v1/ss12000-source");
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
  });
}

export function useSaveSource() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SourceInput) => api.put<SourceView>("/api/v1/ss12000-source", input),
    onSuccess: (source) => queryClient.setQueryData(INTEGRATION_KEYS.source, source),
  });
}

export function useSetSecret() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ kind, value }: { kind: SecretKind; value: string }) =>
      api.put<{ kind: SecretKind; setAt: string }>(`/api/v1/ss12000-source/secrets/${kind}`, { value }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: INTEGRATION_KEYS.source }),
  });
}

export function useClearSecret() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (kind: SecretKind) =>
      api.delete<{ kind: SecretKind; cleared: boolean }>(`/api/v1/ss12000-source/secrets/${kind}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: INTEGRATION_KEYS.source }),
  });
}

/** "Testa anslutning": a token, then the source's skolenheter to choose from. */
export function useTestConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<ConnectionTest>("/api/v1/ss12000-source/test"),
    // lastTestedAt and lastTestOutcome moved.
    onSettled: () => void queryClient.invalidateQueries({ queryKey: INTEGRATION_KEYS.source }),
  });
}

export function useSaveSchedule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ScheduleInput) => api.patch<SourceView>("/api/v1/ss12000-source/schedule", input),
    onSuccess: (source) => queryClient.setQueryData(INTEGRATION_KEYS.source, source),
  });
}
