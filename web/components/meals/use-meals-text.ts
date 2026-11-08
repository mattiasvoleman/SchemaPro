"use client";

import { useLocale, useTranslations } from "next-intl";

/**
 * The words of Måltidskollen that its parts all say: a date, a number and a sitting in the reader's
 * locale. Only counts, times and the names of classes are ever said, never a pupil.
 */
export function useMealsText() {
  const t = useTranslations("meals");
  // 24-hour clock times and dates as the neighbouring pages write them.
  const locale = useLocale() === "en" ? "en-GB" : "sv-SE";

  /** "torsdag 4 februari 2027" for a yyyy-mm-dd date. */
  const long = (iso: string): string => {
    const date = new Date(`${iso}T12:00:00`);
    return Number.isNaN(date.getTime())
      ? iso
      : date.toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  };

  /** "tors 4 feb." for a yyyy-mm-dd date. */
  const short = (iso: string): string => {
    const date = new Date(`${iso}T12:00:00`);
    return Number.isNaN(date.getTime())
      ? iso
      : date.toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short" });
  };

  const number = (value: number): string => new Intl.NumberFormat(locale).format(value);

  return { t, long, short, number };
}
