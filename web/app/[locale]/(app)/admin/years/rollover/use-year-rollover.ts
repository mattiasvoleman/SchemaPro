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
 *
 * `done` stops it once the rollover it previews has been made: the source
 * year now has a successor, so the same question would be answered 409
 * YEAR_HAS_SUCCESSOR while the page is on its way back to the years.
 */
export function useRolloverPreview(
  sourceYearId: string | null,
  options: RolloverOptions | null,
  done = false,
) {
  return useQuery({
    queryKey: [...YEAR_KEYS.rolloverPreview, sourceYearId, options],
    enabled: !done && sourceYearId !== null && options !== null,
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
 *
 * The preview itself is refetched only after a refusal, where the stale
 * preview is what has to be asked again. After a success it is marked stale
 * and left: the wizard's own preview is still mounted when this runs, and
 * refetching it would ask the gateway to plan a rollover of a year that now
 * has a successor — a 409 in the console before the page moves on
 * (webbgenomgången 2026-10-07). The wizard also stops it (`done`).
 */
export function useExecuteRollover(sourceYearId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: RolloverOptions & { graduatingGradeLevel: number; planHash: string }) =>
      api.post<RolloverResult>(`/api/v1/academic-years/${sourceYearId}/rollover`, body),
    onSettled: (_result, error) => {
      for (const queryKey of AFTER_ROLLOVER) {
        void queryClient.invalidateQueries({
          queryKey,
          refetchType: !error && queryKey === YEAR_KEYS.rolloverPreview ? "none" : "active",
        });
      }
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
