import type { OutboxEntry } from '../notifications/notification-outbox';

/*
 * What a request and its reminder tell a guardian (Kvittens, 20270117091000).
 *
 * The notice in the inbox has the title, behind the login. The e-mail says
 * that a message waits and nothing else: no title, no pupil, no text, so the
 * message is read only after signing in, which is also where it is confirmed.
 * The push says less still (push-messages.ts). The database writes the
 * reminders (app.ack_remind_due) and hands them back with the addresses; the
 * request's own notices are written by the service in the staff member's
 * transaction.
 */

const EMAIL_SUBJECT = 'Message from the school / Meddelande från skolan';

const requestedBody =
  'The school has sent you a message and asks you to confirm that you have seen it. Log in to Rastra timetable to read it and confirm.\n\n' +
  'Skolan har skickat ett meddelande till dig och ber dig bekräfta att du har sett det. Logga in i Rastra Schema för att läsa det och bekräfta.';
const reminderBody =
  'A message from the school is waiting for your confirmation. Log in to Rastra timetable to read it and confirm.\n\n' +
  'Ett meddelande från skolan väntar på din bekräftelse. Logga in i Rastra Schema för att läsa det och bekräfta.';

/** The inbox row's meta and the e-mail of a new request. */
export function requestedEntries(requestId: string, title: string): { meta: Record<string, unknown>; email: { subject: string; body: string } } {
  return { meta: { requestId, title }, email: { subject: EMAIL_SUBJECT, body: requestedBody } };
}

/** A row of app.ack_remind_due. */
export interface ReminderRow {
  notification_id: string;
  user_id: string;
  school_id: string;
  email: string | null;
  meta: Record<string, unknown>;
}

/** The delivery's entries for reminders the database wrote: one per school, since an entry has one school. */
export function reminderEntries(rows: readonly ReminderRow[]): OutboxEntry[] {
  const bySchool = new Map<string, ReminderRow[]>();
  for (const row of rows) bySchool.set(row.school_id, [...(bySchool.get(row.school_id) ?? []), row]);
  return [...bySchool].map(([schoolId, told]) => ({
    schoolId,
    type: 'ACK_REMINDER',
    meta: {},
    recipients: told.map((row) => ({ userId: row.user_id, notificationId: row.notification_id })),
    email: {
      subject: 'Reminder / Påminnelse från skolan',
      body: reminderBody,
      recipients: told.flatMap((row) => (row.email ? [{ userId: row.user_id, email: row.email }] : [])),
    },
  }));
}
