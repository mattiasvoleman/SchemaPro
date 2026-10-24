"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { GUARDIAN_KEYS } from "@/lib/guardian-keys";
import type { AbsenceReport, LeaveRequest } from "@/lib/types";

// ---------------------------------------------------------------------------
// The guardian dashboard: children, absence reports, leave requests
//
// A module of its own, not a section of lib/queries.ts, for the bundle — the
// same reason lib/staffing-queries.ts is one. These five hooks were the only
// thing /guardian imported lib/queries.ts for, and that file is ~2 000 lines
// of every admin and teacher hook: importing one export pulls the whole
// module into the route, because Turbopack keeps a module whole when routes
// share it. /guardian therefore paid for the timetable editor's, the
// optimiser's and the room booker's hooks to show a parent their children,
// and sat on its 170KB budget to the decimal. Measured 2026-10-06 when they
// moved here: /guardian 170.0 -> 165.8KB own JS, and 25 other routes 0.1-0.2KB
// lighter.
//
// The admin leave inbox reads the leave hooks. It imports lib/queries.ts for
// other things anyway, so the split costs it only this module's extra chunk:
// 0.5KB (158.9 -> 159.4), far inside its budget of 190. The teacher's
// lesson-attendance page read useAbsenceReports until 20261015120000; a
// teacher reads no absence report since, and the page asks the gateway for
// ids (useLessonReportedAbsences). The keys are shared through
// lib/guardian-keys.ts, because useGuardianLinkActions over there invalidates
// the children list without importing this file.
//
// All three reads go through the gateway, not PostgREST, since the läslogg:
// a child's name, an absence note and a leave reason are other people's
// personal data, and the gateway records who read which. It also decides
// what the caller may see — a guardian their own children, a pupil
// themselves, an admin the school — so the hooks send only the filters the
// page asked for. PostgREST still answers a signed-in user's reads of their
// own row and of the tables the läslogg does not cover.
// ---------------------------------------------------------------------------

/**
 * A guardian's linked pupil as the gateway hands it out: what the dashboard
 * shows and nothing more. No role, email or phone — the page never showed a
 * child's contact details, so the read no longer carries them.
 */
export interface GuardianChild {
  /** The GuardianStudents row. */
  linkId: string;
  id: string;
  firstName: string;
  lastName: string;
  isActive: boolean;
  studentGroupId: string | null;
  /**
   * The day the child's school is on (YYYY-MM-DD): "today" for a report or
   * a leave about this child, whatever the browser's zone. Absent from a
   * gateway older than the field.
   */
  schoolToday?: string;
}

/**
 * The signed-in guardian's children. The gateway knows the guardian from the
 * token; the id is here to wait for the profile and to key the cache, so a
 * second sign-in in the same tab never shows the first guardian's children.
 */
export function useMyChildren(guardianUserId: string | null) {
  return useQuery({
    queryKey: [...GUARDIAN_KEYS.myChildren, guardianUserId],
    enabled: guardianUserId !== null,
    queryFn: () => api.get<GuardianChild[]>("/api/v1/family/children"),
  });
}

/** Absence reports the caller may see (own children / self / the school), with the note, newest day first. */
export function useAbsenceReports(options?: { date?: string; studentId?: string }) {
  return useQuery({
    queryKey: [...GUARDIAN_KEYS.absenceReports, options?.date ?? null, options?.studentId ?? null],
    queryFn: () => {
      const query = [
        options?.date ? `date=${encodeURIComponent(options.date)}` : null,
        options?.studentId ? `studentId=${encodeURIComponent(options.studentId)}` : null,
      ]
        .filter((part) => part !== null)
        .join("&");
      return api.get<AbsenceReport[]>(`/api/v1/absence-reports${query ? `?${query}` : ""}`);
    },
  });
}

export function useAbsenceReportActions() {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: GUARDIAN_KEYS.absenceReports });
  };
  const report = useMutation({
    mutationFn: (body: {
      studentId: string;
      date: string;
      startTime?: string;
      endTime?: string;
      type: "SICK" | "APPOINTMENT" | "OTHER";
      note?: string;
    }) => api.post("/api/v1/absence-reports", body),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/absence-reports/${id}`),
    onSuccess: invalidate,
  });
  return { report, remove };
}

/**
 * Leave requests the caller may see (guardian: children; pupil: self), newest
 * first, each with the role its decision was made in (decidedAs). The same
 * route answers rektor's and the mentor's inboxes with more on every row
 * (lib/leave-queries.ts); the dashboard reads the fields it always has.
 */
export function useLeaveRequests(status?: "PENDING" | "APPROVED" | "REJECTED") {
  return useQuery({
    queryKey: [...GUARDIAN_KEYS.leaveRequests, status ?? null],
    queryFn: () =>
      api.get<LeaveRequest[]>(
        `/api/v1/leave-requests${status ? `?status=${encodeURIComponent(status)}` : ""}`,
      ),
  });
}

export function useLeaveRequestActions() {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: GUARDIAN_KEYS.leaveRequests });
    void queryClient.invalidateQueries({ queryKey: GUARDIAN_KEYS.absenceReports });
    void queryClient.invalidateQueries({ queryKey: GUARDIAN_KEYS.leaveInbox });
  };
  const request = useMutation({
    mutationFn: (body: {
      studentId: string;
      startDate: string;
      endDate: string;
      reason: string;
    }) => api.post("/api/v1/leave-requests", body),
    onSuccess: invalidate,
  });
  return { request };
}
