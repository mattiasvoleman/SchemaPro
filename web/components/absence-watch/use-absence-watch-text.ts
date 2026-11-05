"use client";

import { useLocale, useTranslations } from "next-intl";
import type { LimitShape } from "@/lib/absence-watch";

/**
 * The words of Frånvarobevakning that more than one part of it says: a limit
 * in a sentence ("10 % ogiltig frånvaro av de registrerade minuterna över 14
 * dagar", "5 skoldagar i följd med all frånvaro"), a date and a number in the
 * reader's locale. Only figures and the school's own kinds of absence (giltig,
 * ogiltig, all) are ever said: no reason, no type of absence.
 */
export function useAbsenceWatchText() {
  const t = useTranslations("absenceWatch");
  const locale = useLocale();

  /** A yyyy-mm-dd date the way the neighbouring pages write one: "5 nov. 2026". */
  const day = (iso: string): string => {
    const date = new Date(`${iso}T12:00:00`);
    return Number.isNaN(date.getTime())
      ? iso
      : date.toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });
  };

  const number = (value: number): string => new Intl.NumberFormat(locale).format(value);

  const limitText = (limit: LimitShape): string => {
    const basis = t(`basis.${limit.basis}`);
    return limit.kind === "SHARE"
      ? t("limit.SHARE", { percent: limit.percent ?? 0, days: limit.windowDays ?? 0, basis })
      : t("limit.CONSECUTIVE", { days: limit.consecutiveDays ?? 0, basis });
  };

  return { t, day, number, limitText };
}
