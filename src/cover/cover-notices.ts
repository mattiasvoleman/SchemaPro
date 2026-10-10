import type { PrismaClient } from '@prisma/client';
import type { NotificationsService } from '../notifications/notifications.service';
import type { PendingNotice } from './cover-decisions';

/**
 * WHAT A SUBSTITUTE IS TOLD, AND NOTHING ABOUT WHY.
 *
 * A booked substitute gets LESSON_SUBSTITUTE with `cover: true` and the
 * lesson's subject, start, group and room; a substitute no longer needed gets
 * LESSON_COVER_WITHDRAWN with the same four. Both mirrored to e-mail in
 * Swedish, on the school's clock, because a timvikarie without the app reads
 * e-mail. No absence, no absent teacher, no reason: the notice is about the
 * substitute's own day.
 */

export interface NoticeLesson {
  id: string;
  startsAt: Date;
  subjectName: string;
  groupName: string;
  roomName: string;
}

/** "tis 14 okt 08:00" on the school's clock. */
export function swedishWhen(instant: Date, timezone: string): string {
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short' })
    .format(instant)
    .replace(/\./g, '');
  const time = new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(
    instant,
  );
  return `${day} ${time}`;
}

export function coverMeta(lesson: NoticeLesson): Record<string, unknown> {
  return {
    subjectName: lesson.subjectName,
    startsAt: lesson.startsAt.toISOString(),
    cover: true,
    groupName: lesson.groupName,
    roomName: lesson.roomName,
  };
}

export function withdrawnMeta(lesson: NoticeLesson): Record<string, unknown> {
  return {
    subjectName: lesson.subjectName,
    startsAt: lesson.startsAt.toISOString(),
    groupName: lesson.groupName,
    roomName: lesson.roomName,
  };
}

export function coverEmail(lesson: NoticeLesson, timezone: string): { subject: string; body: string } {
  const when = swedishWhen(lesson.startsAt, timezone);
  return {
    subject: `Vikariepass: ${lesson.subjectName} ${when}`,
    body: `Du är inbokad som vikarie: ${lesson.subjectName}, ${lesson.groupName}, ${lesson.roomName}, ${when}.`,
  };
}

export function withdrawnEmail(lesson: NoticeLesson, timezone: string): { subject: string; body: string } {
  const when = swedishWhen(lesson.startsAt, timezone);
  return {
    subject: `Vikariepasset är avbokat: ${lesson.subjectName} ${when}`,
    body: `Vikariepasset är avbokat: ${lesson.subjectName}, ${lesson.groupName}, ${lesson.roomName}, ${when}. Du behöver inte komma.`,
  };
}

/** The lessons the notices name, read once: subject, start, group and room. */
export async function readNoticeLessons(tx: PrismaClient, lessonIds: readonly string[]): Promise<Map<string, NoticeLesson>> {
  const ids = [...new Set(lessonIds)];
  if (ids.length === 0) return new Map();
  const lessons =
    (await tx.calendarLesson.findMany({
      where: { id: { in: ids } },
      select: { id: true, startsAt: true, studentGroupId: true, roomId: true, subjectId: true },
    })) ?? [];
  const [subjects, groups, rooms] = await Promise.all([
    tx.subject.findMany({ where: { id: { in: lessons.map((l) => l.subjectId) } }, select: { id: true, name: true } }),
    tx.studentGroup.findMany({ where: { id: { in: lessons.map((l) => l.studentGroupId) } }, select: { id: true, name: true } }),
    tx.room.findMany({
      where: { id: { in: lessons.flatMap((l) => (l.roomId ? [l.roomId] : [])) } },
      select: { id: true, name: true },
    }),
  ]);
  const name = (rows: { id: string; name: string }[] | undefined) => new Map((rows ?? []).map((row) => [row.id, row.name]));
  const subjectName = name(subjects);
  const groupName = name(groups);
  const roomName = name(rooms);
  return new Map(
    lessons.map((lesson) => [
      lesson.id,
      {
        id: lesson.id,
        startsAt: lesson.startsAt,
        subjectName: subjectName.get(lesson.subjectId) ?? '',
        groupName: groupName.get(lesson.studentGroupId) ?? '',
        roomName: lesson.roomId ? (roomName.get(lesson.roomId) ?? '—') : '—',
      },
    ]),
  );
}

/**
 * Sends the notices, one notifyUsers per notice (each is one person's own
 * e-mail). Called after the writing transaction has committed, in a
 * transaction of its own, so a rolled-back apply has told nobody.
 */
export async function sendNotices(
  notifications: NotificationsService,
  tx: PrismaClient,
  schoolId: string,
  timezone: string,
  notices: readonly PendingNotice[],
): Promise<void> {
  if (notices.length === 0) return;
  const lessons = await readNoticeLessons(
    tx,
    notices.map((notice) => notice.lessonId),
  );
  for (const notice of notices) {
    const lesson = lessons.get(notice.lessonId);
    if (!lesson) continue;
    await notifications.notifyUsers(tx, {
      schoolId,
      userIds: [notice.userId],
      type: notice.kind === 'COVER' ? 'LESSON_SUBSTITUTE' : 'LESSON_COVER_WITHDRAWN',
      meta: notice.kind === 'COVER' ? coverMeta(lesson) : withdrawnMeta(lesson),
      email: notice.kind === 'COVER' ? coverEmail(lesson, timezone) : withdrawnEmail(lesson, timezone),
    });
  }
}

/**
 * A notice cancelled by a later one in the same batch: a substitute booked
 * and then withdrawn (or the other way round) for the same lesson is told
 * only the last word.
 */
export function settleNotices(notices: readonly PendingNotice[]): PendingNotice[] {
  const last = new Map<string, PendingNotice>();
  for (const notice of notices) last.set(`${notice.userId}:${notice.lessonId}`, notice);
  const firstKind = new Map<string, PendingNotice['kind']>();
  for (const notice of notices) {
    const key = `${notice.userId}:${notice.lessonId}`;
    if (!firstKind.has(key)) firstKind.set(key, notice.kind);
  }
  // Booked and withdrawn within one write: nothing happened to them.
  return [...last.entries()]
    .filter(([key, notice]) => !(firstKind.get(key) !== notice.kind))
    .map(([, notice]) => notice);
}
