import type { OutboxEntry } from '../notifications/notification-outbox';

/*
 * The reminders and the weekly notice, as the delivery has them
 * (Rapporteringsgrad, 20270112090100).
 *
 * The database writes the notices (app.reporting_remind, app.reporting_digest)
 * and hands them back with the addresses; the e-mail and the push go after the
 * commit. What they say is a count: a teacher is told how many lessons wait
 * for their register and how long the school lets one wait, a rektor how many
 * of last week's held lessons had a saved register and how many teachers they
 * are spread over. No name, no subject, no class and no time, so that a
 * message in an inbox or on a lock screen says nothing about who has not
 * reported what; the pages behind the login have the rest. A push says less
 * still (push-messages.ts): that there is something to see, and no figure.
 */

/** A row of app.reporting_remind or app.reporting_digest. */
export interface NoticeRow {
  notification_id: string;
  user_id: string;
  email: string | null;
  meta: Record<string, unknown>;
}

const num = (value: unknown): number => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0);
const day = (value: unknown): string => (typeof value === 'string' ? value.slice(0, 10) : '');

/**
 * The two sentences (English, Swedish) a teacher is told. The limit is in
 * calendar days of the school's dates, and a lesson is told of when its day is
 * that many days back or more: "at least", not "more than".
 */
export function reminderSentences(count: number, limitDays: number): { en: string; sv: string } {
  const en = `You have ${count === 1 ? '1 lesson' : `${count} lessons`} held at least ${limitDays === 1 ? '1 day' : `${limitDays} days`} ago where attendance has not been saved.`;
  const sv = `Du har ${count === 1 ? '1 lektion' : `${count} lektioner`} som hölls för minst ${limitDays === 1 ? '1 dag' : `${limitDays} dagar`} sedan och där närvaron inte är sparad.`;
  return { en: `${en} Log in to Rastra timetable to see which.`, sv: `${sv} Logga in i Rastra Schema för att se vilka.` };
}

/**
 * The two sentences a rektor is told of the week. The share is of the held
 * lessons of the whole school, never of a person.
 */
export function digestSentences(
  held: number,
  reported: number,
  teachers: number,
  periodStart: string,
  periodEnd: string,
): { en: string; sv: string } {
  const period = `${periodStart} – ${periodEnd}`;
  const share = held > 0 ? Math.round((reported / held) * 100) : null;
  const en =
    `Last week (${period}), ${reported} of ${held} held ${held === 1 ? 'lesson' : 'lessons'} had a saved register` +
    `${share === null ? '' : ` (${share}%)`}, spread over ${teachers} ${teachers === 1 ? 'teacher' : 'teachers'}.`;
  const sv =
    `Förra veckan (${period}) hade ${reported} av ${held} ${held === 1 ? 'hållen lektion' : 'hållna lektioner'} sparad närvaro` +
    `${share === null ? '' : ` (${share} %)`}, fördelade på ${teachers} lärare.`;
  return { en: `${en} Log in to Rastra timetable to see more.`, sv: `${sv} Logga in i Rastra Schema för att se mer.` };
}

/** Groups rows that say the same, since an entry has one text: everyone with the same numbers shares an entry. */
function grouped(rows: readonly NoticeRow[], fields: readonly string[]): NoticeRow[][] {
  const byText = new Map<string, NoticeRow[]>();
  for (const row of rows) {
    const key = fields.map((field) => row.meta[field]).join('|');
    byText.set(key, [...(byText.get(key) ?? []), row]);
  }
  return [...byText.values()];
}

const recipientsOf = (told: readonly NoticeRow[]) => ({
  recipients: told.map((row) => ({ userId: row.user_id, notificationId: row.notification_id })),
  mails: told.flatMap((row) => (row.email ? [{ userId: row.user_id, email: row.email }] : [])),
});

/**
 * The delivery's entries for the reminders the database wrote: one per pair of
 * counts, since the e-mail of a teacher says their own number of lessons.
 */
export function reminderEntries(schoolId: string, rows: readonly NoticeRow[]): OutboxEntry[] {
  return grouped(rows, ['count', 'limitDays']).map((told) => {
    const meta = told[0]!.meta;
    const { en, sv } = reminderSentences(num(meta['count']), num(meta['limitDays']));
    const { recipients, mails } = recipientsOf(told);
    return {
      schoolId,
      type: 'LESSON_REPORT_REMINDER',
      meta,
      recipients,
      email: { subject: 'Lessons waiting for attendance / Lektioner väntar på närvaro', body: `${en}\n\n${sv}`, recipients: mails },
    };
  });
}

/** The delivery's entries for the week's notice: every rektor hears the same numbers, so it is one entry. */
export function digestEntries(schoolId: string, rows: readonly NoticeRow[]): OutboxEntry[] {
  return grouped(rows, ['periodStart', 'periodEnd', 'held', 'reported', 'teachers']).map((told) => {
    const meta = told[0]!.meta;
    const { en, sv } = digestSentences(num(meta['held']), num(meta['reported']), num(meta['teachers']), day(meta['periodStart']), day(meta['periodEnd']));
    const { recipients, mails } = recipientsOf(told);
    return {
      schoolId,
      type: 'REPORTING_RATE_DIGEST',
      meta,
      recipients,
      email: { subject: 'Reporting rate / Rapporteringsgrad', body: `${en}\n\n${sv}`, recipients: mails },
    };
  });
}
