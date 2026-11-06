"use client";

import { useLocale, useTranslations } from "next-intl";
import { isoWeek } from "@/lib/utils";
import type { ReportingPeriod } from "@/lib/reporting-rate";

/**
 * The words of Rapporteringsgrad that both of its pages say: a date, a number
 * and a period in the reader's locale. Only lessons and shares are ever said,
 * never a reason a register is open.
 */
export function useReportingRateText() {
  const t = useTranslations("reportingRate");
  // 24-hour clock times and dates as the neighbouring pages write them.
  const locale = useLocale() === "en" ? "en-GB" : "sv-SE";

  /** A yyyy-mm-dd date the way the neighbouring pages write one: "5 nov. 2026". */
  const day = (iso: string): string => {
    const date = new Date(`${iso}T12:00:00`);
    return Number.isNaN(date.getTime())
      ? iso
      : date.toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });
  };

  /** A yyyy-mm-dd date without the year, for a lesson in the current term: "tis 3 nov." */
  const weekday = (iso: string): string => {
    const date = new Date(`${iso}T12:00:00`);
    return Number.isNaN(date.getTime())
      ? iso
      : date.toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short" });
  };

  /** An instant as the clock on the wall of the device: "08:15". */
  const time = (instant: string): string =>
    new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(new Date(instant));

  const number = (value: number): string => new Intl.NumberFormat(locale).format(value);

  /** "Vecka 45", "november 2026", "Läsåret 2026/27" for the period around `from`; its dates are said beside it. */
  const periodName = (period: ReportingPeriod, from: string, yearName: string | null): string => {
    if (period === "WEEK") return t("period.weekNumber", { week: isoWeek(new Date(`${from}T12:00:00`)) });
    if (period === "MONTH") {
      return new Date(`${from}T12:00:00`).toLocaleDateString(locale, { month: "long", year: "numeric" });
    }
    return t("period.yearName", { name: yearName ?? "" });
  };

  return { t, day, weekday, time, number, periodName };
}
