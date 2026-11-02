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
 * every colleague reads. The HR columns the post as it is read (hideHr) hands
 * over as null, beside the two percentages and the note.
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
export const NOT_HR_IN_A_POST: ReadonlySet<string> = new Set([
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
export const HR_SAID_IN_A_POST: ReadonlySet<string> = new Set([
  'employmentPercent',
  'reductionPercent',
  'employmentForm',
  'firstTeacherPercent',
  'lecturerPercent',
]);

/**
 * The columns of a post that the read hands a reader without HR-läs with
 * their values: the row's identity and bookkeeping, and the columns
 * NOT_HR_IN_A_POST argues in, so that Historik shows no more than the post.
 * createdAt and updatedAt are handed on as they always were; updatedAt says
 * when the post was last written, not what changed, and hiding it would be a
 * decision of its own.
 */
export const POST_READ_AS_IS: ReadonlySet<string> = new Set([
  'id',
  'schoolId',
  'userId',
  'academicYearId',
  'createdAt',
  'updatedAt',
  ...NOT_HR_IN_A_POST,
]);

/**
 * The columns the read hands that reader as null beside `hrHidden`, where the
 * row carries them: the two percentages, the note, and the rest of the post's
 * HR columns (EMPLOYMENT_HR_FIELDS). A null says nothing about a column that
 * is null on most posts, which is why these keep their place in the answer
 * where Historik leaves the sparse ones out. The post's periods go as an empty
 * list.
 */
export const POST_READ_NULLED: ReadonlySet<string> = new Set([
  'employmentPercent',
  'reductionPercent',
  'note',
  ...EMPLOYMENT_HR_FIELDS,
]);

/** What hideHr hands on: the columns it keeps, whatever they are, and the HR it has nulled. */
export type HrHiddenPost<T> = Partial<Omit<T, 'employmentPercent' | 'reductionPercent'>> & {
  employmentPercent: null;
  reductionPercent: null;
  note?: null;
  hrHidden: true;
};

/**
 * A post with its HR left out. An ALLOW list, like the post's versions
 * (hideHrChanges): a key of the row that POST_READ_AS_IS or POST_READ_NULLED
 * does not name is left out of the answer, name and value, so a column added
 * to the post reaches a reader without HR-läs only when somebody has argued
 * it in, not from the day its migration runs. The keys keep the order the row
 * had them in, and `hrHidden` comes last. A reader with HR-läs and a teacher
 * reading their own post are handed the row whole and never come here.
 */
export function hideHr<T extends { employmentPercent: number; reductionPercent: number }>(row: T): HrHiddenPost<T> {
  const shown: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (POST_READ_AS_IS.has(key)) shown[key] = value;
    else if (key === 'periods') shown[key] = [];
    else if (POST_READ_NULLED.has(key)) shown[key] = null;
  }
  return { ...shown, employmentPercent: null, reductionPercent: null, hrHidden: true } as HrHiddenPost<T>;
}

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
