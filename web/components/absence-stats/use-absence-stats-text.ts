"use client";

import { useLocale, useTranslations } from "next-intl";

/**
 * The words of Frånvarostatistik that more than one part of it says: a number,
 * a share, minutes, a month and a date in the reader's locale. The web only
 * formats: every figure arrives from the gateway as minutes or a percent with
 * one decimal, and is written with one decimal here ("4,0 %").
 */
export function useAbsenceStatsText() {
  const t = useTranslations("absenceStats");
  const tDays = useTranslations("days");
  const locale = useLocale() === "en" ? "en-GB" : "sv-SE";

  const number = (value: number): string => new Intl.NumberFormat(locale).format(value);

  /** The share without its unit, one decimal: "4,0". */
  const decimal = (value: number): string =>
    new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value);

  /** A share with its unit; a dash where there is none (nothing recorded to divide by), never 0 %. */
  const percent = (value: number | null): string => (value === null ? "—" : t("percent", { percent: decimal(value) }));

  const minutes = (value: number): string => t("minutes", { count: number(value) });

  /** A yyyy-mm-dd date the way the neighbouring pages write one: "5 nov. 2026". */
  const day = (iso: string): string => {
    const date = new Date(`${iso}T12:00:00`);
    return Number.isNaN(date.getTime())
      ? iso
      : date.toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });
  };

  /** The first day of a month as "sep. 2025". */
  const month = (iso: string): string => {
    const date = new Date(`${iso}T12:00:00`);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(locale, { month: "short", year: "numeric" });
  };

  /** The month's name alone, for a cell under a läsår: "sep.". */
  const monthName = (iso: string): string => {
    const date = new Date(`${iso}T12:00:00`);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(locale, { month: "short" });
  };

  /** An ISO weekday 1..7 as its name; anything else as it came. */
  const weekday = (key: string): string => (/^[1-7]$/.test(key) ? tDays(key as "1") : key);

  return { t, number, decimal, percent, minutes, day, month, monthName, weekday };
}
