"use client";

import { useId } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { shortDay, type YearWeek } from "@/lib/placement-weeks";

/*
 * Vecka: one week of the läsår at a time (D2). "Alla veckor" is the week as it has always been drawn, every lesson with a mark
 * for the weeks it runs; a week picked shows only the lessons that run THAT week, under its dates, with its week number and
 * whether it is an odd (A) or an even (B) week, grouped by term. The picker only chooses: which cards a week holds is
 * lib/placement-weeks.ts runsInWeek, and what is shown is the page's.
 *
 * A native select, as the pages under a tight budget use (components/ui/native-select.tsx), with two buttons for the
 * neighbours so that the keyboard steps through the year without opening a list.
 */

export interface WeekPickerProps {
  weeks: readonly YearWeek[];
  /** The Monday of the week shown; null for all weeks. */
  value: string | null;
  onChange: (monday: string | null) => void;
}

export function WeekPicker({ weeks, value, onChange }: WeekPickerProps) {
  const t = useTranslations("placementWeek.weeks");
  const locale = useLocale();
  const id = useId();
  const at = value === null ? -1 : weeks.findIndex((week) => week.monday === value);
  const picked = at === -1 ? null : weeks[at]!;
  const parityText = (week: YearWeek) => t(week.parity === "ODD_WEEKS" ? "odd" : "even");
  const option = (week: YearWeek) => (
    <option key={week.monday} value={week.monday}>
      {t("option", { week: week.week, from: shortDay(week.monday, locale), to: shortDay(week.friday, locale), parity: parityText(week) })}
    </option>
  );
  const step = (by: -1 | 1) => {
    // From "all weeks" the arrows go to the first week and the last: there is no week before or after "all".
    const next = at === -1 ? (by === 1 ? weeks[0] : weeks.at(-1)) : weeks[at + by];
    if (next) onChange(next.monday);
  };
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-labelledby={`${id}-label`} data-testid="week-picker">
      <Label htmlFor={`${id}-select`} id={`${id}-label`} className="text-sm">
        {t("label")}
      </Label>
      <Button type="button" variant="outline" size="icon" aria-label={t("prev")} disabled={at <= 0 && at !== -1} onClick={() => step(-1)} className="size-9">
        <ChevronLeft className="size-4" aria-hidden />
      </Button>
      <NativeSelect id={`${id}-select`} value={value ?? ""} onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)} className="w-auto min-w-44 max-w-full">
        <option value="">{t("all")}</option>
        <optgroup label={t("ht")}>{weeks.filter((week) => week.term === "HT").map(option)}</optgroup>
        <optgroup label={t("vt")}>{weeks.filter((week) => week.term === "VT").map(option)}</optgroup>
      </NativeSelect>
      <Button type="button" variant="outline" size="icon" aria-label={t("next")} disabled={at === weeks.length - 1} onClick={() => step(1)} className="size-9">
        <ChevronRight className="size-4" aria-hidden />
      </Button>
      <p role="status" aria-live="polite" className="w-full text-sm text-muted-foreground [overflow-wrap:anywhere]" data-testid="week-picker-status">
        {picked
          ? t("shown", { week: picked.week, from: shortDay(picked.monday, locale), to: shortDay(picked.friday, locale), parity: parityText(picked) })
          : t("shownAll")}
        {" "}
        {t("hint")}
      </p>
    </div>
  );
}
