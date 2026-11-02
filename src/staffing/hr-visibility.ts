import { profileReadsHr } from '../auth/admin-areas';
import { Role } from '../auth/enums/role.enum';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import type { LogChange, LogEntity } from './employment-log-diff';

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
 * answer for the reader (src/common/teacher-day.ts). And the limit on
 * teaching in a row (maxConsecutiveTeachingMinutes and consecutiveBreakMinutes,
 * 20261218090000): a limit like "at most three hours, then half an hour free"
 * may be an arbetsanpassning after sick leave, so it is kept from a reader
 * without HR-läs as the days are, and the three places that judge with it
 * word their answer for the reader (src/common/stretch.ts).
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
 * deltid in days (maxTeachingDaysPerWeek, 20261123090000) — the most
 * weekdays with teaching the post allows, a term of the employment like
 * the tjänst % it usually comes with — and the limit on teaching in a row
 * (maxConsecutiveTeachingMinutes and consecutiveBreakMinutes, 20261218090000):
 * the most minutes in a row and the free time that ends a stretch, the days'
 * sibling in the same part of the week, moved here from the work rule that
 * every colleague reads. The list for the post as it is read (hideHr): a
 * column added to the post that is HR goes here, or the post shows it.
 * Historik does not depend on it: a version hides a column nobody has
 * argued in (NOT_HR_IN_A_POST).
 */
export const EMPLOYMENT_HR_FIELDS = [
  'employmentForm',
  'firstTeacherPercent',
  'lecturerPercent',
  'maxTeachingDaysPerWeek',
  'maxConsecutiveTeachingMinutes',
  'consecutiveBreakMinutes',
] as const;

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
    // SCB's three, the days and the limit on teaching in a row, where the row carries them (a post; not a load row).
    ...Object.fromEntries(EMPLOYMENT_HR_FIELDS.filter((field) => field in row).map((field) => [field, null])),
    hrHidden: true,
  };
}

/**
 * The fields a version of a post shows with their values to a reader without
 * HR-läs. An ALLOW list, not a list of what to hide. A version is the whole
 * row as JSON less a strip list (app.teacher_staffing_log, last replaced by
 * 20261104090000), and diffLogEntry hands on every key it does not know. A
 * list of what to hide shows a column added to TeacherEmployments in
 * Historik, values and all, until somebody adds it there — #231 added two HR
 * columns, and its second review showed exactly that — and shows it for good
 * from a gateway rolled back to code older than the column. Here such a
 * column is hidden until somebody argues it in.
 *
 * Each of these is a column the post itself hands to a reader without HR-läs
 * (hideHr leaves them), and Historik shows no more than the post:
 */
const NOT_HR_IN_A_POST: ReadonlySet<string> = new Set([
  // Ferie- or semestertjänst: which arbetstid rules the schedule keeps.
  'contractKind',
  // The target in minutes that tjänstefördelning is measured against, read by
  // every administrator (Roller i skolan). This is the post's own figure; a
  // period's is part of the period.
  'teachingTargetMinutesPerWeek',
  // The lärarsignatur the schedule shows to everyone who reads it.
  'signature',
]);

/**
 * The HR fields of a post whose CHANGE is said, without from what or to what:
 * "ändrad, dolt". Said only where every post has a value, so that a change
 * names nobody: the two percentages. SCB's three are here as they were before
 * the allow list, since the manual (4.3) tells the reader that every change
 * shows in Historik, as dolt. Of those, förstelärare and lektor are null on
 * most posts, so a version naming one tells which teacher holds a karriärtjänst;
 * if that is not to be said, take them out of this list, and a version that
 * moved only them is then left out.
 *
 * Not here, and so left out of the version whole: the days and the limit on
 * teaching in a row, which are null on most posts (a version that names one
 * says that the teacher has, or had, a limit, which is what a reader without
 * HR-läs is not to learn; both columns of the limit go, so a version that
 * moved the pair says nothing of either). Nor the note (noteChanged): hideHr
 * hands the post's note over as null, so that one was written is exactly what
 * the post withholds, and it is where a reason for a nedsättning would stand.
 * And no column that nobody has judged: said by name, an unknown sparse column
 * would give away who has a value.
 */
const HR_SAID_IN_A_POST: ReadonlySet<string> = new Set([
  'employmentPercent',
  'reductionPercent',
  'employmentForm',
  'firstTeacherPercent',
  'lecturerPercent',
]);

/**
 * A version's changes as a reader without HR-läs may have them. In a post, a
 * field NOT_HR_IN_A_POST names is shown whole, one HR_SAID_IN_A_POST names is
 * said to have changed (values left out), and every other field is left out.
 * A version that is then empty is left out of the history by the service
 * (teacher-employments.service.ts).
 *
 * A period is left out whole, every field of it: when and how a post changes
 * during the year is HR data like the percentages, and a version that says a
 * period was written on a date says as much. The service leaves a period's
 * versions out before it gets here, and this holds if that filter goes.
 *
 * An uppdrag is not HR data. Every administrator reads the duty row whole, so
 * its version shows what its row does. Any other entity is left out, like a
 * period, until somebody decides otherwise.
 */
export function hideHrChanges(entity: LogEntity, changes: LogChange[]): (LogChange & { hrHidden?: true })[] {
  if (entity === 'DUTY') return changes;
  if (entity !== 'EMPLOYMENT') return [];
  return changes.flatMap((change) => {
    if (NOT_HR_IN_A_POST.has(change.field)) return [change];
    if (HR_SAID_IN_A_POST.has(change.field)) {
      return [{ field: change.field, before: null, after: null, hrHidden: true as const }];
    }
    return [];
  });
}
