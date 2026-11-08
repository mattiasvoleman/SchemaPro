"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { GUARDIAN_KEYS } from "@/lib/guardian-keys";
import type { LeavePolicy } from "@/lib/types";

// ---------------------------------------------------------------------------
// Ledighetspolicy (K4): what the school asks of a leave request.
//
// A module of its own, like lib/guardian-queries.ts: /guardian (the form) and
// /admin/leave (the policy card) share these two hooks and nothing else, and
// /guardian is the heaviest route of its tier, so they must not drag the admin
// inbox's hooks (lib/leave-queries.ts) in. A guardian's answer to the request
// for consent is lib/leave-consent-queries.ts, which only the lazy chunk of
// the guardian's list imports.
//
// Everything is off as delivered: the policy of a school that has chosen
// nothing is { false, null, "REFUSE", "OFF" }, and a page shows only what the
// policy says.
// ---------------------------------------------------------------------------

/** The school's policy; every role in the school reads it, since it is what the form explains. */
export function useLeavePolicy() {
  return useQuery({
    queryKey: GUARDIAN_KEYS.leavePolicy,
    queryFn: () => api.get<LeavePolicy>("/api/v1/leave-policy"),
  });
}

/** Saves the whole policy (an administrator who decides; the gateway refuses anyone else with 403). */
export function useSaveLeavePolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (policy: LeavePolicy) => api.put<LeavePolicy>("/api/v1/leave-policy", policy),
    onSuccess: (saved) => {
      queryClient.setQueryData(GUARDIAN_KEYS.leavePolicy, saved);
      void queryClient.invalidateQueries({ queryKey: GUARDIAN_KEYS.leavePolicy });
    },
  });
}
