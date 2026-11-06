"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { saveBase64 } from "@/lib/schedule-exchange";
import { downloadSchoolExport, type SchoolExportOrder, type SubjectAccessAnswer } from "@/lib/school-export";

/*
 * Hela skolans data (K5): the school's orders, ordering one, withdrawing one,
 * fetching its file, and a registerutdrag about one person. Only rektor and a
 * full administrator may do any of it; the gateway refuses everybody else, and
 * the card asks only when the profile is theirs.
 */

const KEY = ["schoolExports"] as const;
/** How often the list is read while an order is being built. */
export const POLL_MS = 5000;

export function useSchoolExports(enabled: boolean) {
  return useQuery({
    queryKey: KEY,
    enabled,
    queryFn: () => api.get<SchoolExportOrder[]>("/api/v1/school-exports"),
    // While one is being built the card watches it; otherwise it asks only when looked at.
    refetchInterval: (query) => (query.state.data?.some((order) => order.status === "QUEUED" || order.status === "RUNNING") ? POLL_MS : false),
  });
}

export function useOrderSchoolExport() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<SchoolExportOrder>("/api/v1/school-exports"),
    onSettled: () => client.invalidateQueries({ queryKey: KEY }),
  });
}

export function useWithdrawSchoolExport() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/api/v1/school-exports/${id}`),
    onSettled: () => client.invalidateQueries({ queryKey: KEY }),
  });
}

export function useFetchSchoolExport() {
  return useMutation({
    mutationFn: ({ id, finishedAt }: { id: string; finishedAt: string | null }) =>
      downloadSchoolExport(id, `rastra-skolexport-${(finishedAt ?? new Date().toISOString()).slice(0, 10)}.zip`),
  });
}

/** A registerutdrag, built in the request and saved at once. The answer tells the card what was held out. */
export function useSubjectAccess() {
  return useMutation({
    mutationFn: async (input: { personId: string; withRelated: boolean }) => {
      const answer = await api.post<SubjectAccessAnswer>("/api/v1/school-exports/subject-access", input);
      saveBase64(answer.filename, answer.contentType, answer.contentBase64);
      return answer;
    },
  });
}
