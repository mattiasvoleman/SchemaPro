"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { TIMPLAN_COVERAGE_KEYS } from "@/lib/year-timplan-keys";

/**
 * Tillgodoräknad tid: the school's written decision that one day's activity
 * counts as undervisningstid — "Friluftsdag, 300 min Idrott och hälsa, åk
 * 7–9" (migration 20261009100000; GET/POST/PATCH/DELETE /timplan-credits).
 *
 * Read and written by Lov & studiedagar alone, so the hooks live in a file
 * only that page imports. A write invalidates the year's credits and every
 * timplan coverage answer: a credit is delivered time in layer 3, and
 * Täckning should never show yesterday's decision.
 */

/** One credit as the API answers it; dates as YYYY-MM-DD, never an instant. */
export interface TimplanCredit {
  id: string;
  academicYearId: string;
  date: string;
  minutes: number;
  /** Null: undervisningstid without a subject ("Utan ämne"). */
  subjectId: string | null;
  /** The scope: a group, a grade span, or neither (the whole school). */
  studentGroupId: string | null;
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
  name: string;
  note: string | null;
}

/** The body of a create; a PATCH sends the same fields bar the year. */
export type TimplanCreditInput = Omit<TimplanCredit, "id">;

export const TIMPLAN_CREDIT_KEYS = {
  all: ["timplanCredits"],
  year: (academicYearId: string) => ["timplanCredits", academicYearId] as const,
} as const;

export function useTimplanCredits(academicYearId: string | null) {
  return useQuery({
    queryKey: TIMPLAN_CREDIT_KEYS.year(academicYearId ?? ""),
    enabled: academicYearId !== null,
    queryFn: () =>
      api.get<TimplanCredit[]>(`/api/v1/timplan-credits?academicYearId=${encodeURIComponent(academicYearId!)}`),
  });
}

export function useTimplanCreditActions() {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: TIMPLAN_CREDIT_KEYS.all });
    void queryClient.invalidateQueries({ queryKey: TIMPLAN_COVERAGE_KEYS.all });
  };
  const create = useMutation({
    mutationFn: (body: TimplanCreditInput) => api.post<TimplanCredit>("/api/v1/timplan-credits", body),
    onSuccess: invalidate,
  });
  const update = useMutation({
    // The scope triple is always sent whole: the API replaces it when any of
    // the three is named (R25), so a credit moved from a span to a group
    // cannot keep half its span.
    mutationFn: ({ id, academicYearId: _year, ...body }: TimplanCredit) =>
      api.patch<TimplanCredit>(`/api/v1/timplan-credits/${id}`, body),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/timplan-credits/${id}`),
    onSuccess: invalidate,
  });
  return { create, update, remove };
}

/**
 * The credits dated inside a lov or studiedag, in date order: the breaks page
 * says them under that break. Here rather than beside the dialog's form
 * (lib/timplan-credit-form.ts), which only the lazily fetched dialog imports.
 */
export function creditsInside<T extends { date: string; id: string }>(
  credits: readonly T[],
  range: { startDate: string; endDate: string },
): T[] {
  return credits
    .filter((credit) => credit.date >= range.startDate && credit.date <= range.endDate)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));
}
