import type { PrismaClient } from '@prisma/client';
import type { NotificationsService } from '../notifications/notifications.service';

/*
 * LEAVE_REQUESTED, the gateway's half (Mentorns ledighetsbeslut,
 * 20261023091000).
 *
 * The database writes the notices from the row: a trigger tells the
 * deciding mentors of every new request, whatever path it came by, and
 * app.leave_requests_tell_new_mentors tells the mentors a delegation or an
 * uppdrag has since given a pending request to. Each mentor is told once per
 * request. What the database cannot do is send the e-mail and the push after
 * the commit, so the functions hand back what they wrote with the mentors'
 * addresses, and this hands it to the delivery, one outbox entry per request.
 */

/** A row of app.leave_request_notices or app.leave_requests_tell_new_mentors. */
export interface LeaveNoticeRow {
  notificationId: string;
  userId: string;
  email: string | null;
  meta: Record<string, unknown>;
}

/** Queues the e-mail and the push of notices the database wrote in `tx`. */
export function deliverLeaveNotices(
  notifications: Pick<NotificationsService, 'deliver'>,
  tx: PrismaClient,
  schoolId: string,
  rows: readonly LeaveNoticeRow[],
): void {
  const byRequest = new Map<string, LeaveNoticeRow[]>();
  for (const row of rows) {
    const key = String(row.meta['leaveRequestId'] ?? '');
    byRequest.set(key, [...(byRequest.get(key) ?? []), row]);
  }
  for (const told of byRequest.values()) {
    const meta = told[0]!.meta;
    const name = String(meta['studentName'] ?? '');
    const range = `${String(meta['startDate'] ?? '')} – ${String(meta['endDate'] ?? '')}`;
    const days = Number(meta['schoolDays'] ?? 0);
    notifications.deliver(tx, {
      schoolId,
      type: 'LEAVE_REQUESTED',
      meta,
      recipients: told.map((row) => ({ userId: row.userId, notificationId: row.notificationId })),
      email: {
        subject: 'New leave request / Ny ledighetsansökan',
        // The reason stays in SchemaPro: e-mail leaves it.
        body:
          `A leave request for ${name} (${range}, ${days} school ${days === 1 ? 'day' : 'days'}) is waiting for your decision in SchemaPro.` +
          `\n\nEn ledighetsansökan för ${name} (${range}, ${days} ${days === 1 ? 'skoldag' : 'skoldagar'}) väntar på ditt beslut i SchemaPro.`,
        recipients: told.flatMap((row) => (row.email ? [{ userId: row.userId, email: row.email }] : [])),
      },
    });
  }
}

/**
 * Tells the mentors whom a staff write in `tx` (a new delegation, an uppdrag
 * of MENTORSKAP) has given pending requests, and queues their e-mail and
 * push. Answers how many were told.
 */
export async function tellNewMentors(
  notifications: Pick<NotificationsService, 'deliver'>,
  tx: PrismaClient,
  schoolId: string,
): Promise<number> {
  const rows = await tx.$queryRaw<LeaveNoticeRow[]>`
    SELECT "notificationId", "userId", "email", "meta" FROM app.leave_requests_tell_new_mentors()`;
  deliverLeaveNotices(notifications, tx, schoolId, rows);
  return rows.length;
}
