import { swedishWhen } from '../cover/cover-notices';

/**
 * What a move tells the people it touches (LESSON_PUPIL_MOVED): the teachers of
 * the two lessons, always, and the pupil's guardians when the school has said
 * so (SchoolDaySettings.guardianNoticeOnMove, off until it does).
 *
 * THE SUBJECT AND THE TIME ONLY. Never the pupil, the class, the room or who
 * moved them: a push is read by whoever holds the phone, and an e-mail is
 * kept. The in-app row carries the pupil's id and the two lessons (the web
 * and the app word it from the subjects and the time alone; neither names the
 * pupil, and a teacher finds the pupil in their register). A protected identity
 * is named in no notice at all.
 */

export interface MoveNoticeLesson {
  subjectName: string;
  startsAt: Date;
}

export interface MoveNoticeMeta {
  /** The lesson the pupil left and the one they went to; both ids, for the app to open. */
  fromLessonId: string;
  toLessonId: string;
  studentId: string;
  fromSubjectName: string;
  toSubjectName: string;
  /** The lesson the pupil is on now: where they went, or where they are back after Ångra. The web words its notice from this alone. */
  subjectName: string;
  startsAt: string;
  /** True when the move was taken back (Ångra) or the pupil was sent back to where they started. */
  undone?: boolean;
}

export function moveMeta(
  ids: { fromLessonId: string; toLessonId: string; studentId: string },
  from: MoveNoticeLesson,
  to: MoveNoticeLesson,
  undone: boolean,
): MoveNoticeMeta {
  return {
    ...ids,
    fromSubjectName: from.subjectName,
    toSubjectName: to.subjectName,
    subjectName: undone ? from.subjectName : to.subjectName,
    startsAt: from.startsAt.toISOString(),
    ...(undone ? { undone: true } : {}),
  };
}

/** The e-mail to a guardian, Swedish on the school's clock. Subject and time. */
export function moveEmail(
  from: MoveNoticeLesson,
  to: MoveNoticeLesson,
  timezone: string,
  undone: boolean,
): { subject: string; body: string } {
  const when = swedishWhen(from.startsAt, timezone);
  const see = 'Se schemat i Rastra Schema.';
  return undone
    ? {
        subject: `Ett barns lektion är som planerat: ${when}`,
        body: `Barnets byte av lektion ${when} är ångrat. Det är lektionen ${from.subjectName} som gäller.\n\n${see}`,
      }
    : {
        subject: `Ett barn byter lektion: ${when}`,
        body: `Barnet byter lektion ${when}: ${to.subjectName} i stället för ${from.subjectName}.\n\n${see}`,
      };
}
