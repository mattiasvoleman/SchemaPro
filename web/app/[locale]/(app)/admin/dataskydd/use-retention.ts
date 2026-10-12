"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "@/lib/api";
import type { MessageLookup } from "@/lib/engine-message";
import { PURGED_BEFORE_KEY } from "@/lib/retention-queries";
import type {
  RetentionDataType,
  RetentionDecisionInput,
  RetentionOverview,
  RetentionPreview,
} from "@/lib/retention-types";

/*
 * /admin/dataskydd's reads and its one write (src/gallring/gallring.
 * controller.ts), SCHOOL_ADMIN only. Nothing here removes a row: a decision
 * is recorded, and the night's run applies it (a period that gallrar more
 * after a day).
 */

export const RETENTION_KEYS = {
  overview: ["retentionOverview"],
  preview: ["retentionPreview"],
} as const;

export function useRetentionOverview() {
  return useQuery({
    queryKey: RETENTION_KEYS.overview,
    queryFn: () => api.get<RetentionOverview>("/api/v1/retention"),
  });
}

/** What `months` would take today, for the dialog before it is saved. Disabled without a period. */
export function useRetentionPreview(dataType: RetentionDataType, months: number | null) {
  return useQuery({
    queryKey: [...RETENTION_KEYS.preview, dataType, months],
    enabled: months !== null,
    // The previous count stays on screen while the next is fetched.
    placeholderData: keepPreviousData,
    queryFn: () =>
      api.get<RetentionPreview>(
        `/api/v1/retention/preview?dataType=${encodeURIComponent(dataType)}&months=${String(months)}`,
      ),
  });
}

export function useRecordDecision() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: RetentionDecisionInput) => api.post<RetentionOverview>("/api/v1/retention/decisions", input),
    onSuccess: (overview) => {
      queryClient.setQueryData(RETENTION_KEYS.overview, overview);
      void queryClient.invalidateQueries({ queryKey: PURGED_BEFORE_KEY });
    },
  });
}

/** A refusal's sentence: the catalogue's for its code, else the common one. `t` is useTranslations("dataProtection.errors"). */
export function retentionErrorText(t: MessageLookup, error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.code && /^[A-Z][A-Z0-9_]*$/.test(error.code) && t.has(error.code)) {
    return t(error.code);
  }
  return fallback;
}
