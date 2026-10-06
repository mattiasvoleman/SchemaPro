"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/utils/supabase/client";
import { api } from "@/lib/api";
import { GUARDIAN_KEYS } from "@/lib/guardian-keys";
import type { AbsenceReport, LeaveRequest, Person } from "@/lib/types";

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
// The teacher's lesson-attendance page reads useAbsenceReports and the admin
// leave inbox reads the leave hooks. Both import lib/queries.ts for other
// things anyway, so the split costs them only this module's extra chunk:
// 0.5KB each (158.0 -> 158.5 and 158.9 -> 159.4), far inside their budgets
// of 170 and 190. The keys are shared through
// lib/guardian-keys.ts, because useGuardianLinkActions over there invalidates
// the children list without importing this file.
// ---------------------------------------------------------------------------

/** The signed-in guardian's children (via GuardianStudents, RLS-scoped). */
export function useMyChildren(guardianUserId: string | null) {
  return useQuery({
    queryKey: [...GUARDIAN_KEYS.myChildren, guardianUserId],
    enabled: guardianUserId !== null,
    queryFn: async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("GuardianStudents")
        .select(
          "id, studentId, student:Users!GuardianStudents_studentId_fkey(id, role, firstName, lastName, email, phone, isActive, studentGroupId)",
        )
        .eq("guardianId", guardianUserId!);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as unknown as Array<{
        id: string;
        studentId: string;
        student: Person;
      }>;
      return rows.map((row) => ({ linkId: row.id, ...row.student }));
    },
  });
}

/** Absence reports visible to the caller (RLS: own children / own / staff). */
export function useAbsenceReports(options?: { date?: string; studentId?: string }) {
  return useQuery({
    queryKey: [...GUARDIAN_KEYS.absenceReports, options?.date ?? null, options?.studentId ?? null],
    queryFn: async () => {
      const supabase = createClient();
      let query = supabase
        .from("AbsenceReports")
        .select(
          "id, studentId, reportedById, date, startTime, endTime, type, note, createdAt",
        )
        .order("date", { ascending: false })
        .limit(200);
      if (options?.date) query = query.eq("date", options.date);
      if (options?.studentId) query = query.eq("studentId", options.studentId);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      return (data ?? []) as AbsenceReport[];
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

/** Leave requests visible to the caller (guardian: children; admin: all). */
export function useLeaveRequests(status?: "PENDING" | "APPROVED" | "REJECTED") {
  return useQuery({
    queryKey: [...GUARDIAN_KEYS.leaveRequests, status ?? null],
    queryFn: async () => {
      const supabase = createClient();
      let query = supabase
        .from("LeaveRequests")
        .select(
          "id, studentId, requestedById, startDate, endDate, reason, status, decidedById, decidedAt, decisionNote, createdAt",
        )
        .order("createdAt", { ascending: false })
        .limit(200);
      if (status) query = query.eq("status", status);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      return (data ?? []) as LeaveRequest[];
    },
  });
}

export function useLeaveRequestActions() {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: GUARDIAN_KEYS.leaveRequests });
    void queryClient.invalidateQueries({ queryKey: GUARDIAN_KEYS.absenceReports });
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
  const decide = useMutation({
    mutationFn: ({ id, status, note }: { id: string; status: "APPROVED" | "REJECTED"; note?: string }) =>
      api.patch(`/api/v1/leave-requests/${id}/decide`, { status, ...(note ? { note } : {}) }),
    onSuccess: invalidate,
  });
  return { request, decide };
}
