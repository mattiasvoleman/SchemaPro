import type { LessonLogText, SubstituteNoteText } from "../../../lib/lesson-log";
import { KIND, uid } from "../sessions";
import { NOW } from "./calendar";
import { CALENDAR_LESSONS, TEACHERS } from "./world";

/**
 * Lektionslogg's rows (20261203090000): what four of this week's lessons
 * are about and their homework, the note Anna left her Monday Swedish's
 * substitute, and the one Bo left Anna for the lesson she covers. Keyed by the calendar lesson, as the tables are, so the
 * family's week, the pupil's list, the teacher's page and the klassbok all
 * read the same text.
 */

const lessonOf = (master: number) => CALENDAR_LESSONS.find((lesson) => lesson.masterLessonId === uid(KIND.masterLesson, master))!.id;
const written = (name: string) => ({ writtenBy: name, updatedAt: NOW });

/** Anna's Monday Swedish in 7A: the lesson /teacher/lektion/[lessonId] opens (app-routes.ts PARAMS). */
export const ANNAS_MONDAY = lessonOf(1);

export const LESSON_LOGS = new Map<string, LessonLogText>([
  [
    ANNAS_MONDAY,
    {
      topic: "Novellanalys: berättarperspektiv",
      homework: "Läs novellen ”Tant Ruth” och skriv tre frågor till den.",
      ...written(`${TEACHERS.anna.firstName} ${TEACHERS.anna.lastName}`),
    },
  ],
  [lessonOf(2), { topic: "Bråk och decimaltal", homework: null, ...written(`${TEACHERS.bo.firstName} ${TEACHERS.bo.lastName}`) }],
  [lessonOf(4), { topic: null, homework: "Glosor kapitel 3", ...written(`${TEACHERS.anna.firstName} ${TEACHERS.anna.lastName}`) }],
  // Wednesday's mathematics in 7A, the day the stub's clock stands on: the family's "I dag" shows it.
  [lessonOf(7), { topic: null, homework: "Uppgift 5.1–5.4", ...written(`${TEACHERS.bo.firstName} ${TEACHERS.bo.lastName}`) }],
]);

export const SUBSTITUTE_NOTES = new Map<string, SubstituteNoteText>([
  [
    ANNAS_MONDAY,
    {
      body: "Planeringen ligger i lärplattformen. Eleverna arbetar i par med frågorna på sidan 12.",
      ...written(`${TEACHERS.anna.firstName} ${TEACHERS.anna.lastName}`),
    },
  ],
  // Thursday's mathematics in 9A, which Anna covers for Bo (cover-world.ts): Bo's note to her.
  [
    lessonOf(12),
    {
      body: "Eleverna räknar vidare i kapitel 6. Facit ligger i katedern.",
      ...written(`${TEACHERS.bo.firstName} ${TEACHERS.bo.lastName}`),
    },
  ],
]);
