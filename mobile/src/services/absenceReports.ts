import { apiRequest } from './api';
import type { AbsenceReportRow, AbsenceReportType } from '../types';

/**
 * A guardian's absence reports (frånvaroanmälan), through the gateway.
 *
 * GET /api/v1/absence-reports answers the reports row security shows the
 * caller, a guardian's own children's, and records the read in the read log
 * (Läslogg). It orders them by date, newest first (then by when they were
 * made), and answers at most 200; the home screen shows the first 30 in that
 * order, as it did when it asked Supabase itself. reportedById decides
 * whether the home screen offers to take a report back (only its reporter
 * may); createdAt is carried but drawn nowhere.
 *
 * A report is made and withdrawn through the gateway too. It derives the
 * school from the pupil and the reporter from the bearer, so the phone no
 * longer reads the child's Users row to learn the school. It refuses another
 * family's child (403), a malformed report (400), and the withdrawal of a past
 * report or of one somebody else made (400, 403). A refusal is the gateway
 * client's ApiError, thrown as it came.
 */

const REPORTS_SHOWN = 30;

export async function fetchAbsenceReports(): Promise<AbsenceReportRow[]> {
  const rows = await apiRequest<AbsenceReportRow[]>('/api/v1/absence-reports');
  return rows.slice(0, REPORTS_SHOWN);
}

export interface AbsenceReportInput {
  readonly studentId: string;
  readonly date: string;
  readonly type: AbsenceReportType;
}

/**
 * A whole day away: the screen asks for no hours and no note, so none are
 * sent. The answer's date is the stored day as a timestamp (UTC midnight).
 */
export function reportAbsence(
  input: AbsenceReportInput,
): Promise<{ id: string; studentId: string; date: string }> {
  return apiRequest('/api/v1/absence-reports', {
    method: 'POST',
    body: { studentId: input.studentId, date: input.date, type: input.type },
  });
}

/**
 * Withdraws a report for today or later. The gateway refuses a past one (400),
 * and one another guardian made (403): only the reporter may withdraw it.
 */
export function removeAbsenceReport(id: string): Promise<{ id: string }> {
  return apiRequest(`/api/v1/absence-reports/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
