"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { INTEGRATION_KEYS } from "./query-keys";
import type { ProviderKey, Scope } from "./ss12000-types";

/*
 * The integration keys as the provider sees them
 * (src/integration/integration.controller.ts): scopes, whether a webhook
 * signing secret exists, and each key's subscriptions. The plaintext key and
 * a new signing secret are each in exactly one answer — the one that makes
 * them — and are held by the page only until the admin closes the notice.
 */

export function useProviderKeys(enabled: boolean) {
  return useQuery({
    queryKey: INTEGRATION_KEYS.providerKeys,
    enabled,
    retry: false,
    queryFn: () => api.get<ProviderKey[]>("/api/v1/integration-keys/provider"),
  });
}

function useInvalidateKeys() {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: INTEGRATION_KEYS.providerKeys });
}

export function useCreateKey() {
  const invalidate = useInvalidateKeys();
  return useMutation({
    mutationFn: (body: { name: string; scopes: Scope[] }) =>
      api.post<{ id: string; name: string; createdAt: string; key: string }>("/api/v1/integration-keys", body),
    onSuccess: invalidate,
  });
}

export function useUpdateScopes() {
  const invalidate = useInvalidateKeys();
  return useMutation({
    mutationFn: ({ id, scopes }: { id: string; scopes: Scope[] }) =>
      api.patch<{ id: string; scopes: Scope[] }>(`/api/v1/integration-keys/${id}`, { scopes }),
    onSuccess: invalidate,
  });
}

export function useRevokeKey() {
  const invalidate = useInvalidateKeys();
  return useMutation({
    mutationFn: (id: string) => api.delete<{ id: string }>(`/api/v1/integration-keys/${id}`),
    onSuccess: invalidate,
  });
}

/** A new signing secret, shown once; the previous one keeps signing for 24 hours. */
export function useCreateWebhookSecret() {
  const invalidate = useInvalidateKeys();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ id: string; secret: string; setAt: string | null }>(`/api/v1/integration-keys/${id}/webhook-secret`),
    onSuccess: invalidate,
  });
}

export function useSubscriptionState() {
  const invalidate = useInvalidateKeys();
  return useMutation({
    mutationFn: ({ keyId, subscriptionId, action }: { keyId: string; subscriptionId: string; action: "pause" | "resume" }) =>
      api.post<{ id: string; state: "PAUSED" | "ACTIVE" }>(
        `/api/v1/integration-keys/${keyId}/subscriptions/${subscriptionId}/${action}`,
      ),
    onSuccess: invalidate,
  });
}
