"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import type {
  CostBasis,
  CostCategory,
  CostRate,
  KeyFigures,
  PayrollBasis,
  PayrollFile,
  PayrollFormat,
  SchoolPart,
  SchoolPartInput,
} from "@/lib/analysis-types";

// ---------------------------------------------------------------------------
// Analys och planering, through the gateway (/api/v1/analysis). Not PostgREST:
// the figures are made of the load report, the rosters and the held lessons,
// and the gateway answers each reader what they are given (tjänstgöringsgrad
// only to a reader of HR data, the huvudman's reader the school's aggregates).
//
// A module of its own, not lib/queries.ts: that one is shared by 37 routes and
// sits on the chunker's merge edge, so a hook added to it is a cost on all of
// them.
// ---------------------------------------------------------------------------

const ROOT = ["analysis"] as const;
export const ANALYSIS_KEYS = {
  all: ROOT,
  keyFigures: (yearId: string) => [...ROOT, "keyFigures", yearId] as const,
  costBasis: (yearId: string) => [...ROOT, "costBasis", yearId] as const,
  payroll: (yearId: string, from: string, to: string) => [...ROOT, "payroll", yearId, from, to] as const,
  parts: [...ROOT, "parts"] as const,
  rates: [...ROOT, "rates"] as const,
};

const BASE = "/api/v1/analysis";

/** The codes the gateway refuses a reader with: a state of the tab, said calmly, and no error. */
export const COST_NOT_YOURS = "ANALYSIS_COST_NOT_YOURS";
export const HR_NOT_YOURS = "HR_NOT_YOURS";

export function isNotYours(error: unknown, code: string): boolean {
  return error instanceof ApiError && error.status === 403 && error.code === code;
}

/** The gateway limits each login's reads (ANALYSIS_RATE_LIMITED, 429): said with a wait, and no breakage. */
export function isRateLimited(error: unknown): boolean {
  return error instanceof ApiError && error.status === 429;
}

export function useKeyFigures(yearId: string | null) {
  return useQuery({
    queryKey: yearId ? ANALYSIS_KEYS.keyFigures(yearId) : [...ROOT, "keyFigures", "none"],
    enabled: yearId !== null,
    retry: false,
    queryFn: () => api.get<KeyFigures>(`${BASE}/key-figures?academicYearId=${yearId}`),
  });
}

export function useCostBasis(yearId: string | null) {
  return useQuery({
    queryKey: yearId ? ANALYSIS_KEYS.costBasis(yearId) : [...ROOT, "costBasis", "none"],
    enabled: yearId !== null,
    retry: false,
    queryFn: () => api.get<CostBasis>(`${BASE}/cost-basis?academicYearId=${yearId}`),
  });
}

/** Asked only for a period the page has submitted (null: nothing yet). */
export function usePayrollBasis(yearId: string | null, period: { from: string; to: string } | null) {
  return useQuery({
    queryKey: yearId && period ? ANALYSIS_KEYS.payroll(yearId, period.from, period.to) : [...ROOT, "payroll", "none"],
    enabled: yearId !== null && period !== null,
    retry: false,
    placeholderData: keepPreviousData,
    queryFn: () => api.get<PayrollBasis>(`${BASE}/payroll-basis?academicYearId=${yearId}&from=${period!.from}&to=${period!.to}`),
  });
}

export function useSchoolParts() {
  return useQuery({ queryKey: ANALYSIS_KEYS.parts, queryFn: () => api.get<SchoolPart[]>(`${BASE}/school-parts`) });
}

export function useCostRates() {
  return useQuery({ queryKey: ANALYSIS_KEYS.rates, queryFn: () => api.get<CostRate[]>(`${BASE}/cost-rates`) });
}

/** The file for a period, ordered at the click: the gateway builds it and the page hands it over. */
export function usePayrollFile() {
  return useMutation({
    mutationFn: (order: { academicYearId: string; from: string; to: string; format: PayrollFormat }) =>
      api.post<PayrollFile>(`${BASE}/payroll-basis/export`, order),
  });
}

/** The skoldelar and the rates change every figure that reads them, so a write drops every answer of the page. */
export function useAnalysisActions() {
  const client = useQueryClient();
  const done = () => client.invalidateQueries({ queryKey: ANALYSIS_KEYS.all });
  return {
    createPart: useMutation({ mutationFn: (input: SchoolPartInput) => api.post<SchoolPart>(`${BASE}/school-parts`, input), onSuccess: done }),
    updatePart: useMutation({
      mutationFn: ({ id, ...input }: Partial<SchoolPartInput> & { id: string }) => api.patch<SchoolPart>(`${BASE}/school-parts/${id}`, input),
      onSuccess: done,
    }),
    removePart: useMutation({ mutationFn: (id: string) => api.delete<void>(`${BASE}/school-parts/${id}`), onSuccess: done }),
    putRate: useMutation({
      mutationFn: ({ category, hourlyCost }: { category: CostCategory; hourlyCost: number }) =>
        api.put<CostRate>(`${BASE}/cost-rates/${category}`, { hourlyCost }),
      onSuccess: done,
    }),
    removeRate: useMutation({ mutationFn: (category: CostCategory) => api.delete<void>(`${BASE}/cost-rates/${category}`), onSuccess: done }),
  };
}
