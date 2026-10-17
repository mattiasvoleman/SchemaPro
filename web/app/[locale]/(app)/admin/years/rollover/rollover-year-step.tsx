"use client";

import { useTranslations } from "next-intl";
import type { RolloverPreview } from "@/lib/types";
import type { RolloverFormState } from "@/lib/year-rollover-form";
import { DateField } from "@/components/ui/date-field";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const GRADES = Array.from({ length: 13 }, (_, grade) => grade);

/**
 * Steg 1, Nytt läsår: the name, the dates and the graduating grade.
 *
 * The dates start 52 weeks on (see defaultTarget): the planner moves every
 * period by whole weeks from the start, so a start on the same weekday keeps
 * a Monday start a Monday. The GRADUATING GRADE is offered from the newest
 * decided timplan, else the highest class; when those disagree there is no
 * default, because a grade one too low graduates a cohort into no class and
 * one too high invents a class above the school's last.
 */
export function RolloverYearStep({
  form,
  update,
  plan,
  graduatingGrade,
}: {
  form: RolloverFormState;
  update: (patch: Partial<RolloverFormState>) => void;
  plan: RolloverPreview | undefined;
  graduatingGrade: number | null;
}) {
  const t = useTranslations("years");
  const conflict = plan?.graduatingGradeConflict ?? null;
  const gradeHint =
    form.graduatingGradeLevel !== null
      ? t("gradeChosen")
      : conflict
        ? t("gradeConflict", {
            timplan: conflict.timplan.join(", ") || "—",
            classes: conflict.classes ?? "—",
          })
        : plan
          ? t(`gradeSource.${plan.graduatingGradeSource}`)
          : "";

  // Into HT 2028 (SFS 2025:729) the numbering is asked here when the source
  // year shows no school form, and stays shown once answered.
  const asksNumbering =
    plan?.reform2028 != null &&
    (form.renumber2028 !== null || plan.problems.some((problem) => problem.code === "ROLLOVER_2028_SCHOOL_FORM_UNKNOWN"));

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3 [&>*]:min-w-0">
        <FormField
          id="rollover-name"
          label={t("yearName")}
          error={form.name.trim() === "" ? t("yearNameRequired") : undefined}
        >
          <Input
            value={form.name}
            maxLength={60}
            placeholder={t("yearNamePlaceholder")}
            onChange={(event) => update({ name: event.target.value })}
          />
        </FormField>
        <FormField id="rollover-start" label={t("startDate")}>
          <DateField
            label={t("startDate")}
            value={form.startDate}
            onChange={(value) => update({ startDate: value })}
          />
        </FormField>
        <FormField id="rollover-end" label={t("endDate")}>
          <DateField
            label={t("endDate")}
            value={form.endDate}
            onChange={(value) => update({ endDate: value })}
          />
        </FormField>
      </div>
      {plan ? (
        <p className="text-sm text-muted-foreground">
          {t("shiftHint", { days: plan.target.dateShiftDays, weeks: plan.target.dateShiftDays / 7 })}
          {plan.target.crossesIsoWeek53 ? ` ${t("week53Hint")}` : ""}
        </p>
      ) : null}

      <FormField
        id="rollover-grade"
        label={t("graduatingGrade")}
        hint={gradeHint || undefined}
        className="max-w-sm"
      >
        {(control) => (
          <Select
            value={graduatingGrade === null ? "" : String(graduatingGrade)}
            onValueChange={(value) => update({ graduatingGradeLevel: Number(value) })}
          >
            <SelectTrigger {...control}>
              <SelectValue placeholder={t("graduatingGradePlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              {GRADES.map((grade) => (
                <SelectItem key={grade} value={String(grade)}>
                  {t("gradeOption", { grade })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </FormField>

      {asksNumbering ? (
        <FormField id="rollover-numbering" label={t("numbering2028")} hint={t("numbering2028Hint")} className="max-w-xl">
          {(control) => (
            <Select
              value={form.renumber2028 === null ? "" : form.renumber2028 ? "renumber" : "keep"}
              onValueChange={(value) => update({ renumber2028: value === "renumber" })}
            >
              <SelectTrigger {...control}>
                <SelectValue placeholder={t("numbering2028Placeholder")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="renumber">{t("numbering2028Renumber")}</SelectItem>
                <SelectItem value="keep">{t("numbering2028Keep")}</SelectItem>
              </SelectContent>
            </Select>
          )}
        </FormField>
      ) : null}
    </div>
  );
}
