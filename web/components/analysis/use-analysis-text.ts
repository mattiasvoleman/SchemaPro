"use client";

import { useLocale, useTranslations } from "next-intl";
import type { AnalysisNotice, CostCategory } from "@/lib/analysis-types";

/**
 * The words of Analys och planering that all four tabs say: a number, an amount
 * of money and a day in the reader's locale, the name of a category, and a
 * notice in a sentence. Hours are said with a decimal comma in Swedish and a
 * point in English, minutes only where a payroll office wants them.
 */
export function useAnalysisText() {
  const t = useTranslations("analysis");
  const locale = useLocale() === "en" ? "en-GB" : "sv-SE";

  const number = (value: number, digits = 0): string =>
    new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
  /** Kronor, whole: a cost per pupil is read to the krona. */
  const money = (value: number): string =>
    new Intl.NumberFormat(locale, { style: "currency", currency: "SEK", maximumFractionDigits: 0 }).format(value);
  const day = (iso: string): string => {
    const date = new Date(`${iso}T12:00:00`);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });
  };
  const category = (value: CostCategory): string => t(`category.${value}`);
  const notice = (one: AnalysisNotice): string => {
    const params = { ...one.params };
    if (typeof params["category"] === "string") params["category"] = category(params["category"] as CostCategory);
    for (const key of ["from", "to"] as const) if (typeof params[key] === "string") params[key] = day(params[key] as string);
    return t(`notice.${one.code}`, params);
  };

  return { t, locale, number, money, day, category, notice };
}
