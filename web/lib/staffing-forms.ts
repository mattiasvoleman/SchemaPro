import type {
  StaffingCheckMode,
  StaffingLoadModel,
  TeacherContractKind,
  TeacherEmployment,
  TeacherQualification,
  TeacherQualificationKind,
  UnstaffedGenerationMode,
} from "@/lib/types";

/*
 * The staffing forms' drafts, their bounds, and what they send.
 *
 * MIRRORS THE DTOs in src/staffing/dto, deliberately and field for field:
 * UpsertTeacherEmploymentDto, TeacherQualificationItemDto and
 * UpsertStaffingPolicyDto. The gateway refuses an out-of-range value with a
 * Swedish sentence already, so the point of repeating the rules here is not the
 * refusal but WHERE it lands: a 400 arrives as one toast for the whole form,
 * and the person typing a nedsättning of 90 into an 80 % post needs the
 * sentence next to the two fields it is about, before the save button is
 * pressed. Every reason below is a message key under the `staffing`
 * namespace with its ICU arguments beside it, the shape lib/teacher-work-rules
 * uses, so the cards render a refusal without a switch of their own.
 *
 * DRAFTS ARE STRINGS. "" is the only way a controlled `<input type="number">`
 * can hold "nothing said"; a number-typed state has to pick 0 or NaN for the
 * empty case, and 0 is exactly the value a riktmärke override must never
 * carry by accident — it means "this post teaches nothing" to the report.
 */

// ---------------------------------------------------------------------------
// Anställning
// ---------------------------------------------------------------------------

export const PERCENT_DECIMALS = 3;
export const TARGET_MINUTES_MAX = 2400;
export const SIGNATURE_MAX = 8;
export const NOTE_MAX = 500;

export interface EmploymentDraft {
  employmentPercent: string;
  reductionPercent: string;
  contractKind: TeacherContractKind;
  /** "" derives from the policy; a number is the teacher's own riktmärke. */
  teachingTargetMinutesPerWeek: string;
  signature: string;
  note: string;
}

export const EMPTY_EMPLOYMENT_DRAFT: EmploymentDraft = {
  employmentPercent: "",
  reductionPercent: "",
  contractKind: "FERIE",
  teachingTargetMinutesPerWeek: "",
  signature: "",
  note: "",
};

/** The body PUT /teacher-employments/:userId takes. Every key always present. */
export interface EmploymentBody {
  employmentPercent: number;
  reductionPercent: number;
  contractKind: TeacherContractKind;
  teachingTargetMinutesPerWeek: number | null;
  signature: string | null;
  note: string | null;
}

export type EmploymentProblem =
  | { reason: "percentRequired" }
  | { reason: "percentOutOfRange"; decimals: number }
  | { reason: "reductionOutOfRange"; decimals: number }
  | { reason: "reductionAbovePercent"; reduction: number; percent: number }
  | { reason: "targetOutOfRange"; max: number }
  | { reason: "signatureTooLong"; max: number }
  | { reason: "noteTooLong"; max: number };

/**
 * A number with at most `decimals` decimals, or null for anything else.
 *
 * A decimal COMMA is accepted and read as a point. The form is Swedish and
 * 66,667 is how a two-thirds post is written on every payslip; refusing it
 * would make the field disagree with the number the admin is copying from.
 * Exported for the CSV mapper, which reads the same cells from a spreadsheet.
 */
export function parseDecimal(value: string, decimals: number): number | null {
  const trimmed = value.trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [, fraction = ""] = trimmed.split(".");
  if (fraction.length > decimals) return null;
  return Number(trimmed);
}

/** Digits only, as a number; null for anything else. Exported for duty-forms. */
export function wholeNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

/**
 * The first reason the draft cannot be saved, or null when it can.
 *
 * Ordered so the sentence is about the thing the reader got wrong: the
 * percentage before the nedsättning that is compared against it, both before
 * the override, the two strings last.
 */
export function validateEmploymentDraft(draft: EmploymentDraft): EmploymentProblem | null {
  if (draft.employmentPercent.trim() === "") return { reason: "percentRequired" };
  const percent = parseDecimal(draft.employmentPercent, PERCENT_DECIMALS);
  if (percent === null || percent <= 0 || percent > 100) {
    return { reason: "percentOutOfRange", decimals: PERCENT_DECIMALS };
  }

  const reduction =
    draft.reductionPercent.trim() === ""
      ? 0
      : parseDecimal(draft.reductionPercent, PERCENT_DECIMALS);
  if (reduction === null || reduction < 0 || reduction > 100) {
    return { reason: "reductionOutOfRange", decimals: PERCENT_DECIMALS };
  }
  if (reduction > percent) {
    return { reason: "reductionAbovePercent", reduction, percent };
  }

  if (draft.teachingTargetMinutesPerWeek.trim() !== "") {
    const target = wholeNumber(draft.teachingTargetMinutesPerWeek);
    if (target === null || target > TARGET_MINUTES_MAX) {
      return { reason: "targetOutOfRange", max: TARGET_MINUTES_MAX };
    }
  }

  if (draft.signature.trim().length > SIGNATURE_MAX) {
    return { reason: "signatureTooLong", max: SIGNATURE_MAX };
  }
  if (draft.note.trim().length > NOTE_MAX) {
    return { reason: "noteTooLong", max: NOTE_MAX };
  }
  return null;
}

/**
 * The draft as the gateway takes it. Only a draft that has passed
 * validateEmploymentDraft should be sent; the whole row is replaced on every
 * PUT, so every key is present — an omitted note would be a cleared note.
 */
export function employmentDraftToBody(draft: EmploymentDraft): EmploymentBody {
  const signature = draft.signature.trim();
  const note = draft.note.trim();
  return {
    employmentPercent: parseDecimal(draft.employmentPercent, PERCENT_DECIMALS) ?? 0,
    reductionPercent:
      draft.reductionPercent.trim() === ""
        ? 0
        : (parseDecimal(draft.reductionPercent, PERCENT_DECIMALS) ?? 0),
    contractKind: draft.contractKind,
    teachingTargetMinutesPerWeek:
      draft.teachingTargetMinutesPerWeek.trim() === ""
        ? null
        : wholeNumber(draft.teachingTargetMinutesPerWeek),
    signature: signature === "" ? null : signature,
    note: note === "" ? null : note,
  };
}

/** A stored row as the form holds it, or the empty draft for a teacher without one. */
export function employmentToDraft(row: TeacherEmployment | null | undefined): EmploymentDraft {
  if (!row) return EMPTY_EMPLOYMENT_DRAFT;
  return {
    employmentPercent: String(row.employmentPercent),
    reductionPercent: row.reductionPercent === 0 ? "" : String(row.reductionPercent),
    contractKind: row.contractKind,
    teachingTargetMinutesPerWeek:
      row.teachingTargetMinutesPerWeek === null ? "" : String(row.teachingTargetMinutesPerWeek),
    signature: row.signature ?? "",
    note: row.note ?? "",
  };
}

// ---------------------------------------------------------------------------
// Behörigheter
// ---------------------------------------------------------------------------

export const GRADE_MIN = 0;
export const GRADE_MAX = 12;
export const QUALIFICATIONS_MAX = 100;
export const QUALIFICATION_KINDS: TeacherQualificationKind[] = [
  "LEGITIMATION",
  "BEHORIG",
  "TILLATEN",
];

export interface QualificationDraftRow {
  /** A client-side key for React; never sent. */
  key: string;
  subjectId: string;
  minGradeLevel: number;
  maxGradeLevel: number;
  kind: TeacherQualificationKind;
  /** yyyy-mm-dd or "". */
  validFrom: string;
  validTo: string;
  note: string;
}

/** One item of PUT /teacher-qualifications/:userId. */
export interface QualificationItemBody {
  subjectId: string;
  minGradeLevel: number;
  maxGradeLevel: number;
  kind: TeacherQualificationKind;
  validFrom: string | null;
  validTo: string | null;
  note: string | null;
}

export type QualificationProblem =
  | { reason: "subjectRequired"; row: number }
  | { reason: "spanReversed"; row: number; min: number; max: number }
  | { reason: "validityReversed"; row: number }
  | { reason: "duplicateSubject"; row: number; first: number }
  | { reason: "tooManyRows"; max: number };

let keySeq = 0;
/** A fresh row for the "lägg till" button: åk 7–9, kind unstated until picked. */
export function newQualificationRow(
  subjectId = "",
  kind: TeacherQualificationKind = "LEGITIMATION",
): QualificationDraftRow {
  keySeq += 1;
  return {
    key: `new-${keySeq}`,
    subjectId,
    minGradeLevel: 7,
    maxGradeLevel: 9,
    kind,
    validFrom: "",
    validTo: "",
    note: "",
  };
}

export function qualificationsToDraft(rows: TeacherQualification[]): QualificationDraftRow[] {
  return rows.map((row) => ({
    key: row.id,
    subjectId: row.subjectId,
    minGradeLevel: row.minGradeLevel,
    maxGradeLevel: row.maxGradeLevel,
    kind: row.kind,
    validFrom: row.validFrom ?? "",
    validTo: row.validTo ?? "",
    note: row.note ?? "",
  }));
}

/**
 * The first reason the list cannot be saved, or null. Row numbers are
 * 1-based, as the gateway's own "Rad N" messages are.
 */
export function validateQualificationRows(
  rows: QualificationDraftRow[],
): QualificationProblem | null {
  if (rows.length > QUALIFICATIONS_MAX) {
    return { reason: "tooManyRows", max: QUALIFICATIONS_MAX };
  }
  const firstRowOf = new Map<string, number>();
  for (const [index, row] of rows.entries()) {
    const number = index + 1;
    if (row.subjectId === "") return { reason: "subjectRequired", row: number };
    if (row.maxGradeLevel < row.minGradeLevel) {
      return {
        reason: "spanReversed",
        row: number,
        min: row.minGradeLevel,
        max: row.maxGradeLevel,
      };
    }
    if (row.validFrom !== "" && row.validTo !== "" && row.validTo < row.validFrom) {
      return { reason: "validityReversed", row: number };
    }
    const first = firstRowOf.get(row.subjectId);
    if (first !== undefined) return { reason: "duplicateSubject", row: number, first };
    firstRowOf.set(row.subjectId, number);
  }
  return null;
}

export function qualificationRowsToBody(rows: QualificationDraftRow[]): QualificationItemBody[] {
  return rows.map((row) => ({
    subjectId: row.subjectId,
    minGradeLevel: row.minGradeLevel,
    maxGradeLevel: row.maxGradeLevel,
    kind: row.kind,
    validFrom: row.validFrom === "" ? null : row.validFrom,
    validTo: row.validTo === "" ? null : row.validTo,
    note: row.note.trim() === "" ? null : row.note.trim(),
  }));
}

/**
 * How a validTo reads today: expired, expiring within `warnDays`, or fine.
 * `today` is yyyy-mm-dd and passed in, so the card is testable on a fixed day
 * and the two strings compare as dates.
 */
export function validityState(
  validTo: string | null,
  today: string,
  warnDays = 90,
): "EXPIRED" | "EXPIRING" | "VALID" {
  if (validTo === null) return "VALID";
  if (validTo < today) return "EXPIRED";
  const limit = new Date(`${today}T00:00:00`);
  limit.setDate(limit.getDate() + warnDays);
  const y = limit.getFullYear();
  const m = String(limit.getMonth() + 1).padStart(2, "0");
  const d = String(limit.getDate()).padStart(2, "0");
  return validTo <= `${y}-${m}-${d}` ? "EXPIRING" : "VALID";
}

// ---------------------------------------------------------------------------
// Inställningar (StaffingPolicy)
// ---------------------------------------------------------------------------

/** Vimmerby's riktmärke, offered by a button and never written by default. */
export const SUGGESTED_FULL_TIME_MINUTES = 1080;
export const CHECK_MODES: StaffingCheckMode[] = ["OFF", "WARN", "REFUSE"];
export const LOAD_MODELS: StaffingLoadModel[] = ["MINUTES", "FACTOR"];
export const GENERATION_MODES: UnstaffedGenerationMode[] = ["ALLOW", "REFUSE"];

export interface PolicyDraft {
  /** "" means no riktmärke — every teacher NO_TARGET. */
  fullTimeTeachingMinutesPerWeek: string;
  fullTimeRegulatedHoursPerYear: string;
  fullTimeAnnualHours: string;
  workDaysPerYear: string;
  semesterHoursPerWeek: string;
  qualificationMode: StaffingCheckMode;
  overAllocationMode: StaffingCheckMode;
  overAllocationTolerancePercent: string;
  loadModel: StaffingLoadModel;
  unstaffedGeneration: UnstaffedGenerationMode;
  /** Dela tjänstgöringsgrad med integrationer (SS12000 /duties). */
  shareEmploymentWithIntegrations: boolean;
}

/** The table's defaults, as STAFFING_POLICY_DEFAULTS states them on the gateway. */
export const DEFAULT_POLICY_DRAFT: PolicyDraft = {
  fullTimeTeachingMinutesPerWeek: "",
  fullTimeRegulatedHoursPerYear: "1360",
  fullTimeAnnualHours: "1767",
  workDaysPerYear: "194",
  semesterHoursPerWeek: "40",
  qualificationMode: "WARN",
  overAllocationMode: "WARN",
  overAllocationTolerancePercent: "10",
  loadModel: "MINUTES",
  unstaffedGeneration: "ALLOW",
  shareEmploymentWithIntegrations: false,
};

export interface PolicyBody {
  fullTimeTeachingMinutesPerWeek: number | null;
  fullTimeRegulatedHoursPerYear: number;
  fullTimeAnnualHours: number;
  workDaysPerYear: number;
  semesterHoursPerWeek: number;
  qualificationMode: StaffingCheckMode;
  overAllocationMode: StaffingCheckMode;
  overAllocationTolerancePercent: number;
  loadModel: StaffingLoadModel;
  /**
   * Always sent: PUT replaces the row, and an omitted field is the default
   * ALLOW — a card that forgot it would switch a school's refusal off.
   */
  unstaffedGeneration: UnstaffedGenerationMode;
  /**
   * Always sent, for unstaffedGeneration's reason: an omitted field is the
   * default false, so a card that forgot it would stop sharing on every save.
   */
  shareEmploymentWithIntegrations: boolean;
}

export type PolicyProblem =
  | { reason: "riktmarkeOutOfRange"; max: number }
  | { reason: "regulatedOutOfRange"; max: number }
  | { reason: "annualOutOfRange"; max: number }
  | { reason: "regulatedAboveAnnual"; regulated: number; annual: number }
  | { reason: "workDaysOutOfRange"; max: number }
  | { reason: "semesterHoursOutOfRange"; max: number }
  | { reason: "toleranceOutOfRange"; max: number };

export function validatePolicyDraft(draft: PolicyDraft): PolicyProblem | null {
  if (draft.fullTimeTeachingMinutesPerWeek.trim() !== "") {
    const minutes = wholeNumber(draft.fullTimeTeachingMinutesPerWeek);
    if (minutes === null || minutes < 1 || minutes > TARGET_MINUTES_MAX) {
      return { reason: "riktmarkeOutOfRange", max: TARGET_MINUTES_MAX };
    }
  }
  const regulated = wholeNumber(draft.fullTimeRegulatedHoursPerYear);
  if (regulated === null || regulated < 1 || regulated > 2500) {
    return { reason: "regulatedOutOfRange", max: 2500 };
  }
  const annual = wholeNumber(draft.fullTimeAnnualHours);
  if (annual === null || annual < 1 || annual > 2500) {
    return { reason: "annualOutOfRange", max: 2500 };
  }
  // The service's one cross-field rule, said here so it lands on the pair.
  if (regulated > annual) return { reason: "regulatedAboveAnnual", regulated, annual };
  const days = wholeNumber(draft.workDaysPerYear);
  if (days === null || days < 1 || days > 260) {
    return { reason: "workDaysOutOfRange", max: 260 };
  }
  const semester = parseDecimal(draft.semesterHoursPerWeek, 1);
  if (semester === null || semester <= 0 || semester > 60) {
    return { reason: "semesterHoursOutOfRange", max: 60 };
  }
  const tolerance = wholeNumber(draft.overAllocationTolerancePercent);
  if (tolerance === null || tolerance > 50) {
    return { reason: "toleranceOutOfRange", max: 50 };
  }
  return null;
}

export function policyDraftToBody(draft: PolicyDraft): PolicyBody {
  return {
    fullTimeTeachingMinutesPerWeek:
      draft.fullTimeTeachingMinutesPerWeek.trim() === ""
        ? null
        : wholeNumber(draft.fullTimeTeachingMinutesPerWeek),
    fullTimeRegulatedHoursPerYear: wholeNumber(draft.fullTimeRegulatedHoursPerYear) ?? 0,
    fullTimeAnnualHours: wholeNumber(draft.fullTimeAnnualHours) ?? 0,
    workDaysPerYear: wholeNumber(draft.workDaysPerYear) ?? 0,
    semesterHoursPerWeek: parseDecimal(draft.semesterHoursPerWeek, 1) ?? 0,
    qualificationMode: draft.qualificationMode,
    overAllocationMode: draft.overAllocationMode,
    overAllocationTolerancePercent: wholeNumber(draft.overAllocationTolerancePercent) ?? 0,
    loadModel: draft.loadModel,
    unstaffedGeneration: draft.unstaffedGeneration,
    shareEmploymentWithIntegrations: draft.shareEmploymentWithIntegrations,
  };
}

export function policyToDraft(row: {
  fullTimeTeachingMinutesPerWeek: number | null;
  fullTimeRegulatedHoursPerYear: number;
  fullTimeAnnualHours: number;
  workDaysPerYear: number;
  semesterHoursPerWeek: number;
  qualificationMode: StaffingCheckMode;
  overAllocationMode: StaffingCheckMode;
  overAllocationTolerancePercent: number;
  loadModel: StaffingLoadModel;
  unstaffedGeneration?: UnstaffedGenerationMode;
  shareEmploymentWithIntegrations?: boolean;
} | null | undefined): PolicyDraft {
  if (!row) return DEFAULT_POLICY_DRAFT;
  return {
    fullTimeTeachingMinutesPerWeek:
      row.fullTimeTeachingMinutesPerWeek === null
        ? ""
        : String(row.fullTimeTeachingMinutesPerWeek),
    fullTimeRegulatedHoursPerYear: String(row.fullTimeRegulatedHoursPerYear),
    fullTimeAnnualHours: String(row.fullTimeAnnualHours),
    workDaysPerYear: String(row.workDaysPerYear),
    semesterHoursPerWeek: String(row.semesterHoursPerWeek),
    qualificationMode: row.qualificationMode,
    overAllocationMode: row.overAllocationMode,
    overAllocationTolerancePercent: String(row.overAllocationTolerancePercent),
    loadModel: row.loadModel,
    // A row read from a gateway older than the column reads as today's rule.
    unstaffedGeneration: row.unstaffedGeneration ?? "ALLOW",
    // Likewise: a gateway older than staffing Fas 3 shares nothing.
    shareEmploymentWithIntegrations: row.shareEmploymentWithIntegrations ?? false,
  };
}
