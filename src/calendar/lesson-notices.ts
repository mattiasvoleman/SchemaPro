import { swedishWhen } from '../cover/cover-notices';

/** The notices a lesson's class, its guardians and its teachers get about the lesson itself. */
export type LessonNoticeType =
  | 'LESSON_CANCELLED'
  | 'LESSON_SUBSTITUTE'
  | 'LESSON_ROOM_CHANGED'
  | 'LESSON_REINSTATED'
  | 'LESSON_SUPERVISED_STUDY';

/**
 * WHAT A LESSON NOTICE SAYS BY E-MAIL.
 *
 * Swedish, on the school's clock ("tis 14 okt 08:00"), as the substitute's
 * own notices are (cover-notices.ts). These used to be English with a UTC
 * instant ("Matematik on 2026-10-14T06:00:00.000Z has been cancelled."), so a
 * guardian read the wrong hour for half the year and a language the school
 * does not write in. The in-app row keeps its meta (subject and start), and
 * each reader's app words it in their own language and clock.
 *
 * The subject and the time only: never the group, the room or a teacher. A
 * cancellation carries the reason the admin gave, which is the note pupils
 * already read on the lesson.
 */
export function lessonEmail(
  type: LessonNoticeType,
  lesson: { subjectName: string; startsAt: Date },
  timezone: string,
  reason?: string | null,
): { subject: string; body: string } {
  const what = `${lesson.subjectName} ${swedishWhen(lesson.startsAt, timezone)}`;
  const see = 'Se schemat i SchemaPro.';
  switch (type) {
    case 'LESSON_CANCELLED':
      return {
        subject: `Inställd lektion: ${what}`,
        body: `${what} är inställd.${reason ? ` Anledning: ${reason}` : ''}\n\n${see}`,
      };
    case 'LESSON_SUBSTITUTE':
      return { subject: `Vikarie: ${what}`, body: `${what} har en vikarie.\n\n${see}` };
    case 'LESSON_ROOM_CHANGED':
      return { subject: `Ny sal: ${what}`, body: `${what} har flyttat till en annan sal.\n\n${see}` };
    case 'LESSON_REINSTATED':
      return { subject: `Lektionen blir av: ${what}`, body: `${what} blir av som planerat.\n\n${see}` };
    case 'LESSON_SUPERVISED_STUDY':
      return { subject: `Självstudier: ${what}`, body: `${what} blir självstudier under tillsyn.\n\n${see}` };
  }
}
