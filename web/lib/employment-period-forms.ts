import { postStretches } from "@/lib/employment-periods";
import {
  EMPTY_EMPLOYMENT_DRAFT,
  PERCENT_DECIMALS,
  parseDecimal,
  validateEmploymentDraft,
  wholeNumber,
  type EmploymentProblem,
} from "@/lib/staffing-forms";
import type { TeacherEmploymentPeriod } from "@/lib/types";

/*
 * A period of a post, as the Anställning card's form edits it (migration
 * 20261022120000): "80 % från 1 november".
 *
 * MIRRORS UpsertTeacherEmploymentPeriodDto and the service's three rules that
 * need another row — inside the läsår, at least one whole week, no overlap
 * with another period of the post — so the sentence lands beside the field
 * before Spara, as the post's own form does. The gateway refuses the same
 * things in the same words; this is where they are said, not where they hold.
 */

export interface PeriodDraft {
  /** Från as `<input type="date">` writes it; required. */
  validFrom: string;
  /** Till; "" for the läsår's last day. */
  validTo: string;
  employmentPercent: string;
  reductionPercent: string;
  /** "" derives from the policy; a number is the period's own riktmärke. */
  teachingTargetMinutesPerWeek: string;
}

export const EMPTY_PERIOD_DRAFT: PeriodDraft = {
  validFrom: "",
  validTo: "",
  employmentPercent: "",
  reductionPercent: "",
  teachingTargetMinutesPerWeek: "",
};

/** The body POST /teacher-employments/:userId/periods and PUT …/periods/:id take. */
export interface EmploymentPeriodBody {
  validFrom: string;
  validTo: string | null;
  employmentPercent: number;
  reductionPercent: number;
  teachingTargetMinutesPerWeek: number | null;
}

export type PeriodProblem =
  | { reason: "periodFromRequired" }
  | { reason: "periodOutsideYear"; date: string; start: string; end: string }
  | { reason: "periodDatesReversed"; from: string; to: string }
  | { reason: "periodHoldsNoWeek"; from: string; to: string }
  | { reason: "periodOverlaps"; from: string; to: string }
  | EmploymentProblem;

export function periodToDraft(period: TeacherEmploymentPeriod): PeriodDraft {
  return {
    validFrom: period.validFrom,
    validTo: period.validTo ?? "",
    employmentPercent: String(period.employmentPercent),
    reductionPercent: period.reductionPercent > 0 ? String(period.reductionPercent) : "",
    teachingTargetMinutesPerWeek:
      period.teachingTargetMinutesPerWeek === null ? "" : String(period.teachingTargetMinutesPerWeek),
  };
}

/** The body for a draft validatePeriodDraft has passed. */
export function periodDraftToBody(draft: PeriodDraft): EmploymentPeriodBody {
  const reduction = draft.reductionPercent.trim() === "" ? 0 : parseDecimal(draft.reductionPercent, PERCENT_DECIMALS)!;
  return {
    validFrom: draft.validFrom,
    validTo: draft.validTo === "" ? null : draft.validTo,
    employmentPercent: parseDecimal(draft.employmentPercent, PERCENT_DECIMALS)!,
    reductionPercent: reduction,
    teachingTargetMinutesPerWeek:
      draft.teachingTargetMinutesPerWeek.trim() === "" ? null : wholeNumber(draft.teachingTargetMinutesPerWeek),
  };
}

/** The year's day, whether it came as a date or a timestamp. */
const dayOf = (value: string): string => value.slice(0, 10);

/**
 * The first reason the draft cannot be saved, or null. `others` are the
 * post's other periods (the one being edited left out by `selfId`); `year`
 * the läsår's bounds, or null while they have not loaded — then the date
 * rules wait for the save, where the gateway asks them.
 */
export function validatePeriodDraft(
  draft: PeriodDraft,
  year: { startDate: string; endDate: string } | null,
  others: readonly TeacherEmploymentPeriod[],
  selfId: string | null = null,
): PeriodProblem | null {
  if (draft.validFrom === "") return { reason: "periodFromRequired" };
  const from = draft.validFrom;
  const to = draft.validTo === "" ? null : draft.validTo;
  if (to !== null && to < from) return { reason: "periodDatesReversed", from, to };

  const figures = validateEmploymentDraft({
    ...EMPTY_EMPLOYMENT_DRAFT,
    employmentPercent: draft.employmentPercent,
    reductionPercent: draft.reductionPercent,
    teachingTargetMinutesPerWeek: draft.teachingTargetMinutesPerWeek,
  });
  if (figures) return figures;

  if (year) {
    const start = dayOf(year.startDate);
    const end = dayOf(year.endDate);
    for (const date of [from, to]) {
      if (date !== null && (date < start || date > end)) return { reason: "periodOutsideYear", date, start, end };
    }
    const body = periodDraftToBody(draft);
    const [alone] = postStretches(
      {
        employmentPercent: body.employmentPercent,
        reductionPercent: body.reductionPercent,
        teachingTargetMinutesPerWeek: body.teachingTargetMinutesPerWeek,
        periods: [body],
      },
      { startDate: start, endDate: end },
    ).filter((stretch) => stretch.kind === "PERIOD");
    if (!alone?.window) return { reason: "periodHoldsNoWeek", from, to: to ?? end };
    const overlapping = others.find(
      (other) =>
        other.id !== selfId &&
        other.validFrom <= (to ?? end) &&
        (other.validTo === null || other.validTo >= from),
    );
    if (overlapping) {
      return { reason: "periodOverlaps", from: overlapping.validFrom, to: overlapping.validTo ?? end };
    }
  }
  return null;
}
