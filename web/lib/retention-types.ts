/*
 * The gateway's gallring answers (src/gallring/gallring.service.ts), as the
 * web reads them. Dates are ISO days (yyyy-mm-dd) in the school's zone,
 * times ISO instants.
 */

export const RETENTION_DATA_TYPES = [
  "ATTENDANCE",
  "ABSENCE_REPORTS",
  "LEAVE_REQUESTS",
  "NOTIFICATIONS",
  "CHANGE_LOGS",
  "ABSENCE_REASONS",
  "DEPARTED_PEOPLE",
] as const;
export type RetentionDataType = (typeof RETENTION_DATA_TYPES)[number];

export type RetentionDecisionKind = "PURGE_AFTER" | "KEEP" | "UNDECIDED";

export interface RetentionPreview {
  cutoff: string;
  due: number;
  held: number;
}

export interface RetentionDecision {
  dataType: RetentionDataType;
  decision: RetentionDecisionKind;
  months: number | null;
  reference: string | null;
  decidedAt: string;
  decidedBy: string | null;
}

export interface RetentionKind {
  dataType: RetentionDataType;
  current: RetentionDecision | null;
  waitsUntil: string | null;
  preview: RetentionPreview | null;
  purgedBefore: string | null;
}

export interface GallringRun {
  startedAt: string;
  finishedAt: string | null;
  status: "RUNNING" | "DONE" | "INTERRUPTED";
  periods: Record<string, number>;
  cutoffs: Record<string, string>;
  counts: Record<string, number>;
  complete: Record<string, boolean>;
  waiting: Record<string, number>;
}

export interface RetentionOverview {
  timezone: string;
  nightlyHour: number;
  kinds: RetentionKind[];
  runs: GallringRun[];
  history: RetentionDecision[];
}

export interface PurgedBefore {
  dataType: RetentionDataType;
  purgedBefore: string;
}

export interface RetentionDecisionInput {
  dataType: RetentionDataType;
  decision: RetentionDecisionKind;
  months?: number;
  reference?: string;
}

/** The periods the page offers, in months. A decision made with another value is listed too. */
export const PERIOD_CHOICES = [1, 3, 6, 12, 24, 36, 60, 120] as const;

/** "12 oktober 2025" / "12 October 2025", for an ISO day. */
export function formatRetentionDay(day: string, locale: string): string {
  return new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "sv-SE", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00Z`));
}

/** "12 oktober 2026 14:05", for an instant, in the school's zone. */
export function formatRetentionInstant(instant: string, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "sv-SE", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(new Date(instant));
}

/** Whether an ISO day or instant falls before the purge date of its kind. */
export function isBeforePurge(date: string | null | undefined, purgedBefore: string | null | undefined): boolean {
  if (!date || !purgedBefore) return false;
  return date.slice(0, 10) < purgedBefore;
}
