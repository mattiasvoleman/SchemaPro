"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { STAFFING_KEYS } from "@/lib/staffing-keys";
import type { StaffingReconciliationResponse } from "@/lib/staffing-reconciliation";

/**
 * GET /staffing/delivered for one läsår and range (staffing Fas 3): planerat,
 * schemalagt och genomfört per lärare, computed by the gateway over P3's one
 * definition of held time. Null `from`/`to` lets the gateway choose its
 * defaults — the year's start and the school's yesterday — and the answer
 * says which days it used.
 *
 * A NEW RANGE KEEPS THE OLD FIGURES ON SCREEN while it loads (~1,7 s for a
 * 2 000-pupil school over a year): placeholderData hands back the previous
 * answer for the SAME läsår, flagged isPlaceholderData so the tab can dim it.
 * Another läsår's figures are never shown as a placeholder for this one.
 *
 * Page-specific (only the report tab reads it), so it lives beside the page.
 * Under STAFFING_KEYS.load's prefix: every staffing write that moves the
 * planned figures (a post, a row's teacher, a factor) invalidates that
 * prefix, and the reconciliation's planned column moves with it.
 *
 * A rolled year that is not yet activated answers R6's 409, as /staffing/load
 * does; the tab shows the gateway's sentence.
 */
/** Where the läsår sits in the query key. */
const YEAR_AT = STAFFING_KEYS.load.length + 1;

export function useStaffingReconciliation(
  academicYearId: string | null,
  from: string | null,
  to: string | null,
) {
  return useQuery({
    queryKey: [...STAFFING_KEYS.load, "delivered", academicYearId, from, to],
    enabled: academicYearId !== null,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[YEAR_AT] === academicYearId ? previous : undefined,
    queryFn: () => {
      const query = new URLSearchParams({ academicYearId: academicYearId! });
      if (from) query.set("from", from);
      if (to) query.set("to", to);
      return api.get<StaffingReconciliationResponse>(`/api/v1/staffing/delivered?${query.toString()}`);
    },
  });
}
