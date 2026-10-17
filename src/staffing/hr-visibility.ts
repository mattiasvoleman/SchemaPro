import { profileReadsHr } from '../auth/admin-areas';
import { Role } from '../auth/enums/role.enum';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import type { LogChange } from './employment-log-diff';

/**
 * Tjänst % and nedsättning are HR data (Roller i skolan): rektor and a full
 * administrator read them, and a schemaläggare, an expedition or a läsare
 * with HR-läs.
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
 * back exactly go as well (a subject's share of the tjänst). So do SCB's
 * three (20261111090000): the anställningsform, and the share of the post a
 * förstelärare or lektor karriärtjänst takes — the terms of a person's
 * employment, read like the tjänst % beside them.
 *
 * A teacher reads their own post and nobody else's, which the services
 * already filter; this answers only for administrators.
 */
export function readsHr(user: AuthenticatedUser): boolean {
  return user.role !== Role.SCHOOL_ADMIN || profileReadsHr(user.adminProfile, user.hrRead);
}

/** SCB's three on a post (20261111090000): HR data like the percentages. */
export const SCB_HR_FIELDS = ['employmentForm', 'firstTeacherPercent', 'lecturerPercent'] as const;

/** The fields a version's before and after name that a reader without HR-läs is not shown. */
const HR_FIELDS = new Set<string>(['employmentPercent', 'reductionPercent', ...SCB_HR_FIELDS]);

/**
 * The problem `code` of a read that is HR data through and through (SCB:s
 * Pedagogisk personal), by an administrator who does not read HR data.
 */
export const HR_NOT_YOURS = 'HR_NOT_YOURS';

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
    // SCB's three, where the row carries them (a post; not a load row).
    ...Object.fromEntries(SCB_HR_FIELDS.filter((field) => field in row).map((field) => [field, null])),
    hrHidden: true,
  };
}

/** A version's changes with the percentages' values left out; that they changed is still said. */
export function hideHrChanges(changes: LogChange[]): (LogChange & { hrHidden?: true })[] {
  return changes.map((change) =>
    HR_FIELDS.has(change.field) ? { field: change.field, before: null, after: null, hrHidden: true } : change,
  );
}
