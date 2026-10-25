"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

/*
 * The school's side of its huvudman (Huvudman, 20261212090000;
 * src/huvudman/huvudman.controller.ts HuvudmanOwnershipController): every
 * administrator reads it, rektor or a full administrator answers.
 */

export interface SchoolHuvudman {
  owner: { id: string; name: string; organisationNumber: string | null; since: string; acceptedBy: string | null } | null;
  requests: Array<{ huvudmanId: string; name: string; organisationNumber: string | null; requestedAt: string }>;
  readers: Array<{
    id: string;
    firstName: string;
    lastName: string;
    role: "KOMMUNADMINISTRATOR" | "PLANERARE";
    isActive: boolean;
    /** The login's own row at the school: ACTIVE, the person here; INACTIVE, read as the huvudman's in its place. */
    ownRow: "ACTIVE" | "INACTIVE" | null;
  }>;
  /** The huvudman's keys; null for an administrator who does not decide (the gateway's answer). */
  keys: Array<{ id: string; name: string; scopes: string[]; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }> | null;
  history: Array<{ at: string; kind: string; huvudmanName: string; byHuvudman: boolean }>;
}

export const HUVUDMAN_OWNERSHIP_KEY = ["huvudmanOwnership"] as const;

export function useSchoolHuvudman() {
  return useQuery({
    queryKey: HUVUDMAN_OWNERSHIP_KEY,
    queryFn: () => api.get<SchoolHuvudman>("/api/v1/huvudman-ownership"),
  });
}

export type HuvudmanAnswer = { kind: "accept" | "decline"; huvudmanId: string } | { kind: "leave" };

export function useAnswerHuvudman() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (answer: HuvudmanAnswer) =>
      answer.kind === "leave"
        ? api.delete<void>("/api/v1/huvudman-ownership")
        : api.post<void>(`/api/v1/huvudman-ownership/requests/${answer.huvudmanId}/${answer.kind}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: HUVUDMAN_OWNERSHIP_KEY }),
  });
}
