"use client";

import { useLocale, useTranslations } from "next-intl";
import { lockPeriodDatesOf, periodDatesOf, periodDay } from "@/lib/period-note";

/**
 * Klassens lunch: the line under "locked lessons leave the class no lunch
 * break" when the locks are in different parts of the läsår, saying which and
 * that the meal is one time all year. Nothing for a refusal one period's
 * locks cause alone (lib/period-note.ts).
 */
export function LunchLocksNote({ params }: { params: Record<string, string | number> | null | undefined }) {
  const t = useTranslations("generate");
  const locale = useLocale();
  const dates = lockPeriodDatesOf(params);
  if (!dates) return null;
  return (
    <p className="text-sm">
      {t("lunchLocksInPeriods", {
        from: periodDay(dates.from, locale),
        to: periodDay(dates.to, locale),
        otherFrom: periodDay(dates.otherFrom, locale),
        otherTo: periodDay(dates.otherTo, locale),
        more: dates.more ? "yes" : "no",
      })}
    </p>
  );
}

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
