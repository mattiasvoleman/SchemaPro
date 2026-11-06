"use client";

import { useMemo } from "react";
import { useLocale, useTranslations } from "next-intl";

/**
 * The words of Kvittens that more than one part of it says: a moment ("5 nov.
 * 2026 14:32") and a number in the reader's locale, and a list of names ("Ada,
 * Bo och Cy"). The formatters are made once per locale, since a request of a
 * whole school is a few thousand moments.
 */
export function useAckText() {
  const t = useTranslations("acknowledgements");
  const locale = useLocale();

  const formats = useMemo(
    () => ({
      moment: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }),
      day: new Intl.DateTimeFormat(locale, { dateStyle: "medium" }),
      number: new Intl.NumberFormat(locale),
      list: new Intl.ListFormat(locale, { style: "long", type: "conjunction" }),
    }),
    [locale],
  );

  const safe = (iso: string, format: Intl.DateTimeFormat): string => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : format.format(date);
  };

  return {
    t,
    /** A date and a time, in the browser's time zone as the bell writes one. */
    moment: (iso: string): string => safe(iso, formats.moment),
    day: (iso: string): string => safe(iso, formats.day),
    number: (value: number): string => formats.number.format(value),
    /** "Ada, Bo och Cy"; with `max`, the names past it are said as a count, by `more`. */
    names: (names: readonly string[], max?: number, more?: (count: number) => string): string =>
      formats.list.format(
        max !== undefined && more && names.length > max ? [...names.slice(0, max), more(names.length - max)] : [...names],
      ),
  };
}
