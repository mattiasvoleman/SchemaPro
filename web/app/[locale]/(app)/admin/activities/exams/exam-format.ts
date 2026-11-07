"use client";

import { useMemo } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ApiError } from "@/lib/api";
import { engineMessage, type MessageLookup } from "@/lib/engine-message";

/**
 * How the page writes days. A day is a calendar day (yyyy-mm-dd), read at UTC
 * midnight so that no time zone moves it to the day before. A time of day
 * arrives from the gateway as HH:MM, in the school's clock, and is shown as it
 * is: twenty-four hours, never a locale's am and pm.
 */
export function useFormats() {
  const locale = useLocale();
  return useMemo(() => {
    const day = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
    const short = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
    const dayOf = (date: string) => new Date(`${date}T00:00:00.000Z`);
    return {
      dayText: (date: string) => day.format(dayOf(date)),
      periodText: (from: string, to: string) => (from === to ? short.format(dayOf(from)) : short.formatRange(dayOf(from), dayOf(to))),
    };
  }, [locale]);
}

/**
 * The words for a refusal: the gateway's own Swedish sentence (every exam
 * refusal carries one), except where the code is one of the engine's: the
 * planner can refuse a whole run (EXAM_MODEL_TOO_LARGE, a 400 with the figures
 * in params), and that sentence is written in engineMessages like the reasons,
 * so the English `message` the engine sent is never what a school reads.
 * The throttle's answer is a transport's, so the sentence for it is ours.
 */
export function useErrorText(): (error: unknown) => string {
  const t = useTranslations("exams");
  const engine = useTranslations("engineMessages") as unknown as MessageLookup;
  const fallback = useTranslations("common")("error");
  return (error) => {
    if (error instanceof ApiError) {
      if (error.status === 429) return t("errors.throttled");
      if (error.code !== undefined && engine.has(error.code)) {
        return engineMessage(engine, { code: error.code, message: error.message, params: error.params ?? null });
      }
      return error.message;
    }
    return error instanceof Error ? error.message : fallback;
  };
}

/**
 * The sentence for a reason an exam was not laid: the engine's codes are
 * written in engineMessages (the parity test with the engine's catalogue
 * keeps them), the gateway's own in exams.reasons. A code neither has, or a
 * param its sentence needs and the run did not send, shows the engine's
 * English when the run carried it (lib/engine-message.ts), else a general line.
 *
 * A reason about a class carries the class's NAME in params.class. The engine's
 * sentence does not use it (the Swedish may only take the values the English
 * does), so it is said after the sentence.
 */
export function useReasonText(): (code: string, params: Record<string, string | number>, english?: string | null) => string {
  const own = useTranslations("exams.reasons") as unknown as MessageLookup;
  const engine = useTranslations("engineMessages") as unknown as MessageLookup;
  const t = useTranslations("exams");
  return (code, params, english) => {
    const sentence = engineMessage(own.has(code) ? own : engine, { code, message: english ?? t("reasonUnknown"), params });
    const named = typeof params.class === "string" && params.class !== "" ? ` ${t("reasonClass", { class: params.class })}` : "";
    return `${sentence}${named}`;
  };
}
