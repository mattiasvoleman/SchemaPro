"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { GUARDIAN_KEYS } from "@/lib/guardian-keys";
import type { LeaveRequestStatus } from "@/lib/types";

// ---------------------------------------------------------------------------
// The leave inboxes: rektor's /admin/leave and the mentor's /teacher/ledighet
// (Mentorns ledighetsbeslut, 20261023091000).
//
// Through the gateway, not PostgREST: the arms that let a mentor read and
// decide a request are the API's role's alone, so a teacher's own Supabase
// session reads no leave request at all. The admin reads through the same
// route, so both inboxes show the same facts: each request's skoldagar, who
// decides it now, and the pupil's leave so far this läsår. The family's own
// list reads the same route, without the facts (lib/guardian-queries.ts).
// ---------------------------------------------------------------------------

export type LeaveDecider = "MENTOR" | "ADMIN";

export interface LeaveDelegation {
  /** The mentor decides a request of at most this many skoldagar; null is no delegation. */
  mentorMaxSchoolDays: number | null;
  reference: string | null;
  decidedAt: string;
  decidedBy: string | null;
}

/**
 * One request of GET /api/v1/leave-requests (LeaveService.listLeaveRequests):
 * the row the families read (lib/guardian-queries.ts), and on it the names
 * and, for rektor and the mentor, the facts they decide on.
 */
export interface LeaveInboxRequest {
  id: string;
  studentId: string;
  requestedById: string;
  startDate: string;
  endDate: string;
  reason: string;
  status: LeaveRequestStatus;
  decidedById: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
  decidedAs: LeaveDecider | null;
  student: { id: string; name: string; className: string | null };
  requestedBy: string | null;
  decidedByName: string | null;
  referral: { by: string | null; at: string } | null;
  /** Null in a family's answer only. */
  schoolDays: number | null;
  /** Who decides it now; null once decided. */
  decides: LeaveDecider | null;
  mentors: Array<{ id: string; name: string }>;
  decidingMentors: Array<{ id: string; name: string }>;
  year: {
    name: string;
    startDate: string;
    endDate: string;
    approvedDays: number;
    approvedRequests: number;
    pendingRequests: number;
  } | null;
}

/** The caller's inbox of one status: every request of the school for rektor, the mentor's own for a teacher. */
export function useLeaveInbox(status: LeaveRequestStatus) {
  return useQuery({
    queryKey: [...GUARDIAN_KEYS.leaveInbox, status],
    retry: false,
    queryFn: () => api.get<LeaveInboxRequest[]>(`/api/v1/leave-requests?status=${status}`),
  });
}

/** Rektor's delegation in force and its history, for rektor and the mentors. */
export function useLeaveDelegation(enabled = true) {
  return useQuery({
    queryKey: GUARDIAN_KEYS.leaveDelegation,
    enabled,
    retry: false,
    queryFn: () => api.get<{ current: LeaveDelegation | null; history: LeaveDelegation[] }>("/api/v1/leave-delegation"),
  });
}

export function useLeaveInboxActions() {
  const queryClient = useQueryClient();
  // On settle, not on success: a 409 says the inbox is stale (a co-mentor
  // or rektor decided first, or the request was passed on), so it is read
  // again whichever way the decision went.
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: GUARDIAN_KEYS.leaveInbox });
    void queryClient.invalidateQueries({ queryKey: GUARDIAN_KEYS.leaveRequests });
    void queryClient.invalidateQueries({ queryKey: GUARDIAN_KEYS.absenceReports });
  };
  const decide = useMutation({
    mutationFn: ({ id, status, note }: { id: string; status: "APPROVED" | "REJECTED"; note?: string }) =>
      api.patch<{ id: string; status: string; decidedAs: LeaveDecider; absenceDays: number }>(
        `/api/v1/leave-requests/${id}/decide`,
        { status, ...(note ? { note } : {}) },
      ),
    onSettled: invalidate,
  });
  const refer = useMutation({
    mutationFn: (id: string) => api.patch<{ id: string; referred: boolean }>(`/api/v1/leave-requests/${id}/refer`),
    onSettled: invalidate,
  });
  const delegate = useMutation({
    mutationFn: (body: { mentorMaxSchoolDays: number | null; reference?: string }) =>
      api.post<LeaveDelegation>("/api/v1/leave-delegation", body),
    onSettled: () => {
      // A new delegation moves pending requests between the inboxes at once.
      void queryClient.invalidateQueries({ queryKey: GUARDIAN_KEYS.leaveDelegation });
      void queryClient.invalidateQueries({ queryKey: GUARDIAN_KEYS.leaveInbox });
    },
  });
  return { decide, refer, delegate };
}
