import type { BatchCause, BatchScope, CancellationInput, CancellationSelection } from "@/lib/publication-types";

/*
 * The bulk avbokning form and what it sends (POST /cancellation-batches[/preview]).
 *
 * The rules are the gateway's (CancellationSelectionDto and the CHECKs on
 * CancellationBatches, migration 20261011110000), said here first so the
 * admin reads them beside the field rather than as a 400:
 *
 *   - a name, 1–120 characters ("Prao åk 9");
 *   - a range inside the läsår of at most 31 days, both ends counted;
 *   - a time window with both ends, start before end — or none (whole days);
 *   - SCHOOL with nothing else, GRADES with a span, GROUPS with 1–200 groups;
 *   - a credit (the day counts as undervisningstid, P3's TimplanCredits) only
 *     for whole days — a partly held day credited in full would count the
 *     morning twice — and only for days after today, which the gateway
 *     decides on the school's clock and the preview lists (creditDates).
 */

export interface CancellationForm {
  name: string;
  cause: BatchCause;
  fromDate: string;
  toDate: string;
  /** "" = whole days. */
  startTime: string;
  endTime: string;
  scope: BatchScope;
  minGradeLevel: number;
  maxGradeLevel: number;
  groupIds: string[];
  credit: boolean;
  /** As typed; validated as 1–600. */
  creditMinutes: string;
  /** null = no subject: undervisningstid without one. */
  creditSubjectId: string | null;
}

export const EMPTY_CANCELLATION_FORM: CancellationForm = {
  name: "",
  cause: "EVENT",
  fromDate: "",
  toDate: "",
  startTime: "",
  endTime: "",
  scope: "GRADES",
  minGradeLevel: 9,
  maxGradeLevel: 9,
  groupIds: [],
  credit: false,
  creditMinutes: "",
  creditSubjectId: null,
};

export const MAX_DAYS = 31;

/** Days from one date to another, both counted: the same day is 1. */
export function inclusiveDays(fromDate: string, toDate: string): number {
  return Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000) + 1;
}

export type FormProblem =
  | "name"
  | "dates"
  | "order"
  | "outsideYear"
  | "tooLong"
  | "time"
  | "grades"
  | "groups"
  | "creditPartialDay"
  | "creditMinutes";

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** What the gateway would refuse, as keys the page words; empty = sendable. */
export function formProblems(form: CancellationForm, year: { startDate: string; endDate: string }): FormProblem[] {
  const problems: FormProblem[] = [];
  if (form.name.trim().length === 0 || form.name.trim().length > 120) problems.push("name");
  if (!ISO.test(form.fromDate) || !ISO.test(form.toDate)) {
    problems.push("dates");
  } else if (form.toDate < form.fromDate) {
    problems.push("order");
  } else {
    if (form.fromDate < year.startDate || form.toDate > year.endDate) problems.push("outsideYear");
    if (inclusiveDays(form.fromDate, form.toDate) > MAX_DAYS) problems.push("tooLong");
  }
  const timed = form.startTime !== "" || form.endTime !== "";
  if (timed && (!CLOCK.test(form.startTime) || !CLOCK.test(form.endTime) || form.startTime >= form.endTime)) {
    problems.push("time");
  }
  if (form.scope === "GRADES" && form.minGradeLevel > form.maxGradeLevel) problems.push("grades");
  if (form.scope === "GROUPS" && (form.groupIds.length === 0 || form.groupIds.length > 200)) problems.push("groups");
  if (form.credit) {
    if (timed) problems.push("creditPartialDay");
    const minutes = Number(form.creditMinutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 600) problems.push("creditMinutes");
  }
  return problems;
}

/** The selection the preview and the create send, with only the scope's own fields. */
export function selectionOf(form: CancellationForm, academicYearId: string): CancellationSelection {
  return {
    academicYearId,
    name: form.name.trim(),
    cause: form.cause,
    fromDate: form.fromDate,
    toDate: form.toDate,
    ...(form.startTime && form.endTime ? { startTime: form.startTime, endTime: form.endTime } : {}),
    scope: form.scope,
    ...(form.scope === "GRADES" ? { minGradeLevel: form.minGradeLevel, maxGradeLevel: form.maxGradeLevel } : {}),
    ...(form.scope === "GROUPS" ? { groupIds: [...form.groupIds].sort() } : {}),
  };
}

/** The create: the previewed selection, its digest, and the credit when asked for. */
export function createInputOf(form: CancellationForm, academicYearId: string, digest: string): CancellationInput {
  return {
    ...selectionOf(form, academicYearId),
    expectedDigest: digest,
    ...(form.credit
      ? {
          credit: {
            minutes: Number(form.creditMinutes),
            ...(form.creditSubjectId ? { subjectId: form.creditSubjectId } : {}),
          },
        }
      : {}),
  };
}

/**
 * Whether a preview still describes the form: the create carries the
 * preview's digest, and a form changed since would be refused as stale — or
 * worse, read as the admin having seen what they had not.
 */
export function sameSelection(a: CancellationSelection | null, b: CancellationSelection): boolean {
  return a !== null && JSON.stringify(a) === JSON.stringify(b);
}
