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
    .select('id, student:Users!GuardianStudents_studentId_fkey(id, firstName, lastName)')
    .eq('guardianId', guardianId);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as unknown as ReadonlyArray<{
    id: string;
    student: { id: string; firstName: string; lastName: string } | null;
  }>;
  return rows
    .flatMap((row) => (row.student ? [{ linkId: row.id, ...row.student }] : []))
    .sort((a, b) => compareSwedish(a.firstName, b.firstName) || compareSwedish(a.lastName, b.lastName));
}
