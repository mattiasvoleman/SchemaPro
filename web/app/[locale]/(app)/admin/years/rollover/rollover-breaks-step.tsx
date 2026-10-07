"use client";

import { useTranslations } from "next-intl";
import type { RolloverPreview } from "@/lib/types";
import type { RolloverFormState } from "@/lib/year-rollover-form";
import { DateField } from "@/components/ui/date-field";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Steg 3, Lov: which of this year's lov and studiedagar the new year starts
 * with, and on which dates.
 *
 * NOTHING IS TICKED. A lov follows the school's own decision, and next
 * year's is often not taken yet in spring; a lov carried on a guess becomes
 * hours the timplan check subtracts and lessons the calendar leaves out. So
 * the admin ticks what is decided, and the dates come proposed: jullov moves
 * by whole weeks, påsklov with Easter, everything else keeps its week number
 * (höstlov v44 stays v44, even across 2026's week 53). A lov whose week does
 * not exist next year has no proposal and needs its dates typed. Every
 * proposed date can be changed.
 */
export function RolloverBreaksStep({
  form,
  update,
  plan,
}: {
  form: RolloverFormState;
  update: (patch: Partial<RolloverFormState>) => void;
  plan: RolloverPreview | undefined;
}) {
  const t = useTranslations("years");
  if (!plan) return <Skeleton className="h-32 w-full" />;
  if (plan.breaks.length === 0) return <p className="text-sm text-muted-foreground">{t("noBreaks")}</p>;

  const toggle = (id: string, selected: boolean) => {
    const next = { ...form.breaks };
    if (selected) next[id] = {};
    else delete next[id];
    update({ breaks: next });
  };
  const setDate = (id: string, field: "startDate" | "endDate", value: string) => {
    update({ breaks: { ...form.breaks, [id]: { ...form.breaks[id], [field]: value } } });
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("breaksHint")}</p>
      <ul className="divide-y rounded-md border">
        {plan.breaks.map((lov) => {
          const choice = form.breaks[lov.sourceBreakId];
          const selected = choice !== undefined;
          const checkboxId = `rollover-break-${lov.sourceBreakId}`;
          return (
            <li key={lov.sourceBreakId} className="space-y-2 p-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <input
                  id={checkboxId}
                  type="checkbox"
                  className="h-4 w-4 accent-primary"
                  checked={selected}
                  onChange={(event) => toggle(lov.sourceBreakId, event.target.checked)}
                />
                <label htmlFor={checkboxId} className="font-medium">
                  {lov.name}
                </label>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {t("breakThisYear", { start: lov.startDate, end: lov.endDate })}
                </span>
                <span className="text-xs text-muted-foreground">
                  {lov.proposedStart && lov.proposedEnd
                    ? t(`anchor.${lov.anchor}`, { start: lov.proposedStart, end: lov.proposedEnd })
                    : t("anchor.NONE")}
                </span>
              </div>
              {selected ? (
                <div className="grid max-w-md gap-3 pl-7 sm:grid-cols-2">
                  <DateField
                    label={t("breakStartFor", { name: lov.name })}
                    aria-label={t("breakStartFor", { name: lov.name })}
                    value={choice.startDate ?? lov.proposedStart ?? ""}
                    onChange={(value) => setDate(lov.sourceBreakId, "startDate", value)}
                  />
                  <DateField
                    label={t("breakEndFor", { name: lov.name })}
                    aria-label={t("breakEndFor", { name: lov.name })}
                    value={choice.endDate ?? lov.proposedEnd ?? ""}
                    onChange={(value) => setDate(lov.sourceBreakId, "endDate", value)}
                  />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
