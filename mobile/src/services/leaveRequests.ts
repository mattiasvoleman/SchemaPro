import { apiRequest } from './api';
import type { LeaveRequestRow, LeaveRequestStatus } from '../types';

/**
 * Leave requests (ledighetsansökan), through the gateway.
 *
 * GET /api/v1/leave-requests answers the requests row security shows the
 * caller, a guardian's own children's with their reasons, and records the
 * read in the read log (Läslogg). Newest first, at most 200; the screen shows
 * the first 50 in that order, as it did when it asked Supabase itself. The
 * answer also carries who asked and who decided when, which no screen draws.
 *
 * A request is made through the gateway too. It derives the school from the
 * pupil and the requester from the bearer, so the phone no longer reads the
 * child's Users row, and it sends no status: a new request is undecided, and
 * the school decides it. A refusal (400 for an end before the start or a
 * reason outside 3..1000 characters, 403 for another family's child) is the
 * gateway client's ApiError, thrown as it came.
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
