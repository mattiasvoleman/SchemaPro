/*
 * Rapporteringsgrad (20270108090100): the vocabulary the migration, the
 * gateway and the web share. The limit is the migration's CHECK
 * (ReportingSettings_open_after_days_is_sane); a DTO says it first so a
 * refusal names the field instead of a constraint.
 */

/** The periods the view adds the stored days up over. */
export const REPORTING_PERIODS = ['WEEK', 'MONTH', 'YEAR'] as const;
export type ReportingPeriod = (typeof REPORTING_PERIODS)[number];
export const DEFAULT_PERIOD: ReportingPeriod = 'WEEK';

/** Calendar days a register may wait before a lesson counts as open too long. */
export const OPEN_AFTER_DAYS = { min: 1, max: 30 } as const;
/** What a school that has chosen nothing gets (ReportingSettings.openAfterDays' default). */
export const DEFAULT_OPEN_AFTER_DAYS = 2;
/** How far back a teacher's list of open lessons looks (app.reporting_open_lessons takes 1 to 90). */
export const OPEN_LESSONS_DAYS = 30;

/** The job's name in the runner, in JobRuns and in JobClaims. */
export const REPORTING_RATE_JOB = 'reporting-rate';
/** The tick: whether a school's night is due is the claim's question, asked every five minutes. */
export const REPORTING_RATE_INTERVAL_MS = 5 * 60 * 1000;
/** Schools claimed per tick, run one after another; the next tick takes the next ten. */
export const SCHOOLS_PER_TICK = 10;
/**
 * The school-local hour from which a school's night may be claimed: after the
 * gallring's 03:00, the SS12000 nightly and Frånvarobevakning's 05:00, and
 * with the day's registers long saved, before anyone reads the weekly notice
 * on a Monday morning.
 */
export const REPORTING_RATE_HOUR_LOCAL = 6;
