"use client";

import { useLocale, useTranslations } from "next-intl";
import { periodDatesOf, periodDay } from "@/lib/period-note";

/**
 * Terminer: the line under a refusal that was counted in one part of the
 * läsår, saying which. Nothing for a refusal that names no period, which is
 * every refusal of a school that dates no post (lib/period-note.ts).
 */
export function PeriodNote({ params }: { params: Record<string, string | number> | null | undefined }) {
  const t = useTranslations("generate");
  const locale = useLocale();
  const dates = periodDatesOf(params);
  if (!dates) return null;
  return (
    <p className="text-sm text-muted-foreground">
      {t("countedInPeriod", {
        from: periodDay(dates.from, locale),
        to: periodDay(dates.to, locale),
        more: dates.more ? "yes" : "no",
        parity: dates.parity,
      })}
    </p>
  );
}
