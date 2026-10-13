import { todayInZone, zonedTimeToUtc } from '../common/utils/time';

/**
 * The kinds of data a school sets a retention period for, in the order the
 * page lists them (RetentionDataType, 20261021110000; ACCESS_LOG, the read
 * log, 20261026090000). Seven are rows that go; DEPARTED_PEOPLE are
 * pseudonymised in place.
 */
export const RETENTION_DATA_TYPES = [
  'ATTENDANCE',
  'ABSENCE_REPORTS',
  'LEAVE_REQUESTS',
  'NOTIFICATIONS',
  'CHANGE_LOGS',
  'ABSENCE_REASONS',
  'ACCESS_LOG',
  'DEPARTED_PEOPLE',
] as const;
export type RetentionDataTypeValue = (typeof RETENTION_DATA_TYPES)[number];

export const ROW_KINDS = RETENTION_DATA_TYPES.filter((kind) => kind !== 'DEPARTED_PEOPLE');

export const RETENTION_DECISIONS = ['PURGE_AFTER', 'KEEP', 'UNDECIDED'] as const;
export type RetentionDecisionValue = (typeof RETENTION_DECISIONS)[number];

/** RetentionDecisions_months_are_sane. */
export const MIN_MONTHS = 1;
export const MAX_MONTHS = 120;

/** The school-local hour from which a school's night may be claimed. */
export const GALLRING_HOUR_LOCAL = 3;

/** A decision that gallrar more waits this long (app.retention_months_in_force). */
export const DECISION_WAIT_MS = 24 * 3_600_000;

/**
 * The first night a decision recorded at `decidedAt` can act on: the school
 * date whose GALLRING_HOUR_LOCAL is at least 24 hours later. "Natten mot"
 * that date.
 */
export function firstNightFor(decidedAt: Date, timeZone: string): string {
  const earliest = new Date(decidedAt.getTime() + DECISION_WAIT_MS);
  const day = todayInZone(timeZone, earliest).toISOString().slice(0, 10);
  const hour = `${String(GALLRING_HOUR_LOCAL).padStart(2, '0')}:00`;
  if (zonedTimeToUtc(day, hour, timeZone).getTime() >= earliest.getTime()) return day;
  const next = new Date(`${day}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}
