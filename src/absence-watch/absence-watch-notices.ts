import type { AbsenceWatchGroup } from '@prisma/client';
import type { OutboxEntry } from '../notifications/notification-outbox';

/*
 * The digest, as the delivery has it (Frånvarobevakning, 20261231090100).
 *
 * The database writes the notices (app.absence_watch_digest) and hands them
 * back with the addresses; the e-mail and the push go after the commit. What
 * they say is a count and a period: how many pupils are over one of the
 * school's limits, how many passed one in the period. No name, no figure of
 * minutes, no class and never a reason; the view behind the login has the
 * rest. A push says less still (push-messages.ts): that there is a summary.
 */

/** A row of app.absence_watch_digest. */
export interface DigestRow {
  notification_id: string;
  user_id: string;
  email: string | null;
  meta: Record<string, unknown>;
}

const num = (value: unknown): number => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0);
const day = (value: unknown): string => (typeof value === 'string' ? value.slice(0, 10) : '');

/**
 * The two sentences (English, Swedish) a recipient of a group is told. `open`
 * and `crossed` are counts of pupils that overlap only by chance: a pupil can
 * have crossed in the period and be under the limit again, and one who is over
 * a limit may have crossed before it. So they are told apart, never "of
 * them".
 */
export function digestSentences(
  group: AbsenceWatchGroup,
  open: number,
  crossed: number,
  periodStart: string,
  periodEnd: string,
): { en: string; sv: string } {
  const period = `${periodStart} – ${periodEnd}`;
  if (group === 'GUARDIAN') {
    const en =
      open > 0
        ? open === 1
          ? 'One of your children is over a limit the school has set for absence.'
          : `${open} of your children are over a limit the school has set for absence.`
        : crossed === 1
          ? 'One of your children passed a limit the school has set for absence, and is under it again.'
          : `${crossed} of your children passed a limit the school has set for absence, and are under it again.`;
    const sv =
      open > 0
        ? open === 1
          ? 'Ett av dina barn har frånvaro över en gräns som skolan har satt.'
          : `${open} av dina barn har frånvaro över en gräns som skolan har satt.`
        : crossed === 1
          ? 'Ett av dina barn passerade en gräns som skolan har satt för frånvaro, och är under den igen.'
          : `${crossed} av dina barn passerade en gräns som skolan har satt för frånvaro, och är under den igen.`;
    return { en: `${en} (${period}) Log in to Rastra timetable to see more.`, sv: `${sv} (${period}) Logga in i Rastra Schema för att se mer.` };
  }
  const enOpen = open === 1 ? '1 pupil is over one of the school\'s absence limits' : `${open} pupils are over one of the school's absence limits`;
  const svOpen = open === 1 ? '1 elev är över en av skolans gränser för frånvaro' : `${open} elever är över en av skolans gränser för frånvaro`;
  const enCrossed = crossed === 1 ? '1 pupil passed a limit' : `${crossed} pupils passed a limit`;
  const svCrossed = crossed === 1 ? '1 elev passerade en gräns' : `${crossed} elever passerade en gräns`;
  const en =
    open > 0
      ? `${enOpen} now.${crossed > 0 ? ` ${enCrossed} ${period}.` : ''}`
      : `${enCrossed} ${period} and ${crossed === 1 ? 'is' : 'are'} under it again.`;
  const sv =
    open > 0
      ? `${svOpen} nu.${crossed > 0 ? ` ${svCrossed} ${period}.` : ''}`
      : `${svCrossed} ${period} och är under den igen.`;
  return { en: `${en} Log in to Rastra timetable to see who.`, sv: `${sv} Logga in i Rastra Schema för att se vilka.` };
}

/**
 * The delivery's entries for a digest the database wrote: one per group and
 * pair of counts, since the e-mail of a recipient says their own numbers and
 * an entry has one text. Everyone with the same numbers shares an entry.
 */
export function digestEntries(schoolId: string, rows: readonly DigestRow[]): OutboxEntry[] {
  const byText = new Map<string, DigestRow[]>();
  for (const row of rows) {
    const key = [row.meta['group'], row.meta['open'], row.meta['crossed'], row.meta['periodStart'], row.meta['periodEnd']].join('|');
    byText.set(key, [...(byText.get(key) ?? []), row]);
  }
  return [...byText.values()].map((told) => {
    const meta = told[0]!.meta;
    const { en, sv } = digestSentences(
      meta['group'] as AbsenceWatchGroup,
      num(meta['open']),
      num(meta['crossed']),
      day(meta['periodStart']),
      day(meta['periodEnd']),
    );
    return {
      schoolId,
      type: 'ABSENCE_WATCH_DIGEST',
      meta,
      recipients: told.map((row) => ({ userId: row.user_id, notificationId: row.notification_id })),
      email: {
        subject: 'Absence summary / Frånvarosammanställning',
        body: `${en}\n\n${sv}`,
        recipients: told.flatMap((row) => (row.email ? [{ userId: row.user_id, email: row.email }] : [])),
      },
    };
  });
}
