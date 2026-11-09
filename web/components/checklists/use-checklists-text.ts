"use client";

import { useMemo } from "react";
import { useLocale, useTranslations } from "next-intl";
import { refusalOf } from "@/lib/checklists";

/**
 * The words of Checklistor that more than one part of it says: a day ("3 okt.
 * 2026"), a moment ("5 nov. 2026 14:32") and a number in the reader's locale, a
 * list of names, and the sentence for a refusal. The formatters are made once
 * per locale.
 *
 * The gateway's days (instructedOn, givenOn) are ISO days in the school's zone
 * and are written as the day they are, whatever zone the browser is in; its
 * instants (recordedAt, voidedAt) are written in the browser's zone, as the bell
 * writes one.
 */
export function useChecklistsText() {
  const t = useTranslations("checklists");
  const tCommon = useTranslations("common");
  const locale = useLocale();

  const formats = useMemo(
    () => ({
      day: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }),
      instantDay: new Intl.DateTimeFormat(locale, { dateStyle: "medium" }),
      moment: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }),
      number: new Intl.NumberFormat(locale),
      list: new Intl.ListFormat(locale, { style: "long", type: "conjunction" }),
    }),
    [locale],
  );

  const safe = (value: string, format: Intl.DateTimeFormat, suffix = ""): string => {
    const date = new Date(`${value}${suffix}`);
    return Number.isNaN(date.getTime()) ? value : format.format(date);
  };

  return {
    t,
    tCommon,
    locale,
    /** An ISO day (yyyy-mm-dd) as the day it is. */
    day: (iso: string): string => safe(iso, formats.day, "T00:00:00Z"),
    /** The day of an instant, in the browser's zone. */
    instantDay: (iso: string): string => safe(iso, formats.instantDay),
    /** A date and a time, in the browser's zone. */
    moment: (iso: string): string => safe(iso, formats.moment),
    number: (value: number): string => formats.number.format(value),
    /** "Ada, Bo och Cy"; with `max`, the names past it are said as a count, by `more`. */
    names: (names: readonly string[], max?: number, more?: (count: number) => string): string =>
      formats.list.format(max !== undefined && more && names.length > max ? [...names.slice(0, max), more(names.length - max)] : [...names]),
    /** The sentence for an error: ours when the gateway sent a code we know, else its own words, else the generic one. */
    refusal: (error: unknown): string => {
      const key = refusalOf(error);
      if (key) return t(`refusal.${key}`);
      return error instanceof Error && error.message ? error.message : tCommon("error");
    },
  };
}
