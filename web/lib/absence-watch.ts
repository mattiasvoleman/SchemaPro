/**
 * Frånvarobevakning, the web's side of the vocabulary and the figures
 * (/admin/absence-watch, and the findings of the mentor and the guardian).
 *
 * The gateway's src/absence-watch/absence-watch.ts says the same bounds and
 * the same words (the migration's CHECKs are the root of them);
 * absence-watch.test.ts reads that file and fails when this one drifts. Free
 * of React and of imports, so a test can read it as it is.
 *
 * Nothing here carries or implies a reason for an absence: the figures are
 * minutes and days, and what a limit counts is giltig, ogiltig or all
 * frånvaro, the school's own word for the kind.
 */

export const ABSENCE_WATCH_GROUPS = ["MENTOR", "REKTOR", "KANSLI", "GUARDIAN"] as const;
export const ABSENCE_WATCH_KINDS = ["SHARE", "CONSECUTIVE"] as const;
export const ABSENCE_WATCH_BASES = ["VALID", "INVALID", "ALL"] as const;
export const ABSENCE_WATCH_CADENCES = ["WEEKLY", "MONTHLY"] as const;

export type AbsenceWatchGroup = (typeof ABSENCE_WATCH_GROUPS)[number];
export type AbsenceWatchKind = (typeof ABSENCE_WATCH_KINDS)[number];
export type AbsenceWatchBasis = (typeof ABSENCE_WATCH_BASES)[number];
export type AbsenceWatchCadence = (typeof ABSENCE_WATCH_CADENCES)[number];

/** Share of the registered minutes, in percent. */
export const PERCENT = { min: 1, max: 100 } as const;
/** The window a share is counted over, in calendar days ending yesterday. */
export const WINDOW_DAYS = { min: 7, max: 60 } as const;
/** Skoldagar in a row. */
export const CONSECUTIVE_DAYS = { min: 2, max: 30 } as const;
/** The days of closed findings the view shows beside the open ones when asked for the recent. */
export const RECENT_DAYS = 60;
/** The most findings one read returns. */
export const FINDINGS_LIMIT = 2000;

/** The gateway's code for a second limit with the same group, kind and basis (409). */
export const LIMIT_EXISTS = "ABSENCE_WATCH_LIMIT_EXISTS";

/** One limit of GET /api/v1/absence-watch (AbsenceWatchLimitView). */
export interface AbsenceWatchLimit {
  id: string;
  recipientGroup: AbsenceWatchGroup;
  kind: AbsenceWatchKind;
  basis: AbsenceWatchBasis;
  /** SHARE: the percent of the registered minutes. */
  percent: number | null;
  /** SHARE: the days the share is counted over. */
  windowDays: number | null;
  /** CONSECUTIVE: the skoldagar in a row. */
  consecutiveDays: number | null;
}

export interface AbsenceWatchOverview {
  settings: {
    enabled: boolean;
    /** ISO date the switch last went on; null if it never has. */
    enabledOn: string | null;
    cadence: Record<AbsenceWatchGroup, AbsenceWatchCadence>;
  };
  limits: AbsenceWatchLimit[];
}

/** What PUT /settings takes: a save names what changed. */
export interface AbsenceWatchSettingsChange {
  enabled?: boolean;
  mentorCadence?: AbsenceWatchCadence;
  rektorCadence?: AbsenceWatchCadence;
  kansliCadence?: AbsenceWatchCadence;
  guardianCadence?: AbsenceWatchCadence;
}

/** The settings field that holds a group's cadence. */
export const CADENCE_FIELD: Readonly<Record<AbsenceWatchGroup, keyof AbsenceWatchSettingsChange>> = {
  MENTOR: "mentorCadence",
  REKTOR: "rektorCadence",
  KANSLI: "kansliCadence",
  GUARDIAN: "guardianCadence",
};

/** One finding of GET /api/v1/absence-watch/findings (AbsenceWatchFindingView). */
export interface AbsenceWatchFinding {
  id: string;
  studentId: string;
  /** Null when the reader may not read the pupil's row. */
  studentName: string | null;
  className: string | null;
  recipientGroup: AbsenceWatchGroup;
  kind: AbsenceWatchKind;
  basis: AbsenceWatchBasis;
  percent: number | null;
  windowDays: number | null;
  consecutiveDays: number | null;
  /** ISO dates; clearedOn is null while the pupil is over the limit. */
  firstCrossedOn: string;
  lastSeenOn: string;
  clearedOn: string | null;
  /** SHARE: minutes absent of the minutes registered in the window. */
  absentMinutes: number | null;
  recordedMinutes: number | null;
  /** CONSECUTIVE: the run, in skoldagar. */
  streakDays: number | null;
}

export interface AbsenceWatchFindings {
  findings: AbsenceWatchFinding[];
  /** True when more than FINDINGS_LIMIT matched and the oldest were left out. */
  truncated: boolean;
}

/** The part of a limit or a finding that says what it counts. */
export type LimitShape = Pick<
  AbsenceWatchLimit,
  "kind" | "basis" | "percent" | "windowDays" | "consecutiveDays"
>;

/**
 * The share of the registered minutes a finding measured, rounded to a whole
 * percent. Null for a run of days, and where there is nothing registered.
 */
export function measuredPercent(finding: Pick<AbsenceWatchFinding, "kind" | "absentMinutes" | "recordedMinutes">): number | null {
  if (finding.kind !== "SHARE" || finding.absentMinutes === null || !finding.recordedMinutes) return null;
  return Math.round((finding.absentMinutes * 100) / finding.recordedMinutes);
}

/**
 * The findings an administrator reads: the pupils over a limit now before the
 * ones back under it, each in the gateway's order (newest crossing first).
 */
export function openFirst<T extends Pick<AbsenceWatchFinding, "clearedOn">>(findings: readonly T[]): T[] {
  return [...findings.filter((one) => one.clearedOn === null), ...findings.filter((one) => one.clearedOn !== null)];
}

/** How many different pupils the findings are about. */
export function pupilsIn(findings: readonly Pick<AbsenceWatchFinding, "studentId">[]): number {
  return new Set(findings.map((one) => one.studentId)).size;
}

// ---------------------------------------------------------------------------
// The limit form
// ---------------------------------------------------------------------------

/** The form's fields as typed: the figures stay text until they are sent. */
export interface LimitForm {
  recipientGroup: AbsenceWatchGroup;
  kind: AbsenceWatchKind;
  basis: AbsenceWatchBasis;
  percent: string;
  windowDays: string;
  consecutiveDays: string;
}

export function emptyLimitForm(): LimitForm {
  return { recipientGroup: "MENTOR", kind: "SHARE", basis: "ALL", percent: "", windowDays: "", consecutiveDays: "" };
}

export function formOfLimit(limit: AbsenceWatchLimit): LimitForm {
  return {
    recipientGroup: limit.recipientGroup,
    kind: limit.kind,
    basis: limit.basis,
    percent: limit.percent === null ? "" : String(limit.percent),
    windowDays: limit.windowDays === null ? "" : String(limit.windowDays),
    consecutiveDays: limit.consecutiveDays === null ? "" : String(limit.consecutiveDays),
  };
}

export type FigureField = "percent" | "windowDays" | "consecutiveDays";

const BOUNDS: Readonly<Record<FigureField, { min: number; max: number }>> = {
  percent: PERCENT,
  windowDays: WINDOW_DAYS,
  consecutiveDays: CONSECUTIVE_DAYS,
};

/** The figures a kind of limit carries: a share has a percent and a window, a run its days. */
export const FIGURES_OF: Readonly<Record<AbsenceWatchKind, readonly FigureField[]>> = {
  SHARE: ["percent", "windowDays"],
  CONSECUTIVE: ["consecutiveDays"],
};

export function boundsOf(field: FigureField): { min: number; max: number } {
  return BOUNDS[field];
}

/** A whole number of text, or null for anything else (empty, 1.5, 1e2, -3). */
export function wholeNumber(text: string): number | null {
  return /^\d{1,4}$/.test(text.trim()) ? Number(text.trim()) : null;
}

/** The figures of the form's kind that are not a whole number within their bounds. */
export function figureErrors(form: LimitForm): FigureField[] {
  return FIGURES_OF[form.kind].filter((field) => {
    const value = wholeNumber(form[field]);
    const { min, max } = BOUNDS[field];
    return value === null || value < min || value > max;
  });
}

/**
 * The figures a PUT /limits/:id takes (a share's percent and window, a run's
 * days, and nothing of the other kind: the gateway refuses a limit that
 * carries both), and a POST /limits adds them to the group, kind and basis.
 * Call it on a form with no figureErrors.
 */
export function figuresOfForm(form: LimitForm): { percent: number; windowDays: number } | { consecutiveDays: number } {
  return form.kind === "SHARE"
    ? { percent: Number(form.percent), windowDays: Number(form.windowDays) }
    : { consecutiveDays: Number(form.consecutiveDays) };
}
