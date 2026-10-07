"use client";

import { useQuery } from "@tanstack/react-query";
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
 * One query for all of them, under a key that starts with
 * TIMPLAN_KEYS.list: every write on a plan (/admin/timplan's saves, decide,
 * reopen, import) invalidates that prefix, so an entry saved there is the
 * entry read here. `data` is undefined until every plan has answered: a
 * target table with one plan missing would call that plan's årskurs "no
 * target", which is a statement, not a gap.
 *
 * One `useQuery` over `Promise.all` and not `useQueries` per plan, for the
 * bundle: the matrix's Mål module is loaded lazily, and useQueries in a lazy
 * chunk made Turbopack re-slice react-query's shared internals (QueryObserver,
 * the suspense helpers) into a chunk every route loads — measured at +0,2 KB
 * on /admin/timetable, which has 0,5 KB of budget left. A school attaches one
 * or two plans, so fetching them together costs nothing a per-plan cache
 * would save.
 */
export function useLocalTimplanDetails(ids: readonly string[], enabled = true) {
  return useQuery({
    queryKey: [...TIMPLAN_KEYS.list, "details", ...ids],
    enabled,
    queryFn: () =>
      Promise.all(
        ids.map((id) =>
          api.get<LocalTimplanDetail>(`/api/v1/local-timplans/${encodeURIComponent(id)}`),
        ),
      ),
  });
}
