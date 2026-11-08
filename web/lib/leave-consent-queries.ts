"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { GUARDIAN_KEYS } from "@/lib/guardian-keys";

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
