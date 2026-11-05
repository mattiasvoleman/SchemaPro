"use client";

import { useMemo } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { MessageLookup } from "@/lib/engine-message";
import { errorCode, publicationErrorText } from "@/lib/publication-messages";
import type { Person } from "@/lib/types";

/**
 * How the page writes days and times. A day is a calendar day (yyyy-mm-dd),
 * read at UTC midnight so that no time zone moves it to the day before; a
 * lesson's start and end are instants, written in the reader's clock.
 */
export function useFormats() {
  const locale = useLocale();
  return useMemo(() => {
    const day = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
    const clock = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    const dayOf = (date: string) => new Date(`${date}T00:00:00.000Z`);
    return {
      dayText: (date: string) => day.format(dayOf(date)),
      timeText: (iso: string) => clock.format(new Date(iso)),
      periodText: (from: string, to: string) =>
        from === to ? day.format(dayOf(from)) : day.formatRange(dayOf(from), dayOf(to)),
    };
  }, [locale]);
}

export const personName = (person: Pick<Person, "firstName" | "lastName">): string =>
  `${person.firstName} ${person.lastName}`;

/**
 * The words for a refusal: the activity's own where the page has them
 * (scheduleActivities.errors), the avbokning's otherwise (publishing.errors),
 * and the gateway's own sentence where neither does (lib/engine-message.ts).
 */
export function useErrorText(): (error: unknown) => string {
  const own = useTranslations("scheduleActivities.errors") as unknown as MessageLookup;
  const shared = useTranslations("publishing.errors") as unknown as MessageLookup;
  const fallback = useTranslations("common")("error");
  return (error) => {
    const code = errorCode(error);
    return publicationErrorText(code !== undefined && own.has(code) ? own : shared, error, fallback);
  };
}
