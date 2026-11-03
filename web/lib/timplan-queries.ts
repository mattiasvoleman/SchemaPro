"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { SchoolUnit } from "@/lib/school-units";
import type { GradeSpan, SchoolForm, TimplanCheck, TimplanVerdict } from "@/lib/timplan-coverage";
import type { GenerateBody, GenerateRequirementsResponse } from "@/lib/timplan-generate";
import { TIMPLAN_COVERAGE_KEYS } from "@/lib/year-timplan-keys";

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
  /**
   * The årskurser the plan is for, in the numbering of its lydelse (0 =
   * förskoleklass in the nine-year ones, the tioårig lydelse counts 1..10):
   * both set or both null, and null is the whole school form. See "The plan's
   * årskurs span" in src/common/timplan-coverage.ts.
   */
  gradeFrom: number | null;
  gradeTo: number | null;
  /**
   * Who and when, for a span set AFTER the plan was decided (the one change a
   * decided plan admits, once); null for a span chosen with the draft.
   */
  gradeSpanSetAt: string | null;
  gradeSpanSetByUserId: string | null;
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
  /** Both or neither; absent is the whole school form. */
  gradeFrom?: number | null;
  gradeTo?: number | null;
}

export interface UpdatePlanBody {
  name?: string;
  planningWeeks?: number;
  nationalTimplanVersionId?: string;
}

/**
 * The span of a copy or a reopened draft: ABSENT keys copy the source's span,
 * both null make the draft for the whole form, two numbers give it that span.
 */
export interface CopyPlanBody {
  name?: string;
  gradeFrom?: number | null;
  gradeTo?: number | null;
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

/**
 * The body of a copy or a reopen. The name only when typed; the span keys only
 * when the request states a span (two numbers, or two nulls for the whole
 * form): leaving them out is how the gateway knows to copy the source's.
 */
function copyBody({ name, gradeFrom, gradeTo }: CopyPlanBody): CopyPlanBody {
  return {
    ...(name ? { name } : {}),
    ...(gradeFrom !== undefined || gradeTo !== undefined
      ? { gradeFrom: gradeFrom ?? null, gradeTo: gradeTo ?? null }
      : {}),
  };
}

export function useLocalTimplans() {
  return useQuery({
    queryKey: TIMPLAN_KEYS.list,
    queryFn: () => api.get<LocalTimplanListItem[]>("/api/v1/local-timplans"),
  });
}

/*
 * The plan and its check are read afresh every time the page mounts
 * (refetchOnMount: "always"), whatever staleTime says. A subject deleted or
 * recoded on Ämnen changes both on the server — the cascade empties a draft's
 * cells, a new national code moves a row to another cell — and nothing on
 * that page invalidates these keys: doing so from lib/queries.ts would put
 * this module in every route's bundle. Coming back to Timplan within 30 s
 * showed the old cells and the old tones until then.
 */
export function useLocalTimplan(id: string | null) {
  return useQuery({
    queryKey: TIMPLAN_KEYS.plan(id ?? ""),
    enabled: id !== null,
    refetchOnMount: "always",
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
    refetchOnMount: "always",
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
  // The PATCH answers with the plan's columns and no entries: merged into
  // the cached detail at once, so the weeks field never flashes back to
  // the old figure while the refetch (which also recomputes the check —
  // new weeks, a new lydelse or a new span change every stage sum) is in
  // flight.
  const merge = (plan: LocalTimplan) => {
    queryClient.setQueryData<LocalTimplanDetail>(TIMPLAN_KEYS.plan(plan.id), (old) =>
      old ? { ...old, ...plan } : old,
    );
    refreshPlan(plan.id);
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
      onSuccess: merge,
    }),
    /**
     * The årskurs span of a plan, on its own request: a DRAFT takes any span
     * (null for the whole form), a DECIDED plan takes one ONCE, from none, and
     * nothing else with it — which is why it is not a field of `update`, whose
     * Spara sends the name and the weeks with it. The gateway stamps who and
     * when on the decided plan's span.
     */
    setSpan: useMutation({
      mutationFn: ({ id, span }: { id: string; span: GradeSpan | null }) =>
        api.patch<LocalTimplan>(path(id), {
          gradeFrom: span?.gradeFrom ?? null,
          gradeTo: span?.gradeTo ?? null,
        }),
      onSuccess: merge,
      // 409 TIMPLAN_IS_DECIDED: the page showed a draft that was decided (or a
      // decided plan that has since been given its span) in another tab. The
      // message is shown as it comes; the plan is read again so the page stops
      // offering what the gateway has just refused.
      onError: (error, { id }) => {
        if ((error as { code?: string }).code === "TIMPLAN_IS_DECIDED") refreshPlan(id);
      },
    }),
    replaceEntries: useMutation({
      mutationFn: ({ id, entries }: { id: string; entries: EntryBody[] }) =>
        api.put<{ plan: LocalTimplanDetail; check: LocalTimplanCheckResponse }>(
          path(id, "/entries"),
          { entries },
        ),
      // A save is PATCH then PUT, and the PATCH's refetch of the plan and its
      // check (the plan key is a prefix of the check key) reads the plan
      // BEFORE this PUT commits. Answering after the PUT, it wrote the old
      // cells over the ones the PUT seeds below — setQueryData does not stop
      // a fetch in flight — and the next save sent that stale grid wholesale.
      // Cancelled here, before the request, its answer is dropped.
      onMutate: async ({ id }) => {
        await queryClient.cancelQueries({ queryKey: TIMPLAN_KEYS.plan(id) });
      },
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
      mutationFn: ({ id, ...body }: CopyPlanBody & { id: string }) =>
        api.post<LocalTimplanDetail>(path(id, "/reopen"), copyBody(body)),
      onSuccess: seed,
    }),
    copy: useMutation({
      mutationFn: ({ id, ...body }: CopyPlanBody & { id: string }) =>
        api.post<LocalTimplanDetail>(path(id, "/copy"), copyBody(body)),
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
 * The school's skolenheter, for the span a new plan is prefilled with and the
 * notice that says when a plan's span is not the skolenheternas. SCHOOL_ADMIN
 * only (the table has no arm for anyone else under RLS), so a caller that is
 * not an admin passes `enabled` false and never sends the request. The key and
 * the path are admin/groups/use-school-units.ts's, so the two pages share one
 * cached answer; the hook is repeated here rather than imported from a route's
 * folder.
 */
export function useSchoolUnitsForSpan(enabled: boolean) {
  return useQuery({
    queryKey: ["school-units"],
    enabled,
    queryFn: () => api.get<SchoolUnit[]>("/api/v1/school-units"),
  });
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

/**
 * POST /local-timplans/:id/generate-requirements — "Skapa timplansposter".
 * A preview (dryRun true) writes nothing and invalidates nothing. An apply
 * invalidates the year's requirements (the Timplansposter matrix's key, by
 * its prefix and the year) and the year's coverage; the plan itself is
 * unchanged, so its keys are left alone.
 */
export function useGenerateRequirements() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ planId, ...body }: GenerateBody & { planId: string }) =>
      api.post<GenerateRequirementsResponse>(path(planId, "/generate-requirements"), body),
    onSuccess: (result) => {
      if (result.dryRun) return;
      void queryClient.invalidateQueries({ queryKey: ["requirements", result.academicYearId] });
      void queryClient.invalidateQueries({
        queryKey: TIMPLAN_COVERAGE_KEYS.year(result.academicYearId),
      });
    },
  });
}
