"use client";

import { useTranslations } from "next-intl";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** Förskoleklass through gymnasiets third year — the Swedish span. */
const GRADES = Array.from({ length: 13 }, (_, grade) => grade);
/** A Select cannot hold null, so "every year" needs a stand-in. */
export const EVERY_GRADE = "all";

interface GradeSpanFieldCommonProps {
  label: string;
  /**
   * Accessible names for the two selects, where they are not the visible label.
   *
   * The label names the PAIR; a screen reader lands on one select at a time,
   * and two controls announced identically are two controls the listener
   * cannot tell apart. Each page keeps the names it already had — they are
   * words the school reads, not an implementation detail worth unifying.
   */
  fromLabel?: string;
  toLabel?: string;
  hint?: string;
  /**
   * The hint's classes, for a page that has decided its small print differently.
   * admin/breaks holds all of its to 7:1 rather than the muted default.
   */
  hintClassName?: string;
}

/**
 * Where a span is optional: both bounds null is "every year", and the field
 * offers that as a choice.
 */
interface OptionalSpanProps extends GradeSpanFieldCommonProps {
  allowAll: true;
  min: number | null;
  max: number | null;
  onChange: (span: { min: number | null; max: number | null }) => void;
}

/**
 * Where a span is REQUIRED — ramtider, lunchpass, raster and a GRADE_LEVEL-rule,
 * all of which the API refuses without one. Stated in the types rather than
 * left to each page to remember, so a null cannot reach a form that has nowhere
 * to put it.
 */
interface RequiredSpanProps extends GradeSpanFieldCommonProps {
  allowAll?: false;
  min: number;
  max: number;
  onChange: (span: { min: number; max: number }) => void;
}

type GradeSpanFieldProps = OptionalSpanProps | RequiredSpanProps;

/**
 * A pair of year selects that cannot be put in the wrong order.
 *
 * The pair is corrected AS THE ADMIN TYPES rather than refused afterwards: a
 * span that reads backwards was never what anybody meant, and a save button
 * that greys out with no explanation is worse than a value that follows.
 *
 * Extracted because this exact control, with its own copy of GRADES, had been
 * written four times — on frame-times, constraints, lunch-servings and breaks —
 * and a fifth copy for room rules would have been the one that drifted. The
 * four existing ones are untouched here; moving them is its own change.
 */
export function GradeSpanField(props: GradeSpanFieldProps) {
  const { label, fromLabel, toLabel, hint, hintClassName, min, max } = props;
  const allowAll = props.allowAll ?? false;
  const t = useTranslations("constraints");
  const tGrades = useTranslations("grades");
  /*
   * One implementation behind both shapes. The union above is what keeps a page
   * that requires a span from being handed a null, so the widened callback here
   * is only ever reached through the branch that permits one.
   */
  const emit = props.onChange as (span: {
    min: number | null;
    max: number | null;
  }) => void;
  const value = (bound: number | null) =>
    bound === null ? EVERY_GRADE : String(bound);

  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="flex items-center gap-2">
        <Select
          value={value(min)}
          onValueChange={(next) => {
            if (next === EVERY_GRADE) return emit({ min: null, max: null });
            const low = Number(next);
            // Both bounds or neither, and ordered — the same rule the database
            // enforces, applied here so it never becomes a 400 to decode.
            emit({ min: low, max: max === null || max < low ? low : max });
          }}
        >
          <SelectTrigger aria-label={fromLabel ?? label}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {allowAll ? (
              <SelectItem value={EVERY_GRADE}>{t("ruleAllGrades")}</SelectItem>
            ) : null}
            {GRADES.map((grade) => (
              <SelectItem key={grade} value={String(grade)}>
                {tGrades("grade", { grade })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span aria-hidden="true">–</span>
        <Select
          value={value(max)}
          disabled={min === null}
          onValueChange={(next) => {
            const high = Number(next);
            emit({ min: min === null || min > high ? high : min, max: high });
          }}
        >
          <SelectTrigger aria-label={toLabel ?? `${label} – ${t("ruleGrades")}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {GRADES.map((grade) => (
              <SelectItem key={grade} value={String(grade)}>
                {tGrades("grade", { grade })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {hint ? (
        <p className={hintClassName ?? "text-xs text-muted-foreground"}>{hint}</p>
      ) : null}
    </div>
  );
}
