import { apiRequest } from './api';
import type { LeaveRequestRow, LeaveRequestStatus } from '../types';

/**
 * Leave requests (ledighetsansökan), through the gateway.
 *
 * GET /api/v1/leave-requests answers the requests row security shows the
 * caller, a guardian's own children's with their reasons, and records the
 * read in the read log (Läslogg). Newest first, at most 200; the screen shows
 * the first 50 in that order, as it did when it asked Supabase itself. Each
 * row carries the role its decision was made in: the pupil's mentor or
 * rektor (decidedAs, Mentorns ledighetsbeslut). The answer also carries who
 * asked, who decided when and the names, which no screen draws.
 *
 * A request is made through the gateway too. It derives the school from the
 * pupil and the requester from the bearer, so the phone no longer reads the
 * child's Users row, and it sends no status: a new request is undecided, and
 * the school decides it; when the request is short enough for the school's
 * delegation the database tells the pupil's mentor. A refusal (400 for an end
 * before the start, a request of more than a year or a reason outside 3..1000
 * characters, 403 for another family's child) is the gateway client's
 * ApiError, thrown as it came.
 */

const LEAVES_SHOWN = 50;

export async function fetchLeaveRequests(): Promise<LeaveRequestRow[]> {
  const rows = await apiRequest<LeaveRequestRow[]>('/api/v1/leave-requests');
  return rows.slice(0, LEAVES_SHOWN);
}

export interface LeaveRequestInput {
  readonly studentId: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly reason: string;
}

/** The reason is sent trimmed, the way the screen measured it. */
export function requestLeave(
  input: LeaveRequestInput,
): Promise<{ id: string; studentId: string; status: LeaveRequestStatus }> {
  return apiRequest('/api/v1/leave-requests', {
    method: 'POST',
    body: {
      studentId: input.studentId,
      startDate: input.startDate,
      endDate: input.endDate,
      reason: input.reason.trim(),
    },
  });
}

/** Who decided, as the list says it: the mentor, rektor, or nothing (still waiting, or decided before roles were recorded). */
export function deciderOf(row: Pick<LeaveRequestRow, 'status' | 'decidedAs'>): 'MENTOR' | 'ADMIN' | null {
  if (row.status === 'PENDING') return null;
  return row.decidedAs ?? null;
}
