"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { STAFFING_KEYS } from "@/lib/staffing-keys";
import type { StaffingReconciliationResponse } from "@/lib/staffing-reconciliation";

/**
 * GET /staffing/delivered for one läsår and range (staffing Fas 3): planerat,
 * schemalagt och genomfört per lärare, computed by the gateway over P3's one
 * definition of held time. Null `from`/`to` lets the gateway choose its
 * defaults — the year's start and the school's today — and the answer says
 * which days it used.
 *
 * Page-specific (only the report tab reads it), so it lives beside the page.
 * Under STAFFING_KEYS.load's prefix: every staffing write that moves the
 * planned figures (a post, a row's teacher, a factor) invalidates that
 * prefix, and the reconciliation's planned column moves with it.
 *
 * A rolled year that is not yet activated answers R6's 409, as /staffing/load
 * does; the tab shows the gateway's sentence.
 */
export function useStaffingReconciliation(
  academicYearId: string | null,
  from: string | null,
  to: string | null,
) {
  return useQuery({
    queryKey: [...STAFFING_KEYS.load, "delivered", academicYearId, from, to],
    enabled: academicYearId !== null,
    queryFn: () => {
      const query = new URLSearchParams({ academicYearId: academicYearId! });
      if (from) query.set("from", from);
      if (to) query.set("to", to);
      return api.get<StaffingReconciliationResponse>(`/api/v1/staffing/delivered?${query.toString()}`);
    },
  });
}
