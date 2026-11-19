import type { LoadRequirement } from './teacher-load';

/**
 * Ny undervisning: what a change of lead gives a teacher that they do not teach today (Föreslå bemanning, the extra
 * confirmation step).
 *
 * A teacher who is given a post in a SUBJECT they do not teach at the moment, or in a YEAR (årskurs) they do not teach at the
 * moment, is a change the school should have agreed with the teacher before it is written. The proposal names such changes, the
 * dialog lists them apart and asks for a second confirmation, and the apply refuses to write them without one
 * (STAFF_NEW_TEACHING_UNCONFIRMED).
 *
 * TODAY IS THE STATE THE PROPOSAL WAS READ FROM, row by row: what a teacher teaches is what the rows of the year say before any
 * change, not what the rows say after the changes before it in the same proposal. Two rows given to one teacher, both in a
 * subject they do not teach, are two changes that give a new subject, whichever of them is applied.
 *
 * WHO TEACHES WHAT. A teacher teaches a post's subject and years when they lead it, co-teach it, or take some of its lessons
 * (Delade lektioner): a teacher who takes one lesson a week of 8A's matematik teaches matematik and åk 8, and is not given
 * "a new subject" by being made the lead of 8B's. That is wider than "leads or co-leads", on purpose: a confirmation that asks
 * about something the teacher already does is one the school learns to click past.
 *
 * A YEAR IS A GRADE of the row's group (LoadRequirement.gradeSpan, as the optimisation proxy derives it). A group that holds
 * several years (a mixed group, or one whose pupils come from several classes) gives every year of its span, and a row whose group
 * has no year at all (gradeSpan null) says nothing about years: it can give a new subject and never a new year.
 */
export interface NewTeaching {
  /** The teacher teaches no post of this subject today. */
  subject: boolean;
  /** The years of the post (a grade each, ascending) that the teacher teaches no post of today. Empty when none, or when the post has no year. */
  years: number[];
}

/** What each teacher teaches today: the subjects, and the years, of every post they lead, co-lead or take lessons of. */
export interface TeachingToday {
  subjects: ReadonlyMap<string, ReadonlySet<string>>;
  years: ReadonlyMap<string, ReadonlySet<number>>;
}

type TeachingRow = Pick<LoadRequirement, 'subjectId' | 'teacherId' | 'coTeacherId' | 'shares' | 'gradeSpan'>;

/** The grades a span covers, ascending; empty for no span. */
export function gradesOf(span: LoadRequirement['gradeSpan']): number[] {
  if (!span) return [];
  const grades: number[] = [];
  for (let grade = span.min; grade <= span.max; grade += 1) grades.push(grade);
  return grades;
}

/** Everyone who teaches some of the row today: the lead, the co-teacher, and each teacher of a share. */
export function teachersOfRow(row: Pick<LoadRequirement, 'teacherId' | 'coTeacherId' | 'shares'>): string[] {
  const ids = [row.teacherId, row.coTeacherId, ...(row.shares ?? []).map((share) => share.teacherId)];
  return [...new Set(ids.filter((id): id is string => id !== null && id !== undefined))];
}

export function teachingToday(rows: readonly TeachingRow[]): TeachingToday {
  const subjects = new Map<string, Set<string>>();
  const years = new Map<string, Set<number>>();
  for (const row of rows) {
    const grades = gradesOf(row.gradeSpan);
    for (const userId of teachersOfRow(row)) {
      const ofSubjects = subjects.get(userId);
      if (ofSubjects) ofSubjects.add(row.subjectId);
      else subjects.set(userId, new Set([row.subjectId]));
      if (grades.length > 0) {
        const ofYears = years.get(userId);
        if (ofYears) for (const grade of grades) ofYears.add(grade);
        else years.set(userId, new Set(grades));
      }
    }
  }
  return { subjects, years };
}

/**
 * What giving `row` to `teacherId` gives them that they do not teach today; null when nothing, which is the usual case.
 * Pure: `today` is teachingToday of the rows as they are before any change.
 */
export function newTeachingOf(today: TeachingToday, row: TeachingRow, teacherId: string): NewTeaching | null {
  const subject = !(today.subjects.get(teacherId)?.has(row.subjectId) ?? false);
  const taught = today.years.get(teacherId);
  const years = gradesOf(row.gradeSpan).filter((grade) => !(taught?.has(grade) ?? false));
  return subject || years.length > 0 ? { subject, years } : null;
}
