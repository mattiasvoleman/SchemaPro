"use client";

import { useQueries, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { api } from "@/lib/api";
import {
  TIMPLAN_KEYS,
  type LocalTimplanDetail,
  type LocalTimplanStatus,
} from "@/lib/timplan-queries";
import { YEAR_TIMPLAN_KEYS } from "@/lib/year-timplan-keys";

/**
 * One row of "Timplan per årskurs": the lokal timplan an årskurs follows in a
 * läsår. Mirror of YearTimplanRow in src/timplan/year-timplans.ts. A grade
 * without a row follows no plan; `planStatus` is carried on every row so a
 * reader can mark a DRAFT as "utkast — inte beslutad" without a second read.
 */
export interface YearTimplanRow {
  gradeLevel: number;
  localTimplanId: string;
  planName: string;
  planStatus: LocalTimplanStatus;
}

/**
 * GET /academic-years/:id/timplans (SCHOOL_ADMIN), rather than PostgREST: the
 * gateway joins the plan's name and status, which a reader needs to say
 * "utkast" and PostgREST would need a second embedded select for.
 *
 * `enabled` lets a caller ask only while the rows are wanted — the
 * Timplansposter matrix reads them in Mål mode and not before.
 */
export function useYearTimplans(academicYearId: string | null, enabled = true) {
  return useQuery({
    queryKey: YEAR_TIMPLAN_KEYS.year(academicYearId ?? ""),
    enabled: enabled && academicYearId !== null,
    queryFn: () =>
      api.get<YearTimplanRow[]>(
        `/api/v1/academic-years/${encodeURIComponent(academicYearId!)}/timplans`,
      ),
  });
}

/**
 * Every plan a year attaches, with its entries — the targets themselves.
 *
 * Under TIMPLAN_KEYS.plan, the key /admin/timplan reads and its saves seed,
 * so an entry saved there is the entry read here. `data` is undefined until
 * every plan has answered: a target table with one plan missing would call
 * that plan's årskurs "no target", which is a statement, not a gap.
 *
 * `combine` is module-level so react-query can keep its result referentially
 * stable (it structurally shares the combined value while the inputs and the
 * function are unchanged), which is what lets a caller memoise on `data`.
 */
export function useLocalTimplanDetails(ids: readonly string[]) {
  return useQueries({
    queries: ids.map((id) => ({
      queryKey: TIMPLAN_KEYS.plan(id),
      queryFn: () =>
        api.get<LocalTimplanDetail>(`/api/v1/local-timplans/${encodeURIComponent(id)}`),
    })),
    combine: combineDetails,
  });
}

function combineDetails(results: UseQueryResult<LocalTimplanDetail>[]) {
  return {
    data: results.every((result) => result.data !== undefined)
      ? results.map((result) => result.data!)
      : undefined,
    isError: results.some((result) => result.isError),
  };
}
