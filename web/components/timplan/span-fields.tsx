"use client";

import { useTranslations } from "next-intl";
import type { GradeSpan } from "@/lib/timplan-coverage";
import { FormField } from "@/components/ui/form-field";
import { NativeSelect } from "@/components/ui/native-select";

export interface SpanFieldsProps {
  /** Prefix of the two selects' ids, unique on the page. */
  id: string;
  /** The årskurser the form has, in the lydelse's numbering (spanGradeOptions). */
  grades: number[];
  /** Null is the whole school form. */
  value: GradeSpan | null;
  onChange: (span: GradeSpan | null) => void;
  /**
   * False where "Hela skolformen" is not a span to give: a decided plan takes a
   * span once, from none, and its first select then offers "Välj årskurs" until
   * one is chosen.
   */
  allowWhole?: boolean;
  /** The hint under the two selects. */
  hint?: React.ReactNode;
}

/**
 * Från årskurs / Till årskurs, and "Hela skolformen" as the first option of the
 * first. The pair is always whole and in order — choosing a start sets the end
 * to the form's last årskurs when there is none, and an end before the start
 * (or a start past the end) moves the other — so there is no half or inverted
 * span for the gateway's 400 to name: "Hela skolformen" is the only way to have
 * neither.
 */
export function SpanFields({ id, grades, value, onChange, allowWhole = true, hint }: SpanFieldsProps) {
  const t = useTranslations("timplan");
  const last = grades[grades.length - 1]!;
  const grade = (value: number) => t("yearTimplans.grade", { grade: value });

  const setFrom = (text: string) => {
    if (text === "") return onChange(null);
    const from = Number(text);
    onChange({ gradeFrom: from, gradeTo: value ? Math.max(value.gradeTo, from) : last });
  };
  const setTo = (text: string) => {
    if (value === null) return;
    const to = Number(text);
    onChange({ gradeFrom: Math.min(value.gradeFrom, to), gradeTo: to });
  };

  return (
    <div className="space-y-1.5">
      <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
        <FormField id={`${id}-from`} label={t("spanFromLabel")}>
          <NativeSelect value={value?.gradeFrom ?? ""} onChange={(event) => setFrom(event.target.value)}>
            {allowWhole ? (
              <option value="">{t("spanWholeForm")}</option>
            ) : value === null ? (
              <option value="">{t("spanChoose")}</option>
            ) : null}
            {grades.map((entry) => (
              <option key={entry} value={entry}>
                {grade(entry)}
              </option>
            ))}
          </NativeSelect>
        </FormField>
        <FormField id={`${id}-to`} label={t("spanToLabel")}>
          <NativeSelect
            value={value?.gradeTo ?? ""}
            disabled={value === null}
            onChange={(event) => setTo(event.target.value)}
          >
            {value === null ? <option value="" /> : null}
            {grades.map((entry) => (
              <option key={entry} value={entry}>
                {grade(entry)}
              </option>
            ))}
          </NativeSelect>
        </FormField>
      </div>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
