"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { AFTER_ROLLOVER, YEAR_KEYS } from "@/lib/year-keys";
import type { RolloverOptions, RolloverPreview, RolloverResult } from "@/lib/types";

/*
 * Läsårsrullning (POST /academic-years/:id/rollover[/preview]), for the
 * wizard on /admin/years/rollover. Beside the page for the bundle; see
 * lib/year-keys.ts.
 */

/**
 * The preview of the rollover the form describes. A query keyed on the
 * options, so the same form asks once and a changed one asks again; the
 * previous answer stays on screen while the next is computed
 * (placeholderData), so the counts do not blink to nothing on every
 * keystroke. Never retried: a 409 (already rolled, not yet activated) or a
 * 400 naming a field is the answer.
 */
export function useRolloverPreview(sourceYearId: string | null, options: RolloverOptions | null) {
  return useQuery({
    queryKey: [...YEAR_KEYS.rolloverPreview, sourceYearId, options],
    enabled: sourceYearId !== null && options !== null,
    retry: false,
    // keepPreviousData, written out: importing the helper puts it in the
    // react-query chunk every route shares (see use-year-activation.ts).
    placeholderData: (previous) => previous,
    queryFn: () =>
      api.post<RolloverPreview>(`/api/v1/academic-years/${sourceYearId}/rollover/preview`, options),
  });
}

/**
 * Creates the year, with the preview's hash and the graduating grade the
 * admin confirmed. The gateway plans again in its own transaction and answers
 * 409 ROLLOVER_PREVIEW_STALE if anything moved since the preview; everything
 * the new year now holds a copy of is refetched.
 */
export function useExecuteRollover(sourceYearId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: RolloverOptions & { graduatingGradeLevel: number; planHash: string }) =>
      api.post<RolloverResult>(`/api/v1/academic-years/${sourceYearId}/rollover`, body),
    onSettled: () => {
      for (const queryKey of AFTER_ROLLOVER) void queryClient.invalidateQueries({ queryKey });
    },
  });
}

/**
 * The value as it was `delayMs` after it last changed. The preview reads the
 * whole source year in one transaction; one per keystroke in the name field
 * would be a dozen for a word.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}
