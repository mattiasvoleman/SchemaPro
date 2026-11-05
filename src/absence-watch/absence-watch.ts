import type { AbsenceWatchBasis, AbsenceWatchCadence, AbsenceWatchGroup, AbsenceWatchKind } from '@prisma/client';

/*
 * Frånvarobevakning (20261231090100): the vocabulary the migration, the
 * gateway and the web share. The figures are the migration's CHECKs
 * (AbsenceWatchLimits_a_kind_has_its_figures); a DTO says them first so a
 * refusal names the field instead of a constraint.
 */

export const ABSENCE_WATCH_GROUPS: readonly AbsenceWatchGroup[] = ['MENTOR', 'REKTOR', 'KANSLI', 'GUARDIAN'];
export const ABSENCE_WATCH_KINDS: readonly AbsenceWatchKind[] = ['SHARE', 'CONSECUTIVE'];
export const ABSENCE_WATCH_BASES: readonly AbsenceWatchBasis[] = ['VALID', 'INVALID', 'ALL'];
export const ABSENCE_WATCH_CADENCES: readonly AbsenceWatchCadence[] = ['WEEKLY', 'MONTHLY'];

/** Share of the registered minutes, in percent. */
export const PERCENT = { min: 1, max: 100 } as const;
/** The window the share is counted over, in calendar days ending yesterday. */
export const WINDOW_DAYS = { min: 7, max: 60 } as const;
/** Skoldagar in a row. */
export const CONSECUTIVE_DAYS = { min: 2, max: 30 } as const;

/** The job's name in the runner, in JobRuns and in JobClaims. */
export const ABSENCE_WATCH_JOB = 'absence-watch';
/** The tick: whether a school's night is due is the claim's question, asked every five minutes. */
export const ABSENCE_WATCH_INTERVAL_MS = 5 * 60 * 1000;
/** Schools claimed per tick, run one after another; the next tick takes the next five. */
export const SCHOOLS_PER_TICK = 5;
/**
 * The school-local hour from which a school's night may be claimed: after the
 * gallring's 03:00 and the SS12000 nightly, and with the day's registers long
 * closed, before anyone reads the sammanställning at 07:00.
 */
export const ABSENCE_WATCH_HOUR_LOCAL = 5;

/** The days of findings the view shows beside the open ones when asked for the recent. */
export const RECENT_DAYS = 60;
/** The most findings one read returns; a school over it is told so. */
export const FINDINGS_LIMIT = 2000;
