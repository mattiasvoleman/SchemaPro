import type { PrismaClient } from '@prisma/client';
import { calendarLessonRosters, type CalendarRosterLesson } from '../calendar/lesson-roster';
import type { NotificationsService } from '../notifications/notifications.service';
import { dateOf } from '../notifications/push-messages';

/**
 * THE AVBOKNING DIGEST: one notice per person per batch, and one more when
 * the batch is taken back.
 *
 * A bulk avbokning sends no notice per lesson (a week of prao is thirty per
 * pupil), and every cancelled lesson already carries "Inställd: <namn>" in
 * the calendar. So the digest is the admin's choice, ticked in the preview
 * and unticked by default. When ticked, each person the batch touches gets
 * ONE CANCELLATION_DIGEST: how many of their lessons, from which day to which,
 * and the batch's name. Their lessons are:
 *
 *   * a pupil's: the cancelled lessons whose roster they are on
 *     (lesson-roster.ts: home class, teaching groups, named on the lesson);
 *   * a guardian's: their children's, each lesson counted once;
 *   * a teacher's: the cancelled lessons they teach.
 *
 * A batch that told its people tells them again when it is reversed, about
 * the lessons the reversal reinstates (meta.reversed). One that did not stays
 * silent: nobody is told a cancellation they never heard of was undone.
 * Lessons a "Tillämpa igen" or a publish adds to the batch later get no
 * digest; each carries the note like the rest.
 *
 * People with the same count and the same first and last day share one
 * notifyUsers call, which writes and mails them in chunks: a whole-school
 * week is a handful of calls, never one per person, and never one BCC mail
 * for 1,800 addresses.
 */

/** A cancelled lesson as the digest reads it: its roster's scope and its school-local day. */
export interface DigestLesson extends CalendarRosterLesson {
  /** YYYY-MM-DD. */
  date: string;
}

/** One person's share of a batch: how many of their lessons, from which day to which. */
interface Share {
  lessons: Set<string>;
  first: string;
  last: string;
}

export interface DigestAudience {
  /** Everybody the digest reaches, with their own lessons. */
  people: Map<string, Share>;
  /** For the preview: how many of them are pupils, guardians and teachers. */
  counts: { pupils: number; guardians: number; teachers: number };
}

/** Who a digest about these lessons reaches, read in the caller's transaction. */
export async function digestAudience(tx: PrismaClient, lessons: readonly DigestLesson[]): Promise<DigestAudience> {
  const people = new Map<string, Share>();
  const counts = { pupils: 0, guardians: 0, teachers: 0 };
  if (lessons.length === 0) return { people, counts };
  const dayOf = new Map(lessons.map((lesson) => [lesson.id, lesson.date]));
  const share = (userId: string, lessonId: string) => {
    const date = dayOf.get(lessonId)!;
    const known = people.get(userId);
    if (!known) {
      people.set(userId, { lessons: new Set([lessonId]), first: date, last: date });
      return;
    }
    known.lessons.add(lessonId);
    if (date < known.first) known.first = date;
    if (date > known.last) known.last = date;
  };

  const rosters = await calendarLessonRosters(tx, lessons, { pupils: 'ACTIVE' });
  const lessonsOfPupil = new Map<string, string[]>();
  for (const [lessonId, roster] of rosters) {
    for (const pupilId of roster) {
      const list = lessonsOfPupil.get(pupilId);
      if (list) list.push(lessonId);
      else lessonsOfPupil.set(pupilId, [lessonId]);
    }
  }
  const pupils = [...lessonsOfPupil.keys()];
  const links =
    pupils.length === 0
      ? []
      : ((await tx.guardianStudent.findMany({
          where: { studentId: { in: pupils } },
          select: { guardianId: true, studentId: true },
        })) ?? []);
  const teachers =
    (await tx.calendarLessonTeacher.findMany({
      where: { calendarLessonId: { in: lessons.map((lesson) => lesson.id) } },
      select: { calendarLessonId: true, teacherId: true },
    })) ?? [];

  for (const [pupilId, lessonIds] of lessonsOfPupil) for (const lessonId of lessonIds) share(pupilId, lessonId);
  for (const link of links) for (const lessonId of lessonsOfPupil.get(link.studentId) ?? []) share(link.guardianId, lessonId);
  for (const row of teachers) share(row.teacherId, row.calendarLessonId);

  counts.pupils = pupils.length;
  counts.guardians = new Set(links.map((link) => link.guardianId)).size;
  counts.teachers = new Set(teachers.map((row) => row.teacherId)).size;
  return { people, counts };
}

/** "den 14 okt" or "mellan 14 okt och 18 okt". */
function spanOf(first: string, last: string): string {
  const from = dateOf(first, 'sv') ?? first;
  const to = dateOf(last, 'sv') ?? last;
  return first === last ? `den ${from}` : `mellan ${from} och ${to}`;
}

/**
 * What the digest says when an activity sent it (schemabrytande aktivitet):
 * the cancelled lessons are replaced, and a teacher responsible for a class
 * is told which. Notices, pushes and the in-app list are the same kind as the
 * avbokning's; only the e-mail has room for the rest.
 */
export interface ActivityWording {
  /** A teacher's classes and groups, by person: "Du är ansvarig för 7A". */
  responsible: ReadonlyMap<string, readonly string[]>;
}

/** The digest's e-mail, in Swedish: the batch's name, the person's count and days. */
export function digestEmail(
  name: string,
  share: { count: number; first: string; last: string },
  reversed: boolean,
  activity?: { responsibleFor: readonly string[] },
): { subject: string; body: string } {
  const lessons = share.count === 1 ? 'En lektion' : `${share.count} lektioner`;
  const span = spanOf(share.first, share.last);
  const responsible =
    activity && activity.responsibleFor.length > 0
      ? `\n\nDu är ansvarig för ${activity.responsibleFor.join(', ')}${reversed ? ' under aktiviteten' : ''}.`
      : '';
  if (reversed) {
    return {
      subject: activity ? `Aktiviteten är borttagen: ${name}` : `Avbokningen är ångrad: ${name}`,
      body: `${activity ? 'Aktiviteten' : 'Avbokningen'} ${name} är ${activity ? 'borttagen' : 'ångrad'}. ${lessons} ${span} blir av som planerat.${responsible}\n\nSe schemat i Rastra Schema.`,
    };
  }
  return {
    subject: `Inställda lektioner: ${name}`,
    body: `${name}: ${lessons} ${span} ${share.count === 1 ? 'är inställd' : 'är inställda'}${activity ? ' och ersätts av aktiviteten' : ''}.${responsible}\n\nSe schemat i Rastra Schema.`,
  };
}

/**
 * Writes the digest, one notifyUsers call per (count, first day, last day).
 * In the batch's own transaction, so a refused or rolled-back batch has told
 * nobody; delivered after its commit. Returns the number of people told.
 */
export async function sendDigest(
  notifications: NotificationsService,
  tx: PrismaClient,
  schoolId: string,
  batch: { id: string; name: string },
  audience: DigestAudience,
  reversed: boolean,
  activity?: ActivityWording,
): Promise<number> {
  const groups = new Map<
    string,
    { count: number; first: string; last: string; userIds: string[]; responsibleFor: readonly string[] }
  >();
  for (const [userId, share] of audience.people) {
    const responsibleFor = activity?.responsible.get(userId) ?? [];
    const key = `${share.lessons.size}|${share.first}|${share.last}|${responsibleFor.join(',')}`;
    const group = groups.get(key);
    if (group) group.userIds.push(userId);
    else
      groups.set(key, {
        count: share.lessons.size,
        first: share.first,
        last: share.last,
        userIds: [userId],
        responsibleFor,
      });
  }
  let told = 0;
  for (const group of groups.values()) {
    told += await notifications.notifyUsers(tx, {
      schoolId,
      userIds: group.userIds,
      type: 'CANCELLATION_DIGEST',
      meta: {
        batchId: batch.id,
        name: batch.name,
        lessonCount: group.count,
        startDate: group.first,
        endDate: group.last,
        reversed,
        ...(activity ? { activity: true } : {}),
      },
      email: digestEmail(batch.name, group, reversed, activity ? { responsibleFor: group.responsibleFor } : undefined),
    });
  }
  return told;
}
