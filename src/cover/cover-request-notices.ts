import type { PrismaClient } from '@prisma/client';
import type { NotificationsService } from '../notifications/notifications.service';
import { readNoticeLessons, swedishWhen, type NoticeLesson } from './cover-notices';

/**
 * WHAT A COLLEAGUE IS TOLD ABOUT A REQUEST, AND NOTHING ABOUT WHY.
 *
 * A notice says how many lessons and from when, and that the answer is in
 * Rastra. It names no subject, group or room, in the e-mail's subject line
 * and text, in the inbox row's meta or in the push: a subject line is shown
 * on a lock screen as a push is, and with the absent teacher's week known
 * the three would say who is away. It never names the absent teacher, the
 * reason or the other colleagues asked either. The lessons themselves are
 * read behind the login, on the card in Rastra, which has to show them for
 * the colleague to decide. The e-mail is in Swedish on the school's clock.
 *
 * Three types:
 *   COVER_REQUESTED          to each colleague asked.
 *   COVER_REQUEST_CLOSED     meta.reason says which end:
 *                              TAKEN       another said yes first,
 *                              WITHDRAWN   the school took the question back,
 *                              NOT_NEEDED  the absence or the lesson went away
 *                                          while the question stood
 *                            to each colleague asked who did not get it; and
 *                              UNANSWERED  the time ran out with nobody saying
 *                                          yes
 *                            to the administrator who asked.
 *   COVER_REQUEST_ACCEPTED   to the administrator who asked: who took it.
 *
 * Sent after the writing transaction has committed, in a transaction of its
 * own, so a refused yes has told nobody.
 */

export interface RequestNoticeContext {
  requestId: string;
  lessonIds: readonly string[];
}

function lessonsOf(context: RequestNoticeContext, known: Map<string, NoticeLesson>): NoticeLesson[] {
  return context.lessonIds
    .map((id) => known.get(id))
    .filter((lesson): lesson is NoticeLesson => lesson !== undefined)
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.id.localeCompare(b.id));
}

/** A lesson in a notice's meta: which and when, never what it is about. */
function lessonMeta(lesson: NoticeLesson): Record<string, unknown> {
  return { lessonId: lesson.id, startsAt: lesson.startsAt.toISOString() };
}

/** "en lektion" / "3 lektioner", for the e-mails' text. */
function lessonsIn(count: number): string {
  return count === 1 ? 'en lektion' : `${count} lektioner`;
}

/** "ett vikariepass" / "3 vikariepass". */
function passesIn(count: number): string {
  return count === 1 ? 'ett vikariepass' : `${count} vikariepass`;
}

/** The question, to the colleagues asked. */
export async function sendRequested(
  notifications: NotificationsService,
  tx: PrismaClient,
  args: {
    schoolId: string;
    timezone: string;
    context: RequestNoticeContext;
    recipientIds: readonly string[];
    expiresAt: Date;
  },
): Promise<void> {
  const known = await readNoticeLessons(tx, args.context.lessonIds);
  const lessons = lessonsOf(args.context, known);
  const first = lessons[0];
  if (!first || args.recipientIds.length === 0) return;
  const until = swedishWhen(args.expiresAt, args.timezone);
  await notifications.notifyUsers(tx, {
    schoolId: args.schoolId,
    userIds: [...args.recipientIds],
    type: 'COVER_REQUESTED',
    meta: {
      requestId: args.context.requestId,
      startsAt: first.startsAt.toISOString(),
      lessonCount: lessons.length,
      expiresAt: args.expiresAt.toISOString(),
      lessons: lessons.map(lessonMeta),
    },
    email: {
      subject: `Vikariefråga ${swedishWhen(first.startsAt, args.timezone)}`,
      body:
        `Kan du vikariera ${lessonsIn(lessons.length)} från ${swedishWhen(first.startsAt, args.timezone)}? ` +
        `Svara i Rastra senast ${until}. Den som tackar ja först får uppdraget.`,
    },
  });
}

/** The answer, to the administrator who asked. */
export async function sendAccepted(
  notifications: NotificationsService,
  tx: PrismaClient,
  args: {
    schoolId: string;
    timezone: string;
    context: RequestNoticeContext;
    senderId: string;
    acceptedByName: string;
  },
): Promise<void> {
  const known = await readNoticeLessons(tx, args.context.lessonIds);
  const lessons = lessonsOf(args.context, known);
  const first = lessons[0];
  if (!first) return;
  await notifications.notifyUsers(tx, {
    schoolId: args.schoolId,
    userIds: [args.senderId],
    type: 'COVER_REQUEST_ACCEPTED',
    meta: {
      requestId: args.context.requestId,
      startsAt: first.startsAt.toISOString(),
      lessonCount: lessons.length,
      acceptedByName: args.acceptedByName,
    },
    email: {
      subject: `Vikarie tillsatt ${swedishWhen(first.startsAt, args.timezone)}`,
      body:
        `${args.acceptedByName} har tackat ja till ${passesIn(lessons.length)} från ${swedishWhen(first.startsAt, args.timezone)}. ` +
        `Uppdraget är publicerat på schemat.`,
    },
  });
}

/** Why a question ended for a colleague who did not get it. */
export type ClosedReason = 'TAKEN' | 'WITHDRAWN' | 'NOT_NEEDED';

/** The end of the question, to the colleagues who did not get it. */
export async function sendClosed(
  notifications: NotificationsService,
  tx: PrismaClient,
  args: {
    schoolId: string;
    timezone: string;
    context: RequestNoticeContext;
    recipientIds: readonly string[];
    reason: ClosedReason;
  },
): Promise<void> {
  const known = await readNoticeLessons(tx, args.context.lessonIds);
  const lessons = lessonsOf(args.context, known);
  const first = lessons[0];
  if (!first || args.recipientIds.length === 0) return;
  const when = swedishWhen(first.startsAt, args.timezone);
  const text = {
    TAKEN: {
      subject: `Uppdraget är tillsatt ${when}`,
      body: `Vikariefrågan om ${lessonsIn(lessons.length)} från ${when} är redan tillsatt av en kollega. Tack för att du ville hjälpa till.`,
    },
    WITHDRAWN: {
      subject: `Vikariefrågan är återkallad ${when}`,
      body: `Vikariefrågan om ${lessonsIn(lessons.length)} från ${when} är återkallad. Du behöver inte svara.`,
    },
    NOT_NEEDED: {
      subject: `Vikariefrågan behövs inte längre ${when}`,
      body: `Vikariefrågan om ${lessonsIn(lessons.length)} från ${when} behövs inte längre. Du behöver inte svara.`,
    },
  }[args.reason];
  await notifications.notifyUsers(tx, {
    schoolId: args.schoolId,
    userIds: [...args.recipientIds],
    type: 'COVER_REQUEST_CLOSED',
    meta: {
      requestId: args.context.requestId,
      startsAt: first.startsAt.toISOString(),
      lessonCount: lessons.length,
      reason: args.reason,
      lessons: lessons.map(lessonMeta),
    },
    email: text,
  });
}

/**
 * The time ran out and nobody said yes: said to the administrator who asked,
 * in the same type as the colleagues' end of it (COVER_REQUEST_CLOSED, reason
 * UNANSWERED), so the sender does not have to look at the board to find out
 * that the lessons still need somebody.
 */
export async function sendUnanswered(
  notifications: NotificationsService,
  tx: PrismaClient,
  args: { schoolId: string; timezone: string; context: RequestNoticeContext; senderId: string },
): Promise<void> {
  const known = await readNoticeLessons(tx, args.context.lessonIds);
  const lessons = lessonsOf(args.context, known);
  const first = lessons[0];
  if (!first) return;
  const when = swedishWhen(first.startsAt, args.timezone);
  await notifications.notifyUsers(tx, {
    schoolId: args.schoolId,
    userIds: [args.senderId],
    type: 'COVER_REQUEST_CLOSED',
    meta: {
      requestId: args.context.requestId,
      startsAt: first.startsAt.toISOString(),
      lessonCount: lessons.length,
      reason: 'UNANSWERED',
      lessons: lessons.map(lessonMeta),
    },
    email: {
      subject: `Ingen har tackat ja ${when}`,
      body: `Ingen kollega tackade ja till vikariefrågan om ${lessonsIn(lessons.length)} från ${when} innan den gick ut. ${lessons.length === 1 ? 'Passet behöver' : 'Passen behöver'} fortfarande en vikarie: fråga fler kollegor eller tillsätt någon på vikarietavlan i Rastra.`,
    },
  });
}
