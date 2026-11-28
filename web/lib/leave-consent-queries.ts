"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { GUARDIAN_KEYS } from "@/lib/guardian-keys";

/**
 * The person who filed a leave request takes it back while it waits (K6): POST /api/v1/leave-requests/:id/withdraw. A 409 says it was
 * decided in between (the lists are stale), so they are read again on settle, whichever way it went. Here, with the consent hook, because
 * only guardian/leave-extras.tsx, fetched when a request has something to do, imports either: /guardian's first load does not.
 */
export function useWithdrawLeave() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ id: string; status: "WITHDRAWN" }>(`/api/v1/leave-requests/${id}/withdraw`),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: GUARDIAN_KEYS.leaveRequests });
      void queryClient.invalidateQueries({ queryKey: GUARDIAN_KEYS.leaveInbox });
    },
  });
}

/**
 * A guardian's answer to the school's request for consent to a leave request
 * (Ledighetspolicy, K4). Final: the gateway refuses a second answer the other
 * way (409 LEAVE_CONSENT_ANSWERED), and a no ends the request for everybody.
 * On settle, not on success: a 409 says the lists are stale (the request was
 * decided or ended in between), so they are read again whichever way it went.
 *
 * A module of its own: only guardian/leave-extras.tsx, fetched when a request
 * carries something to say, imports it, so /guardian's first load does not.
 */
export function useAnswerLeaveConsent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, consent }: { id: string; consent: boolean }) =>
      api.post<{ id: string; answer: "GIVEN" | "REFUSED"; state: "WAITING" | "GIVEN" | "REFUSED" }>(
        `/api/v1/leave-requests/${id}/consent`,
        { consent },
      ),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: GUARDIAN_KEYS.leaveRequests });
      void queryClient.invalidateQueries({ queryKey: GUARDIAN_KEYS.leaveInbox });
    },
  });
}
