"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { AFTER_CANCELLATION, PUBLICATION_KEYS } from "@/lib/publication-keys";
import type {
  CancellationBatch,
  CancellationInput,
  CancellationPreview,
  CancellationSelection,
  ReversePreview,
} from "@/lib/publication-types";

/*
 * Bulk avbokning (src/publication/cancellation-batches.controller.ts),
 * beside the one page that uses it (lib/year-keys.ts says why).
 *
 * The preview is a MUTATION here, not a query: it belongs to a form, it is
 * asked for with a button, and its digest goes back with the create — a
 * preview fetched again behind the admin's back would carry a digest for a
 * selection they never read. The reversal's preview is a query, keyed by the
 * batch: the dialog asks for it as it opens.
 */

export function useCancellationBatches(academicYearId: string | null) {
  return useQuery({
    queryKey: [...PUBLICATION_KEYS.batches, academicYearId],
    enabled: academicYearId !== null,
    retry: false,
    queryFn: () =>
      api.get<CancellationBatch[]>(`/api/v1/cancellation-batches?academicYearId=${academicYearId}`),
  });
}

export function useCancellationPreview() {
  return useMutation({
    mutationFn: (selection: CancellationSelection) =>
      api.post<CancellationPreview>("/api/v1/cancellation-batches/preview", selection),
  });
}

function useAfterCancellation() {
  const queryClient = useQueryClient();
  return () => {
    for (const queryKey of AFTER_CANCELLATION) void queryClient.invalidateQueries({ queryKey });
  };
}

export function useCreateCancellationBatch() {
  const after = useAfterCancellation();
  return useMutation({
    mutationFn: (input: CancellationInput) =>
      api.post<{ batch: CancellationBatch; cancelled: number; credits: number }>(
        "/api/v1/cancellation-batches",
        input,
      ),
    onSettled: after,
  });
}

export function useReversePreview(batchId: string | null) {
  return useQuery({
    queryKey: [...PUBLICATION_KEYS.batches, "reverse", batchId],
    enabled: batchId !== null,
    retry: false,
    staleTime: 0,
    queryFn: () => api.post<ReversePreview>(`/api/v1/cancellation-batches/${batchId}/reverse/preview`),
  });
}

export function useReverseBatch() {
  const after = useAfterCancellation();
  return useMutation({
    mutationFn: (batchId: string) => api.post<ReversePreview>(`/api/v1/cancellation-batches/${batchId}/reverse`),
    onSettled: after,
  });
}

export function useReapplyBatch() {
  const after = useAfterCancellation();
  return useMutation({
    mutationFn: (batchId: string) =>
      api.post<{ batch: CancellationBatch; added: number }>(`/api/v1/cancellation-batches/${batchId}/reapply`),
    onSettled: after,
  });
}
