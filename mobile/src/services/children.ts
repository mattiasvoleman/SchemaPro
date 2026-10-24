import { apiRequest } from './api';
import type { ChildRow } from '../types';
import { compareSwedish } from '../utils/sorting';

/** One linked pupil as GET /api/v1/family/children answers it. */
interface ChildView {
  readonly linkId: string;
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly isActive: boolean;
  readonly studentGroupId: string | null;
  readonly schoolToday?: string;
}

/**
 * The signed-in guardian's children, as the gateway answers them
 * (GET /api/v1/family/children) and records the read (Läslogg). The guardian
 * is the bearer's: the gateway reads that guardian's own links and nothing
 * else, so another family's child is not even a row to filter out, and there
 * is no guardian id to send.
 *
 * One function for the three guardian screens (home, leave, schedule), which
 * each carried an identical copy. Ordered by first name so the chips keep
 * their places between screens and between refreshes; the gateway's own order
 * is by link id, stable but meaningless to a reader.
 */
export async function fetchChildren(): Promise<ChildRow[]> {
  const rows = await apiRequest<ChildView[]>('/api/v1/family/children');
  return rows
    .map(({ linkId, id, firstName, lastName, isActive, schoolToday }) => ({
      linkId,
      id,
      firstName,
      lastName,
      isActive,
      ...(schoolToday ? { schoolToday } : {}),
    }))
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
