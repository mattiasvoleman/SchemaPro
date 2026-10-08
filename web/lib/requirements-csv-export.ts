/**
 * The timplan file's export: requirementsToCsv and the `lektionslangder`
 * cell it may add.
 *
 * Its own module, beside lib/csv-export.ts rather than in it, because only
 * the requirements page exports a timplan, while the groups, people, rooms
 * and subjects pages import csv-export for their own exports and templates —
 * and csv-export ships whole to each of them. With lektionslängder this
 * builder needs lib/lesson-lengths, which those four pages never run; here it
 * reaches only the page that does. lib/csv.ts re-exports this module as it
 * does csv-export, so the import side and the tests keep one place to import
 * from.
 */

import type { LessonRecurrence } from "@/lib/types";
import { CSV_TEMPLATES, RECURRENCE_WORD, serializeCsv } from "@/lib/csv-export";
import { isMixed, lengthPartsOf, type LessonShape } from "@/lib/lesson-lengths";

/**
 * The timplan as the school's own file: names, codes and e-mail addresses,
 * never ids.
 *
 * Takes the four lists the timplan page already holds rather than looking
 * anything up itself — the page has them loaded to render the grid, and a
 * fetch in here would make an export depend on the network while the grid it
 * mirrors does not.
 *
 * The subject is written as its CODE when it has one, exactly as the grid
 * shows it (`subject.code ?? subject.name`) and exactly as a school's own
 * timplan is written; the importer accepts either. A code that is present but
 * blank falls back to the name — `??` would write an empty cell, and an empty
 * ämne is the one thing re-import rejects.
 */
export function requirementsToCsv(
  requirements: {
    studentGroupId: string;
    subjectId: string;
    teacherId: string | null;
    coTeacherId: string | null;
    lessonsPerWeek: number;
    minutesPerLesson: number;
    lessonLengths?: number[];
    minutesBefore: number;
    minutesAfter: number;
    teacherLoadPercent: number;
    coTeacherLoadPercent: number;
    recurrence: LessonRecurrence;
    startDate: string | null;
    endDate: string | null;
  }[],
  groups: { id: string; name: string }[],
  subjects: { id: string; name: string; code: string | null }[],
  people: { id: string; email: string }[],
): string {
  const groupName = new Map(groups.map((group) => [group.id, group.name]));
  const subjectLabel = new Map(
    subjects.map((subject) => [subject.id, subject.code?.trim() || subject.name]),
  );
  const email = new Map(people.map((person) => [person.id, person.email]));

  // Lektionslängder: a `lektionslangder` column, last, ONLY when some row
  // the file carries is split. A school that never splits a post gets the
  // file it always got, byte for byte, and the template is unchanged; the
  // importer reads the column when it is there and leaves every stored split
  // alone when it is not (equal scalars keep it).
  const split = requirements.some(
    (requirement) =>
      isMixed(requirement) &&
      groupName.has(requirement.studentGroupId) &&
      subjectLabel.has(requirement.subjectId),
  );
  const rows: string[][] = [];
  for (const requirement of requirements) {
    const group = groupName.get(requirement.studentGroupId);
    const subject = subjectLabel.get(requirement.subjectId);
    if (!group || !subject) continue;

    // A teacher the loaded roster cannot name is a reason to leave the whole
    // row out, not to write a blank cell. Blank does not mean "unknown" to the
    // importer — it means "no teacher" — and since the import UPDATES, that
    // row would come back and strip the teacher off a requirement that has
    // one. Dropping the row loses nothing instead: a row absent from the file
    // is a row the import does not touch.
    const teacher = requirement.teacherId ? email.get(requirement.teacherId) : "";
    const coTeacher = requirement.coTeacherId
      ? email.get(requirement.coTeacherId)
      : "";
    if (teacher === undefined || coTeacher === undefined) continue;

    rows.push([
      group,
      subject,
      String(requirement.lessonsPerWeek),
      String(requirement.minutesPerLesson),
      // Always written, zeroes included. A blank cell would import as 0 anyway,
      // so it would be the same number said less clearly; and a file whose
      // columns are all present is the one an administrator can edit in place
      // without wondering whether an empty cell means "none" or "leave it".
      String(requirement.minutesBefore),
      String(requirement.minutesAfter),
      teacher,
      coTeacher,
      RECURRENCE_WORD[requirement.recurrence],
      requirement.startDate ?? "",
      requirement.endDate ?? "",
      // Always written, 100 included, for the reason the minutes are.
      String(requirement.teacherLoadPercent),
      String(requirement.coTeacherLoadPercent),
      // The scalars above stay the count and the longest, so an importer that
      // predates the column still reads a sane row; an empty cell is a
      // uniform post, which on re-import says "uniform" and nothing else.
      ...(split ? [isMixed(requirement) ? formatLengthSpec(requirement) : ""] : []),
    ]);

  }

  return serializeCsv(
    split ? [...CSV_TEMPLATES.requirements.headers, LESSON_LENGTHS_HEADER] : CSV_TEMPLATES.requirements.headers,
    rows,
  );
}

/** The timplan file's column for a split post's lengths, ASCII like its neighbours. */
export const LESSON_LENGTHS_HEADER = "lektionslangder";

/**
 * A post's lengths as the `lektionslangder` cell writes them: "1x80+1x40",
 * longest first. ASCII x rather than ×, because the file is opened in Excel on
 * machines whose code page is not ours, and the importer reads ×, x, X and *
 * alike (parseLengthSpec in lib/csv.ts).
 */
export function formatLengthSpec(row: LessonShape): string {
  return lengthPartsOf(row)
    .map((part) => `${part.count}x${part.minutes}`)
    .join("+");
}
