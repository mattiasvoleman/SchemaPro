"use client";

import { useTranslations } from "next-intl";
import type { RolloverPreview } from "@/lib/types";
import type { RolloverFormState } from "@/lib/year-rollover-form";
import { DateField } from "@/components/ui/date-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="rollover-name">{t("yearName")}</Label>
          <Input
            id="rollover-name"
            value={form.name}
            maxLength={60}
            placeholder={t("yearNamePlaceholder")}
            aria-invalid={form.name.trim() === "" ? true : undefined}
            aria-describedby={form.name.trim() === "" ? "rollover-name-error" : undefined}
            onChange={(event) => update({ name: event.target.value })}
          />
          {form.name.trim() === "" ? (
            <p id="rollover-name-error" className="text-xs text-destructive">
              {t("yearNameRequired")}
            </p>
          ) : null}
        </div>
        <div className="space-y-2">
          <Label htmlFor="rollover-start">{t("startDate")}</Label>
          <DateField
            id="rollover-start"
            label={t("startDate")}
            value={form.startDate}
            onChange={(value) => update({ startDate: value })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="rollover-end">{t("endDate")}</Label>
          <DateField
            id="rollover-end"
            label={t("endDate")}
            value={form.endDate}
            onChange={(value) => update({ endDate: value })}
          />
        </div>
      </div>
      {plan ? (
        <p className="text-sm text-muted-foreground">
          {t("shiftHint", { days: plan.target.dateShiftDays, weeks: plan.target.dateShiftDays / 7 })}
          {plan.target.crossesIsoWeek53 ? ` ${t("week53Hint")}` : ""}
        </p>
      ) : null}

      <div className="max-w-sm space-y-2">
        <Label htmlFor="rollover-grade">{t("graduatingGrade")}</Label>
        <Select
          value={graduatingGrade === null ? "" : String(graduatingGrade)}
          onValueChange={(value) => update({ graduatingGradeLevel: Number(value) })}
        >
          <SelectTrigger id="rollover-grade" aria-describedby="rollover-grade-hint">
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
        <p id="rollover-grade-hint" className="text-xs text-muted-foreground">
          {gradeHint}
        </p>
      </div>
    </div>
  );
}
