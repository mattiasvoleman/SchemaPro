import type { PrismaClient } from '@prisma/client';
import type { NotificationsService } from '../notifications/notifications.service';
import { readNoticeLessons, swedishWhen, type NoticeLesson } from './cover-notices';

/**
 * WHAT A COLLEAGUE IS TOLD ABOUT A REQUEST, AND NOTHING ABOUT WHY.
 *
 * A request names the lessons (subject, group, room, start) and until when it
 * can be answered. It never names the absent teacher, the reason or the other
 * colleagues asked: it is about the colleague's own day. The e-mail is in
 * Swedish on the school's clock; the push says only that a question waits and
 * when (push-messages.ts), because a lock screen is read by whoever is near.
 *
 * Three kinds:
 *   COVER_REQUESTED          to each colleague asked.
 *   COVER_REQUEST_CLOSED     to each colleague asked who did not get it:
 *                            meta.reason TAKEN (another said yes first) or
 *                            WITHDRAWN (the school took the question back).
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

function lessonMeta(lesson: NoticeLesson): Record<string, unknown> {
  return {
    lessonId: lesson.id,
    startsAt: lesson.startsAt.toISOString(),
    subjectName: lesson.subjectName,
    groupName: lesson.groupName,
    roomName: lesson.roomName,
  };
}

function lineOf(lesson: NoticeLesson, timezone: string): string {
  return `${lesson.subjectName}, ${lesson.groupName}, ${lesson.roomName}, ${swedishWhen(lesson.startsAt, timezone)}`;
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
      subject: `Vikariefråga: ${first.subjectName} ${swedishWhen(first.startsAt, args.timezone)}${lessons.length > 1 ? ` m.fl.` : ''}`,
      body:
        `Kan du vikariera? ${lessons.map((lesson) => lineOf(lesson, args.timezone)).join('; ')}. ` +
        `Svara senast ${until}. Den som tackar ja först får uppdraget. Du svarar i Rastra.`,
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
      subject: `Vikarie tillsatt: ${first.subjectName} ${swedishWhen(first.startsAt, args.timezone)}`,
      body:
        `${args.acceptedByName} har tackat ja till ${lessons.length === 1 ? 'vikariepasset' : `${lessons.length} vikariepass`}: ` +
        `${lessons.map((lesson) => lineOf(lesson, args.timezone)).join('; ')}. Uppdraget är publicerat på schemat.`,
    },
  });
}

/** The end of the question, to the colleagues who did not get it. */
export async function sendClosed(
  notifications: NotificationsService,
  tx: PrismaClient,
  args: {
    schoolId: string;
    timezone: string;
    context: RequestNoticeContext;
    recipientIds: readonly string[];
    reason: 'TAKEN' | 'WITHDRAWN';
  },
): Promise<void> {
  const known = await readNoticeLessons(tx, args.context.lessonIds);
  const lessons = lessonsOf(args.context, known);
  const first = lessons[0];
  if (!first || args.recipientIds.length === 0) return;
  const taken = args.reason === 'TAKEN';
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
    email: {
      subject: taken
        ? `Uppdraget är tillsatt: ${first.subjectName} ${swedishWhen(first.startsAt, args.timezone)}`
        : `Vikariefrågan är återkallad: ${first.subjectName} ${swedishWhen(first.startsAt, args.timezone)}`,
      body: taken
        ? `Uppdraget ${lessons.map((lesson) => lineOf(lesson, args.timezone)).join('; ')} är redan tillsatt av en kollega. Tack för att du ville hjälpa till.`
        : `Frågan om ${lessons.map((lesson) => lineOf(lesson, args.timezone)).join('; ')} är återkallad. Du behöver inte svara.`,
    },
  });
}
