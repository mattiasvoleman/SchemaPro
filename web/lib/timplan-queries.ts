"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { SchoolForm, TimplanCheck, TimplanVerdict } from "@/lib/timplan-coverage";

// ---------------------------------------------------------------------------
// Lokala timplaner (src/timplan)
//
// A module of its own, not a section of lib/queries.ts, for the bundle — the
// argument lib/staffing-queries.ts makes. lib/queries.ts is in every route's
// chunk graph, and the guardian dashboard sits on its budget to the decimal;
// these hooks are read by one page, /admin/timplan, and are paid for there.
// The lokal timplan's own CSV import is a mutation here too rather than a kind
// of useImportCsv: its target is a PLAN, not a läsår, and adding a kind to the
// Record-keyed import tables in lib/queries.ts would put its endpoint string
// on every route for a dialog one page opens (see components/timplan/
// timplan-import-dialog.tsx).
//
// Everything is read through the gateway, not PostgREST, although the table's
// RLS arms would let an admin read the rows: the check is COMPUTED (the pure
// module over five tables), the detail joins the entries, and planningWeeks
// is a NUMERIC that PostgREST would hand over as text — the gateway turns it
// into a number once, through planningWeeksInTenths, so no page ever reads
// "35.6" as a string or a missing value as 0.
// ---------------------------------------------------------------------------

export type LocalTimplanStatus = "DRAFT" | "DECIDED";

/** Mirror of LocalTimplanResponse in src/timplan/local-timplans.service.ts. */
export interface LocalTimplan {
  id: string;
  schoolId: string;
  name: string;
  schoolForm: SchoolForm;
  nationalTimplanVersionId: string;
  /** A number with at most one decimal, 20.0..40.0. */
  planningWeeks: number;
  status: LocalTimplanStatus;
  decidedAt: string | null;
  decidedByUserId: string | null;
  decisionNote: string | null;
  copiedFromId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LocalTimplanListItem extends LocalTimplan {
  entryCount: number;
}

export interface LocalTimplanEntry {
  id: string;
  subjectId: string;
  gradeLevel: number;
  minutesPerWeek: number;
  note: string | null;
}

export interface LocalTimplanDetail extends LocalTimplan {
  entries: LocalTimplanEntry[];
}

/** The verdict document; each verdict carries the gateway's Swedish sentence. */
export interface LocalTimplanCheckResponse extends Omit<TimplanCheck, "verdicts"> {
  localTimplanId: string;
  verdicts: (TimplanVerdict & { message: string })[];
}

export interface EntryBody {
  subjectId: string;
  gradeLevel: number;
  minutesPerWeek: number;
  note?: string | null;
}

export interface CreatePlanBody {
  name: string;
  schoolForm: SchoolForm;
  nationalTimplanVersionId: string;
  planningWeeks?: number;
}

export interface UpdatePlanBody {
  name?: string;
  planningWeeks?: number;
  nationalTimplanVersionId?: string;
}

/** One row of a lokal timplan file, as ImportTimplanRowDto takes it. */
export interface TimplanImportRow {
  subject: string;
  gradeLevel: number;
  minutesPerWeek: number;
  note?: string;
}

export interface TimplanImportReport {
  created: number;
  updated?: number;
  skipped: number;
  errors: { row: number; message: string }[];
}

/**
 * The react-query keys, each the PREFIX invalidation matches on. A plan's
 * detail and its check live under the plan id, so one prefix refetches both.
 */
export const TIMPLAN_KEYS = {
  list: ["localTimplans"],
  plan: (id: string) => ["localTimplan", id] as const,
  check: (id: string) => ["localTimplan", id, "check"] as const,
} as const;

const path = (id: string, rest = "") => `/api/v1/local-timplans/${encodeURIComponent(id)}${rest}`;

export function useLocalTimplans() {
  return useQuery({
    queryKey: TIMPLAN_KEYS.list,
    queryFn: () => api.get<LocalTimplanListItem[]>("/api/v1/local-timplans"),
  });
}

export function useLocalTimplan(id: string | null) {
  return useQuery({
    queryKey: TIMPLAN_KEYS.plan(id ?? ""),
    enabled: id !== null,
    queryFn: () => api.get<LocalTimplanDetail>(path(id!)),
  });
}

/**
 * The SAVED plan's verdict document. While the grid has unsaved edits the
 * page computes its own from web/lib/timplan-coverage.ts; this is what it
 * falls back to the moment the edits are saved or thrown away.
 */
export function useLocalTimplanCheck(id: string | null) {
  return useQuery({
    queryKey: TIMPLAN_KEYS.check(id ?? ""),
    enabled: id !== null,
    queryFn: () => api.get<LocalTimplanCheckResponse>(path(id!, "/check")),
  });
}

/**
 * Every write on a plan. Each one refetches the list (status, name and entry
 * count are shown in the picker) and seeds or refetches the plan it touched.
 * The entries PUT answers with the plan AND its check, so both caches are set
 * from the answer rather than fetched again: the grid paints the gateway's
 * verdicts from the very response that saved them.
 */
export function useLocalTimplanActions() {
  const queryClient = useQueryClient();
  const refreshList = () => void queryClient.invalidateQueries({ queryKey: TIMPLAN_KEYS.list });
  const refreshPlan = (id: string) =>
    void queryClient.invalidateQueries({ queryKey: TIMPLAN_KEYS.plan(id) });
  const seed = (plan: LocalTimplanDetail) => {
    queryClient.setQueryData(TIMPLAN_KEYS.plan(plan.id), plan);
    refreshList();
  };

  return {
    create: useMutation({
      mutationFn: (body: CreatePlanBody) =>
        api.post<LocalTimplanDetail>("/api/v1/local-timplans", body),
      onSuccess: seed,
    }),
    update: useMutation({
      mutationFn: ({ id, ...body }: UpdatePlanBody & { id: string }) =>
        api.patch<LocalTimplan>(path(id), body),
      // The PATCH answers with the plan's columns and no entries: merged into
      // the cached detail at once, so the weeks field never flashes back to
      // the old figure while the refetch (which also recomputes the check —
      // new weeks or a new lydelse change every stage sum) is in flight.
      onSuccess: (plan) => {
        queryClient.setQueryData<LocalTimplanDetail>(TIMPLAN_KEYS.plan(plan.id), (old) =>
          old ? { ...old, ...plan } : old,
        );
        refreshPlan(plan.id);
        refreshList();
      },
    }),
    replaceEntries: useMutation({
      mutationFn: ({ id, entries }: { id: string; entries: EntryBody[] }) =>
        api.put<{ plan: LocalTimplanDetail; check: LocalTimplanCheckResponse }>(
          path(id, "/entries"),
          { entries },
        ),
      onSuccess: ({ plan, check }) => {
        queryClient.setQueryData(TIMPLAN_KEYS.plan(plan.id), plan);
        queryClient.setQueryData(TIMPLAN_KEYS.check(plan.id), check);
        refreshList();
      },
    }),
    decide: useMutation({
      mutationFn: ({ id, decisionNote }: { id: string; decisionNote: string }) =>
        api.post<LocalTimplan>(path(id, "/decide"), { decisionNote }),
      onSuccess: (plan) => {
        refreshPlan(plan.id);
        refreshList();
      },
    }),
    reopen: useMutation({
      mutationFn: ({ id, name }: { id: string; name?: string }) =>
        api.post<LocalTimplanDetail>(path(id, "/reopen"), name ? { name } : {}),
      onSuccess: seed,
    }),
    copy: useMutation({
      mutationFn: ({ id, name }: { id: string; name?: string }) =>
        api.post<LocalTimplanDetail>(path(id, "/copy"), name ? { name } : {}),
      onSuccess: seed,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api.delete<void>(path(id)),
      onSuccess: (_result, id) => {
        queryClient.removeQueries({ queryKey: TIMPLAN_KEYS.plan(id) });
        refreshList();
      },
    }),
  };
}

/**
 * POST /import/timplan into one DRAFT plan. One request: the endpoint takes
 * 400 rows, which is the plan's own cap, so a file that needs two requests is
 * a file that would not fit the plan either — the mapper refuses it before it
 * gets here.
 */
export function useImportTimplan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { localTimplanId: string; columns: string[]; rows: TimplanImportRow[] }) =>
      api.post<TimplanImportReport>("/api/v1/import/timplan", body),
    onSuccess: (_report, body) => {
      void queryClient.invalidateQueries({ queryKey: TIMPLAN_KEYS.plan(body.localTimplanId) });
      void queryClient.invalidateQueries({ queryKey: TIMPLAN_KEYS.list });
    },
  });
}
