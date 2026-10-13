import { profileReadsHr } from '../auth/admin-areas';
import { Role } from '../auth/enums/role.enum';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import type { LogChange } from './employment-log-diff';

/**
 * Tjänst % and nedsättning are HR data (Roller i skolan): rektor and a full
 * administrator read them, and a schemaläggare or an expedition with HR-läs.
 *
 * Row security cannot hide a column, and the post's row also carries what
 * every administrator's work needs: the lärarsignatur the schedule shows and
 * the target in minutes that tjänstefördelning is measured against. So every
 * administrator reads the row, the gateway is the only path to another
 * person's post (the administrators' arms are the API role's alone since
 * 20261028090000), and the gateway leaves the two percentages out here, as
 * null with `hrHidden: true`, for anybody else.
 * The note goes too, since it is where a reason for a nedsättning would be
 * written, and the post's periods (Tjänstens perioder): when and how a post
 * changes during the year is HR data like the percentages. Figures computed from the percentages that would give one of them
 * back exactly go as well (a subject's share of the tjänst).
 *
 * A teacher reads their own post and nobody else's, which the services
 * already filter; this answers only for administrators.
 */
export function readsHr(user: AuthenticatedUser): boolean {
  return user.role !== Role.SCHOOL_ADMIN || profileReadsHr(user.adminProfile, user.hrRead);
}

/** The two percentages, as the log's before and after name them. */
const HR_FIELDS = new Set(['employmentPercent', 'reductionPercent']);

/** A post with its HR left out. */
export function hideHr<T extends { employmentPercent: number; reductionPercent: number }>(
  row: T,
): Omit<T, 'employmentPercent' | 'reductionPercent'> & {
  employmentPercent: null;
  reductionPercent: null;
  note?: null;
  hrHidden: true;
} {
  return {
    ...row,
    employmentPercent: null,
    reductionPercent: null,
    ...('note' in row ? { note: null } : {}),
    ...('periods' in row ? { periods: [] } : {}),
    hrHidden: true,
  };
}

/** A version's changes with the percentages' values left out; that they changed is still said. */
export function hideHrChanges(changes: LogChange[]): (LogChange & { hrHidden?: true })[] {
  return changes.map((change) =>
    HR_FIELDS.has(change.field) ? { field: change.field, before: null, after: null, hrHidden: true } : change,
  );
}
