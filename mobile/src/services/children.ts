import { getSupabase } from './supabase';
import type { ChildRow } from '../types';
import { compareSwedish } from '../utils/sorting';

/**
 * The signed-in guardian's children, through GuardianStudents under RLS: a
 * guardian reads their own links and nothing else, so another family's child
 * is not even a row to filter out.
 *
 * One function for the three guardian screens (home, leave, schedule), which
 * each carried an identical copy. Ordered by first name so the chips keep
 * their places between screens and between refreshes.
 */
export async function fetchChildren(guardianId: string): Promise<ChildRow[]> {
  const { data, error } = await getSupabase()
    .from('GuardianStudents')
    .select('id, student:Users!GuardianStudents_studentId_fkey(id, firstName, lastName, isActive)')
    .eq('guardianId', guardianId);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as unknown as ReadonlyArray<{
    id: string;
    student: { id: string; firstName: string; lastName: string; isActive: boolean } | null;
  }>;
  return rows
    .flatMap((row) => (row.student ? [{ linkId: row.id, ...row.student }] : []))
    .sort((a, b) => compareSwedish(a.firstName, b.firstName) || compareSwedish(a.lastName, b.lastName));
}

/**
 * The Schema tab's children: those still at school. A pupil who has left is
 * still a link (users_guardian_children_select asks no isActive), but the
 * gateway answers their week with the same 404 as a stranger's, so offering
 * them would only offer an error.
 */
export function scheduleChildren(rows: readonly ChildRow[]): ChildRow[] {
  return rows.filter((row) => row.isActive);
}

export type ChildListState = 'LOADING' | 'FAILED' | 'NONE' | 'READY';

/**
 * What a guardian screen says about its child list. A failed read is a
 * failure to retry, never "no children linked" — that sentence tells a
 * guardian to ask the school for something that is already there. A refresh
 * that fails keeps the children already on screen.
 */
export function childListState(state: { loading: boolean; failed: boolean; count: number }): ChildListState {
  if (state.loading) return 'LOADING';
  if (state.count > 0) return 'READY';
  return state.failed ? 'FAILED' : 'NONE';
}
