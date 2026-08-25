"use client";

import { useTranslations } from "next-intl";
import type { LessonRecurrence } from "@/lib/types";
import { Input } from "@/components/ui/input";
import { DateField } from "@/components/ui/date-field";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface RecurrenceValue {
  recurrence: LessonRecurrence;
  /** YYYY-MM-DD, or "" for the academic year's own boundary. */
  startDate: string;
  endDate: string;
}

/**
 * Which weeks a lesson runs: every week, odd, or even ISO weeks, plus an
 * optional period for a subject read for only part of the year.
 *
 * Shared by the create and edit dialogs so the two cannot drift — an admin who
 * sets "udda veckor" while creating and then reopens the lesson must find the
 * same control saying the same thing.
 */
export function RecurrenceFields({
  value,
  onChange,
  idPrefix,
}: {
  value: RecurrenceValue;
  onChange: (next: RecurrenceValue) => void;
  idPrefix: string;
}) {
  const t = useTranslations("timetable");

  return (
    <div className="col-span-2 space-y-3 rounded-md border p-3">
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-recurrence`}>{t("recurrenceLabel")}</Label>
        <Select
          value={value.recurrence}
          onValueChange={(next) =>
            onChange({ ...value, recurrence: next as LessonRecurrence })
          }
        >
          <SelectTrigger id={`${idPrefix}-recurrence`} aria-label={t("recurrenceLabel")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL_WEEKS">{t("recurrenceAll")}</SelectItem>
            <SelectItem value="ODD_WEEKS">{t("recurrenceOdd")}</SelectItem>
            <SelectItem value="EVEN_WEEKS">{t("recurrenceEven")}</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{t("recurrenceHint")}</p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-start-date`}>{t("periodFrom")}</Label>
          <DateField
            label={t("periodFrom")}
            id={`${idPrefix}-start-date`}
            value={value.startDate}
            onChange={(date) => onChange({ ...value, startDate: date })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-end-date`}>{t("periodTo")}</Label>
          <DateField
            label={t("periodTo")}
            id={`${idPrefix}-end-date`}
            value={value.endDate}
            onChange={(date) => onChange({ ...value, endDate: date })}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t("periodHint")}</p>
    </div>
  );
}

/** A short label for the grid: "udda", "jämna", "period". */
export function recurrenceBadge(
  lesson: {
    recurrence: LessonRecurrence;
    startDate: string | null;
    endDate: string | null;
  },
  t: (key: string) => string,
): string | null {
  const parts: string[] = [];
  if (lesson.recurrence === "ODD_WEEKS") parts.push(t("badgeOdd"));
  if (lesson.recurrence === "EVEN_WEEKS") parts.push(t("badgeEven"));
  // A period is worth flagging even without a parity: a lesson that stops in
  // October looks identical to a year-long one on a weekly grid.
  if (lesson.startDate || lesson.endDate) parts.push(t("badgePeriod"));
  return parts.length > 0 ? parts.join(" · ") : null;
}
