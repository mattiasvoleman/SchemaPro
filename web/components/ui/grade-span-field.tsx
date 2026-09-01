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

interface GradeSpanFieldProps {
  label: string;
  /** null on either bound means every year. */
  min: number | null;
  max: number | null;
  onChange: (span: { min: number | null; max: number | null }) => void;
  /** Adds an "every year" choice. Omit where a span is required. */
  allowAll?: boolean;
  hint?: string;
}

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
export function GradeSpanField({
  label,
  min,
  max,
  onChange,
  allowAll = false,
  hint,
}: GradeSpanFieldProps) {
  const t = useTranslations("constraints");
  const tGrades = useTranslations("grades");
  const value = (bound: number | null) =>
    bound === null ? EVERY_GRADE : String(bound);

  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="flex items-center gap-2">
        <Select
          value={value(min)}
          onValueChange={(next) => {
            if (next === EVERY_GRADE) return onChange({ min: null, max: null });
            const low = Number(next);
            // Both bounds or neither, and ordered — the same rule the database
            // enforces, applied here so it never becomes a 400 to decode.
            onChange({ min: low, max: max === null || max < low ? low : max });
          }}
        >
          <SelectTrigger aria-label={label}>
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
            onChange({ min: min === null || min > high ? high : min, max: high });
          }}
        >
          <SelectTrigger aria-label={`${label} – ${t("ruleGrades")}`}>
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
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
