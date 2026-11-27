/*
 * The rektor's assessment of a teacher's level within the ordinance's span, and a registered exception under 11 § (SFS 2026:1487),
 * as the card's form holds it: a draft of strings, its problems said before the gateway says them, and the body PUT
 * /api/v1/scope-assessments/:userId sends. The gateway owns every rule (src/staffing/scope-assessments.service.ts and the table's
 * CHECKs); this repeats only what a person can fix before pressing save, with the same bounds, so that a refusal is rare and the
 * sentence is in the reader's language.
 *
 * NO ARITHMETIC OF THE ORDINANCE'S EDGE. Whether a level is above the lydelse's highest edge is the gateway's to say (it reads the
 * lydelse that holds on the year's first day); the form holds a level to a whole number of hours in 1..1500, the table's own sanity bound.
 */

export const SCOPE_NOTE_MAX = 500;
export const SCOPE_LEVEL_MAX = 1500;

export type ScopeExceptionKind = "OWN_INITIATIVE" | "SMALL_GROUP";
export const SCOPE_EXCEPTIONS: readonly ScopeExceptionKind[] = ["OWN_INITIATIVE", "SMALL_GROUP"];

/** What the gateway answers for one teacher and year (ScopeAssessmentResponse), or what the report's row carries. */
export interface ScopeAssessmentShape {
  levelHours?: number | null;
  teachingLevelHours?: number | null;
  exceptionKind: ScopeExceptionKind | null;
  ownInitiativeOn: string | null;
  note: string | null;
}

export interface ScopeAssessmentDraft {
  /** Whole hours as typed; "" = none set. */
  level: string;
  /** "" = no exception. */
  exceptionKind: "" | ScopeExceptionKind;
  /** yyyy-mm-dd; "" = none. */
  ownInitiativeOn: string;
  note: string;
}

export const EMPTY_SCOPE_DRAFT: ScopeAssessmentDraft = { level: "", exceptionKind: "", ownInitiativeOn: "", note: "" };

export type ScopeAssessmentProblem =
  | { reason: "empty" }
  | { reason: "levelWhole" }
  | { reason: "levelRange"; max: number }
  | { reason: "initiativeNeedsDay" }
  | { reason: "dayNeedsInitiative" }
  | { reason: "dayInvalid" }
  | { reason: "dayInFuture" }
  | { reason: "noteLong"; max: number };

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A day that exists, not merely one shaped right (2027-02-30 is not): the round trip is the check, as the gateway's. */
export function isIsoDay(value: string): boolean {
  if (!ISO_DAY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * The school's own day (yyyy-mm-dd) at an instant, in its own time zone, as the gateway reads it (todayInZone): a rektor at half past
 * midnight on the 2nd in Sweden is on the 2nd, whatever UTC says. A zone Intl does not know is the UTC day.
 */
export function schoolToday(timeZone: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** The draft a stored assessment opens as: the level in whole hours, the day as written, the note as it is. */
export function scopeToDraft(stored: ScopeAssessmentShape | null | undefined): ScopeAssessmentDraft {
  if (!stored) return EMPTY_SCOPE_DRAFT;
  const level = stored.levelHours ?? stored.teachingLevelHours ?? null;
  return {
    level: level === null ? "" : String(level),
    exceptionKind: stored.exceptionKind ?? "",
    ownInitiativeOn: stored.ownInitiativeOn ?? "",
    note: stored.note ?? "",
  };
}

/**
 * The first thing wrong with the draft, or null. In the order a person would fix them. `today` is the school's day (schoolToday): the day of
 * an own initiative is the day it was taken, and one after today has not come (the gateway says the same, scopeDayInFuture). Without it
 * the day is held to nothing but being a day, as before.
 */
export function validateScopeDraft(draft: ScopeAssessmentDraft, today?: string): ScopeAssessmentProblem | null {
  const level = draft.level.trim();
  if (level === "" && draft.exceptionKind === "") return { reason: "empty" };
  if (level !== "") {
    if (!/^\d+$/.test(level)) return { reason: "levelWhole" };
    const hours = Number(level);
    if (hours < 1 || hours > SCOPE_LEVEL_MAX) return { reason: "levelRange", max: SCOPE_LEVEL_MAX };
  }
  const day = draft.ownInitiativeOn.trim();
  if (draft.exceptionKind === "OWN_INITIATIVE" && day === "") return { reason: "initiativeNeedsDay" };
  if (draft.exceptionKind !== "OWN_INITIATIVE" && day !== "") return { reason: "dayNeedsInitiative" };
  if (day !== "" && !isIsoDay(day)) return { reason: "dayInvalid" };
  if (day !== "" && today !== undefined && day > today) return { reason: "dayInFuture" };
  if (draft.note.trim().length > SCOPE_NOTE_MAX) return { reason: "noteLong", max: SCOPE_NOTE_MAX };
  return null;
}

/** The PUT body: the whole row, with what is left empty as null (the gateway replaces the row, so absent would mean the same). */
export function scopeDraftToBody(draft: ScopeAssessmentDraft): {
  teachingLevelHours: number | null;
  exceptionKind: ScopeExceptionKind | null;
  ownInitiativeOn: string | null;
  note: string | null;
} {
  const level = draft.level.trim();
  const day = draft.ownInitiativeOn.trim();
  const note = draft.note.trim();
  return {
    teachingLevelHours: level === "" ? null : Number(level),
    exceptionKind: draft.exceptionKind === "" ? null : draft.exceptionKind,
    ownInitiativeOn: draft.exceptionKind === "OWN_INITIATIVE" && day !== "" ? day : null,
    note: note === "" ? null : note,
  };
}
