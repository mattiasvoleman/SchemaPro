"use client";

import { useFormatter, useTranslations } from "next-intl";
import { periodDatesOf } from "@/lib/period-note";

/**
 * Terminer: the line under a refusal that was counted in one part of the
 * läsår, saying which. Nothing for a refusal that names no period, which is
 * every refusal of a school that dates no post (lib/period-note.ts).
 */
export function PeriodNote({ params }: { params: Record<string, string | number> | null | undefined }) {
  const t = useTranslations("generate");
  const format = useFormatter();
  const dates = periodDatesOf(params);
  if (!dates) return null;
  const day = (value: string) =>
    format.dateTime(new Date(`${value}T00:00:00.000Z`), {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
  return (
    <p className="text-sm text-muted-foreground">
      {t("countedInPeriod", {
        from: day(dates.from),
        to: day(dates.to),
        more: dates.more ? "yes" : "no",
        parity: dates.parity,
      })}
    </p>
  );
}
