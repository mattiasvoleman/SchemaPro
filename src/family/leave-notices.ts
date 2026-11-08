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

/*
 * THE CONSENT NOTICES (Ledighetspolicy, 20270205091000).
 *
 * When the school asks every guardian to consent to a leave request, the database
 * writes the notices from the rows: the request for consent to the other guardians
 * when the request is filed (a trigger), the one reminder (app.leave_consent_pass),
 * the refusal to whoever applied (app.leave_consent_answer), and the
 * LEAVE_REQUESTED the mentors are owed when the last guardian says yes or a
 * custody that ended makes the request clear. The functions hand the rows back with
 * the addresses, and this hands them to the delivery after the commit.
 *
 * What they say: that a leave request waits, or ended. The e-mail names no child, no
 * date, no reason, and neither who applied nor who did not consent: separated
 * guardians may hide from one another, and a mail is read on any screen. The push
 * says less still (push-messages.ts). The inbox row has the child and the dates, behind
 * the login.
 */

/** A row of app.leave_consent_notices, app.leave_consent_answer or app.leave_consent_pass. */
export interface ConsentNoticeRow {
  notificationId: string;
  userId: string;
  email: string | null;
  type: string;
  meta: Record<string, unknown>;
  schoolId: string;
}

const CONSENT_MAIL = {
  LEAVE_CONSENT_REQUESTED: {
    subject: 'A leave request needs your consent / En ledighetsansökan behöver ditt samtycke',
    body:
      'A leave request for your child is waiting for your consent. Log in to Rastra timetable to read it and answer.\n\n' +
      'En ledighetsansökan för ditt barn väntar på ditt samtycke. Logga in i Rastra Schema för att läsa den och svara.',
  },
  LEAVE_CONSENT_REMINDER: {
    subject: 'Reminder: a leave request needs your consent / Påminnelse: en ledighetsansökan behöver ditt samtycke',
    body:
      'A leave request for your child is still waiting for your consent. Log in to Rastra timetable to read it and answer.\n\n' +
      'En ledighetsansökan för ditt barn väntar fortfarande på ditt samtycke. Logga in i Rastra Schema för att läsa den och svara.',
  },
  LEAVE_CONSENT_REFUSED: {
    subject: 'Your leave request has ended / Din ledighetsansökan har avslutats',
    body:
      'A leave request you made has ended because it did not get every guardian\'s consent. Log in to Rastra timetable to read more.\n\n' +
      'En ledighetsansökan du gjort har avslutats eftersom den inte fick alla vårdnadshavares samtycke. Logga in i Rastra Schema för att läsa mer.',
  },
} as const;

type ConsentKind = keyof typeof CONSENT_MAIL;

const isConsentKind = (type: string): type is ConsentKind => Object.prototype.hasOwnProperty.call(CONSENT_MAIL, type);

/**
 * The delivery's entries for notices the database wrote about a request's consent: one per
 * school and kind (an entry has one school and one type), and the mentors' LEAVE_REQUESTED
 * as the filing's are, one per request.
 */
export function consentNoticeEntries(rows: readonly ConsentNoticeRow[]): OutboxEntry[] {
  const mentors = new Map<string, LeaveNoticeRow[]>();
  const others = new Map<string, ConsentNoticeRow[]>();
  for (const row of rows) {
    if (row.type === 'LEAVE_REQUESTED') mentors.set(row.schoolId, [...(mentors.get(row.schoolId) ?? []), row]);
    else if (isConsentKind(row.type)) others.set(`${row.schoolId}/${row.type}`, [...(others.get(`${row.schoolId}/${row.type}`) ?? []), row]);
  }
  return [
    ...[...mentors].flatMap(([schoolId, told]) => leaveNoticeEntries(schoolId, told)),
    ...[...others.values()].map((told) => {
      const type = told[0]!.type as ConsentKind;
      return {
        schoolId: told[0]!.schoolId,
        type,
        meta: {},
        recipients: told.map((row) => ({ userId: row.userId, notificationId: row.notificationId })),
        email: {
          subject: CONSENT_MAIL[type].subject,
          body: CONSENT_MAIL[type].body,
          recipients: told.flatMap((row) => (row.email ? [{ userId: row.userId, email: row.email }] : [])),
        },
      };
    }),
  ];
}

/** Queues the e-mail and the push of the consent notices the database wrote in `tx`. */
export function deliverConsentNotices(notifications: Pick<NotificationsService, 'deliver'>, tx: PrismaClient, rows: readonly ConsentNoticeRow[]): void {
  for (const entry of consentNoticeEntries(rows)) notifications.deliver(tx, entry);
}
