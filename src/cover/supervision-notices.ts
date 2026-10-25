import type { PrismaClient } from '@prisma/client';
import type { NotificationsService } from '../notifications/notifications.service';
import { swedishWhen } from './cover-notices';

/**
 * WHAT A VIKARIE FOR A RASTVAKTSPASS IS TOLD (Rastvakt i vardagen,
 * 20261210090000), and nothing about why.
 *
 * A booked vikarie gets SUPERVISION_COVER with the area's name, the start
 * and the end; a vikarie no longer needed — the decision undone, handed to
 * somebody else, or settled by an absence ended early — gets
 * SUPERVISION_COVER_WITHDRAWN with the same three. Both mirrored to e-mail
 * in Swedish on the school's clock, as a lesson's booking is (cover-
 * notices.ts): a timvikarie without the app reads e-mail. Both are delivered
 * whatever the person chose (notification-types.ts deliveredRegardless): a
 * yard nobody knows they watch is the failure this phase is for.
 *
 * No absence, no absent teacher, no reason, and never the pass's note: the
 * notice is about the vikarie's own day. The push says less still
 * (push-messages.ts: the time, no place — an area's name is the school's
 * free text).
 */

/** A notice to send once the transaction has committed, with the occurrence it is about. */
export interface PassNotice {
  kind: 'COVER' | 'WITHDRAWN';
  userId: string;
  shiftId: string;
  date: string;
  areaId: string;
  startsAt: Date;
  endsAt: Date;
}

interface NoticePass {
  areaName: string;
  startsAt: Date;
  endsAt: Date;
}

const clockOn = (instant: Date, timezone: string) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(instant);

export function passMeta(pass: NoticePass): Record<string, unknown> {
  return { areaName: pass.areaName, startsAt: pass.startsAt.toISOString(), endsAt: pass.endsAt.toISOString() };
}

export function passCoverEmail(pass: NoticePass, timezone: string): { subject: string; body: string } {
  const when = swedishWhen(pass.startsAt, timezone);
  return {
    subject: `Rastvaktspass: ${pass.areaName} ${when}`,
    body: `Du är inbokad som rastvakt: ${pass.areaName}, ${when}–${clockOn(pass.endsAt, timezone)}.`,
  };
}

export function passWithdrawnEmail(pass: NoticePass, timezone: string): { subject: string; body: string } {
  const when = swedishWhen(pass.startsAt, timezone);
  return {
    subject: `Rastvaktspasset är avbokat: ${pass.areaName} ${when}`,
    body: `Rastvaktspasset är avbokat: ${pass.areaName}, ${when}–${clockOn(pass.endsAt, timezone)}. Du behöver inte ta det.`,
  };
}

/**
 * The last word per person and pass: booked and withdrawn within one write
 * is nothing that happened to them, as settleNotices says of a lesson.
 */
export function settlePassNotices(notices: readonly PassNotice[]): PassNotice[] {
  const key = (notice: PassNotice) => `${notice.userId}:${notice.shiftId}:${notice.date}`;
  const first = new Map<string, PassNotice['kind']>();
  const last = new Map<string, PassNotice>();
  for (const notice of notices) {
    if (!first.has(key(notice))) first.set(key(notice), notice.kind);
    last.set(key(notice), notice);
  }
  return [...last.entries()].filter(([k, notice]) => first.get(k) === notice.kind).map(([, notice]) => notice);
}

/**
 * Sends the notices, one notifyUsers each (each is one person's own e-mail),
 * after the writing transaction has committed, in a transaction of its own.
 */
export async function sendPassNotices(
  notifications: NotificationsService,
  tx: PrismaClient,
  schoolId: string,
  timezone: string,
  notices: readonly PassNotice[],
): Promise<void> {
  if (notices.length === 0) return;
  const areas =
    (await tx.supervisionArea.findMany({
      where: { id: { in: [...new Set(notices.map((notice) => notice.areaId))] } },
      select: { id: true, name: true },
    })) ?? [];
  const nameOf = new Map(areas.map((area) => [area.id, area.name]));
  for (const notice of notices) {
    const pass: NoticePass = { areaName: nameOf.get(notice.areaId) ?? '', startsAt: notice.startsAt, endsAt: notice.endsAt };
    await notifications.notifyUsers(tx, {
      schoolId,
      userIds: [notice.userId],
      type: notice.kind === 'COVER' ? 'SUPERVISION_COVER' : 'SUPERVISION_COVER_WITHDRAWN',
      meta: passMeta(pass),
      email: notice.kind === 'COVER' ? passCoverEmail(pass, timezone) : passWithdrawnEmail(pass, timezone),
    });
  }
}
