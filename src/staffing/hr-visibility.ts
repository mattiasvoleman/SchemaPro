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
 * employment, read like the tjänst % beside them. And deltid in days
 * (20261123090000), for the same reason: the generator, a hand edit and the
 * Vikarietavla judge with it for every reader alike, and word what they
 * answer for the reader (src/common/teacher-day.ts).
 *
 * A teacher reads their own post and nobody else's, which the services
 * already filter; this answers only for administrators.
 */
export function readsHr(user: AuthenticatedUser): boolean {
  return user.role !== Role.SCHOOL_ADMIN || profileReadsHr(user.adminProfile, user.hrRead);
}

/**
 * The post's HR columns besides the two percentages, which every reader of
 * a post is handed and so are typed apart: SCB's three (20261111090000),
 * and deltid in days (maxTeachingDaysPerWeek, 20261123090000) — the most
 * weekdays with teaching the post allows, a term of the employment like
 * the tjänst % it usually comes with. ONE LIST for the post as it is read
 * (hideHr) and its versions in Historik (hideHrChanges): a column added to
 * the post that is HR goes here, or both show it.
 */
export const EMPLOYMENT_HR_FIELDS = [
  'employmentForm',
  'firstTeacherPercent',
  'lecturerPercent',
  'maxTeachingDaysPerWeek',
] as const;

/** The fields a version's before and after name that a reader without HR-läs is not shown. */
const HR_FIELDS = new Set<string>(['employmentPercent', 'reductionPercent', ...EMPLOYMENT_HR_FIELDS]);

/**
 * Of those, the ones whose change is not even said. Deltid in days is null
 * on most posts, so a version that names it says the teacher has (or had) a
 * limit at all — which is what the masked reader is not to learn: an
 * "ändrad, dolt" on exactly the versions where the days moved would give it
 * back. A changed percentage says nothing of the kind: every post has one.
 */
const UNSAID_HR_FIELDS = new Set<string>(['maxTeachingDaysPerWeek']);

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
    // SCB's three and the days, where the row carries them (a post; not a load row).
    ...Object.fromEntries(EMPLOYMENT_HR_FIELDS.filter((field) => field in row).map((field) => [field, null])),
    hrHidden: true,
  };
}

/**
 * A version's changes with the HR values left out: that a percentage or
 * one of SCB's three changed is still said, a change of the days is left
 * out whole (UNSAID_HR_FIELDS). A version that changed nothing else is then
 * empty, and the history leaves it out (teacher-employments.service.ts).
 */
export function hideHrChanges(changes: LogChange[]): (LogChange & { hrHidden?: true })[] {
  return changes
    .filter((change) => !UNSAID_HR_FIELDS.has(change.field))
    .map((change) =>
      HR_FIELDS.has(change.field) ? { field: change.field, before: null, after: null, hrHidden: true } : change,
    );
}
