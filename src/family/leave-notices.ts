import type { PrismaClient } from '@prisma/client';
import type { OutboxEntry } from '../notifications/notification-outbox';
import type { NotificationsService } from '../notifications/notifications.service';

/*
 * LEAVE_REQUESTED, the gateway's half (Mentorns ledighetsbeslut,
 * 20261023091000).
 *
 * The database writes the notices from the row: a trigger tells the
 * deciding mentors of every new request, whatever path it came by, and
 * app.leave_requests_tell_new_mentors tells the mentors a delegation or an
 * uppdrag has since given a pending request to. Each mentor is told once per
 * request (LeaveRequestNotices, 20261101090000). What the database cannot do
 * is send the e-mail and the push after the commit, so the functions hand
 * back what they wrote with the mentors' addresses, and this hands it to the
 * delivery, one outbox entry per request.
 */

/** A row of app.leave_request_notices or app.leave_requests_tell_new_mentors. */
export interface LeaveNoticeRow {
  notificationId: string;
  userId: string;
  email: string | null;
  meta: Record<string, unknown>;
}

/** The delivery's entries for notices the database wrote: one per request. */
export function leaveNoticeEntries(schoolId: string, rows: readonly LeaveNoticeRow[]): OutboxEntry[] {
  const byRequest = new Map<string, LeaveNoticeRow[]>();
  for (const row of rows) {
    const key = String(row.meta['leaveRequestId'] ?? '');
    byRequest.set(key, [...(byRequest.get(key) ?? []), row]);
  }
  return [...byRequest.values()].map((told) => {
    const meta = told[0]!.meta;
    const name = String(meta['studentName'] ?? '');
    const range = `${String(meta['startDate'] ?? '')} – ${String(meta['endDate'] ?? '')}`;
    const days = Number(meta['schoolDays'] ?? 0);
    return {
      schoolId,
      type: 'LEAVE_REQUESTED',
      meta,
      recipients: told.map((row) => ({ userId: row.userId, notificationId: row.notificationId })),
      email: {
        subject: 'New leave request / Ny ledighetsansökan',
        // The reason stays in SchemaPro: e-mail leaves it.
        body:
          `A leave request for ${name} (${range}, ${days} school ${days === 1 ? 'day' : 'days'}) is waiting for your decision in Rastra timetable.` +
          `\n\nEn ledighetsansökan för ${name} (${range}, ${days} ${days === 1 ? 'skoldag' : 'skoldagar'}) väntar på ditt beslut i Rastra Schema.`,
        recipients: told.flatMap((row) => (row.email ? [{ userId: row.userId, email: row.email }] : [])),
      },
    };
  });
}

/** Queues the e-mail and the push of notices the database wrote in `tx`. */
export function deliverLeaveNotices(
  notifications: Pick<NotificationsService, 'deliver'>,
  tx: PrismaClient,
  schoolId: string,
  rows: readonly LeaveNoticeRow[],
): void {
  for (const entry of leaveNoticeEntries(schoolId, rows)) notifications.deliver(tx, entry);
}

/**
 * Writes the notices the school's pending requests still owe
 * (app.leave_requests_tell_new_mentors) and answers them with the addresses.
 * The database decides the school from the transaction's principal: the
 * staff member's, or the sync's or an integration key's when no person is
 * behind it. Waits for any filing or catch-up of the same school in flight.
 */
export async function askNewMentors(tx: PrismaClient): Promise<LeaveNoticeRow[]> {
  return tx.$queryRaw<LeaveNoticeRow[]>`
    SELECT "notificationId", "userId", "email", "meta" FROM app.leave_requests_tell_new_mentors()`;
}

/**
 * Tells the mentors whom a staff write in `tx` (a new delegation, an uppdrag
 * of MENTORSKAP) has given pending requests, and queues their e-mail and
 * push. Answers how many were told. A transaction withRls did not open (the
 * sync's, an integration key's) has no outbox: it calls askNewMentors and
 * hands leaveNoticeEntries to NotificationsService.deliverCommitted once it
 * has committed.
 */
export async function tellNewMentors(
  notifications: Pick<NotificationsService, 'deliver'>,
  tx: PrismaClient,
  schoolId: string,
): Promise<number> {
  const rows = await askNewMentors(tx);
  deliverLeaveNotices(notifications, tx, schoolId, rows);
  return rows.length;
}
